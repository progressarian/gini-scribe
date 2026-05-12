import { Router } from "express";
import { createRequire } from "module";
import pool from "../config/db.js";
import { handleError } from "../utils/errorHandler.js";
import { validate } from "../middleware/validate.js";
import {
  messageCreateSchema,
  conversationMessageSchema,
  conversationAttachmentSchema,
  ensureConversationSchema,
} from "../schemas/index.js";

const require = createRequire(import.meta.url);
let genie = null;
try {
  genie = require("../genie-sync.cjs");
} catch {
  console.log("genie-sync.cjs not loaded — message sync disabled");
}

const router = Router();

// ─── helpers ───────────────────────────────────────────────────────────────

// Back-fill `side_effect_id` on side_effect_log bubbles whose insert dropped
// the column (genie Supabase missing the 2026-05-12_patient_messages_side_effect_id
// migration — see myhealthgenie/supabase/migrations/). Without it, the
// reception inbox can't render the in-bubble "Mark resolved" action because
// SideEffectResolveAction renders only when m.side_effect_id is set. We parse
// the "Symptom:" line out of the message body and resolve it against
// patient_reported_side_effects on the scribe DB. Best-effort — failures
// leave the row untouched and the message still renders normally.
async function hydrateSideEffectIds(conv, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return;
  const needs = rows.filter(
    (m) => m && m.message_type === "side_effect_log" && !m.side_effect_id && m.message,
  );
  if (needs.length === 0) return;
  const scribePatientId = await resolveScribePatientIdFromGenieUuid(conv?.patient_id);
  if (scribePatientId == null) return;
  const nameByRow = new Map();
  const names = new Set();
  for (const r of needs) {
    const m = String(r.message || "").match(/Symptom:\s*([^\n]+)/i);
    const name = m ? m[1].trim() : "";
    if (!name) continue;
    nameByRow.set(r, name.toLowerCase());
    names.add(name.toLowerCase());
  }
  if (names.size === 0) return;
  try {
    const { rows: seRows } = await pool.query(
      `SELECT id, lower(name) AS lname, reported_at
         FROM patient_reported_side_effects
        WHERE patient_id = $1 AND lower(name) = ANY($2::text[])
        ORDER BY reported_at DESC`,
      [scribePatientId, Array.from(names)],
    );
    const byName = new Map();
    for (const r of seRows) {
      if (!byName.has(r.lname)) byName.set(r.lname, r.id);
    }
    for (const row of needs) {
      const lname = nameByRow.get(row);
      const id = lname ? byName.get(lname) : null;
      if (id) row.side_effect_id = id;
    }
  } catch (e) {
    console.warn("[hydrateSideEffectIds]", e?.message || e);
  }
}

// Load a conversation and run the standard viewer-authorization check:
//   - doctor conversations: the caller must be the participant doctor
//   - lab / reception: any authenticated scribe user may view (team inboxes)
// Returns { conv, error } — error is { status, message } when denied/missing.
async function loadAuthorizedConversation(req, conversationId) {
  if (!genie?.getConversationById) {
    return { error: { status: 503, message: "Messaging not configured" } };
  }
  const conv = await genie.getConversationById(conversationId);
  if (!conv) return { error: { status: 404, message: "Conversation not found" } };

  if (conv.kind === "doctor") {
    const callerId = req.doctor?.doctor_id != null ? String(req.doctor.doctor_id) : null;
    if (!callerId || callerId !== String(conv.doctor_id)) {
      return { error: { status: 403, message: "Not a participant of this conversation" } };
    }
  }
  // Lab/reception: any scribe doctor can view.
  return { conv };
}

// Look up the scribe-side patient.id for a given Supabase (Genie) patient UUID.
// The linkage lives on the Supabase patients table via `gini_patient_id`
// (which stores the scribe INT id). Reverse-maps UUID → scribe INT id.
//
// Tolerates being called with a scribe int directly: if the input doesn't
// look like a UUID we treat it as already-scribe-int and short-circuit so a
// stray scribe id from the UI doesn't 22P02 against the UUID column.
const UUID_RX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
async function resolveScribePatientIdFromGenieUuid(genieUuid) {
  if (genieUuid == null || genieUuid === "") return null;
  const s = String(genieUuid).trim();
  if (!UUID_RX.test(s)) {
    const id = parseInt(s, 10);
    return Number.isFinite(id) ? id : null;
  }
  if (!genie?.getGenieDb) return null;
  const db = typeof genie.getGenieDb === "function" ? genie.getGenieDb() : null;
  if (!db) return null;
  try {
    const { data, error } = await db
      .from("patients")
      .select("gini_patient_id")
      .eq("id", s)
      .maybeSingle();
    if (error || !data) return null;
    const id = parseInt(data.gini_patient_id, 10);
    return Number.isFinite(id) ? id : null;
  } catch {
    return null;
  }
}

// ═════════════════════════════════════════════════════════════════════════
// NEW conversation-centric routes
// ═════════════════════════════════════════════════════════════════════════

/**
 * List conversations visible to the current caller.
 * ?kind=doctor — conversations where the caller's doctor_id is the participant
 * ?kind=lab | reception — shared team inboxes
 */
router.get("/conversations", async (req, res) => {
  try {
    if (!genie?.listConversationsForDoctor) {
      return res.json({ data: [] });
    }
    const kind = String(req.query.kind || "").toLowerCase();
    if (!["doctor", "lab", "reception"].includes(kind)) {
      return res.status(400).json({ error: "kind must be doctor|lab|reception" });
    }

    let rows = [];
    if (kind === "doctor") {
      const doctorId = req.doctor?.doctor_id;
      if (!doctorId) return res.status(401).json({ error: "Auth required" });
      rows = await genie.listConversationsForDoctor(String(doctorId));
    } else {
      rows = await genie.listConversationsForTeam(kind);
    }
    res.json({ data: rows });
  } catch (e) {
    handleError(res, e, "Conversations list");
  }
});

/**
 * Paginated messages in a single conversation.
 */
router.get("/conversations/:id/messages", async (req, res) => {
  try {
    const { conv, error } = await loadAuthorizedConversation(req, req.params.id);
    if (error) return res.status(error.status).json({ error: error.message });

    const limitRaw = req.query.limit ? parseInt(req.query.limit, 10) : null;
    const limit = limitRaw && limitRaw > 0 ? Math.min(limitRaw, 200) : 30;
    const before = req.query.before || null;
    const result = await genie.getConversationMessages(conv.id, { limit, before });
    await hydrateSideEffectIds(conv, result?.data);
    res.json(result);
  } catch (e) {
    handleError(res, e, "Conversation messages");
  }
});

/**
 * Send a reply into a conversation. Server derives senderName from the
 * authenticated doctor and senderRole from the conversation kind.
 */
router.post(
  "/conversations/:id/messages",
  validate(conversationMessageSchema),
  async (req, res) => {
    try {
      const { conv, error } = await loadAuthorizedConversation(req, req.params.id);
      if (error) return res.status(error.status).json({ error: error.message });

      const senderName =
        req.doctor?.doctor_name ||
        req.doctor?.short_name ||
        (conv.kind === "lab"
          ? "Gini Lab"
          : conv.kind === "reception"
            ? "Gini Reception"
            : "Doctor");

      // Attachments are scoped to lab/reception by product decision.
      // Doctor chat stays text-only — reject attachment payloads here
      // even though the schema accepts them generically.
      if (req.body.attachment_path && conv.kind === "doctor") {
        return res.status(400).json({ error: "Attachments are not allowed in doctor chat" });
      }

      const row = await genie.sendMessageToConversation({
        conversationId: conv.id,
        message: req.body.message,
        senderName,
        senderRole: conv.kind,
        direction: "inbound",
        attachmentPath: req.body.attachment_path || null,
        attachmentMime: req.body.attachment_mime || null,
        attachmentName: req.body.attachment_name || null,
      });
      if (!row) return res.status(500).json({ error: "Failed to send message" });
      res.json(row);
    } catch (e) {
      handleError(res, e, "Send conversation message");
    }
  },
);

/**
 * Upload a chat attachment (image or PDF). Returns the storage path that
 * should then be passed to POST /conversations/:id/messages.
 * Scoped to lab/reception conversations only.
 */
router.post(
  "/conversations/:id/attachments",
  validate(conversationAttachmentSchema),
  async (req, res) => {
    try {
      const { conv, error } = await loadAuthorizedConversation(req, req.params.id);
      if (error) return res.status(error.status).json({ error: error.message });
      if (!["lab", "reception"].includes(conv.kind)) {
        return res
          .status(400)
          .json({ error: "Attachments are only supported in lab/reception chats" });
      }
      if (!genie?.uploadChatAttachment) {
        return res.status(503).json({ error: "Storage not configured" });
      }

      const result = await genie.uploadChatAttachment({
        patientId: conv.patient_id,
        conversationId: conv.id,
        base64: req.body.base64,
        mediaType: req.body.mediaType,
        fileName: req.body.fileName,
      });
      if (result?.error) return res.status(400).json({ error: result.error });

      res.json({
        attachment_path: result.path,
        attachment_mime: result.mime,
        attachment_name: result.name,
      });
    } catch (e) {
      handleError(res, e, "Upload chat attachment");
    }
  },
);

/**
 * Issue a short-lived signed URL for a chat attachment so the scribe UI
 * can render images / open PDFs without exposing the bucket publicly.
 */
router.get("/conversations/:id/messages/:messageId/attachment-url", async (req, res) => {
  try {
    const { conv, error } = await loadAuthorizedConversation(req, req.params.id);
    if (error) return res.status(error.status).json({ error: error.message });
    if (!genie?.dbForConversation || !genie?.signChatAttachmentUrl) {
      return res.status(503).json({ error: "Storage not configured" });
    }
    // Route the message lookup to the same DB the conversation lives in
    // (Genie or Gini). Without this, lookups for Gini-DB messages would
    // miss because the previous code hardcoded the Genie client.
    const db = genie.dbForConversation(conv);
    if (!db) return res.status(503).json({ error: "Storage not configured" });
    const { data, error: rowErr } = await db
      .from("patient_messages")
      .select("attachment_path, conversation_id")
      .eq("id", req.params.messageId)
      .maybeSingle();
    if (rowErr || !data) return res.status(404).json({ error: "Message not found" });
    if (data.conversation_id !== conv.id) {
      return res.status(403).json({ error: "Message does not belong to this conversation" });
    }
    if (!data.attachment_path) {
      return res.status(404).json({ error: "Message has no attachment" });
    }

    const url = await genie.signChatAttachmentUrl(data.attachment_path, 300);
    if (!url) return res.status(500).json({ error: "Failed to sign URL" });
    res.json({ url, expires_in: 300 });
  } catch (e) {
    handleError(res, e, "Chat attachment URL");
  }
});

/**
 * Mark the team side of a conversation as read (all outbound patient→team
 * messages flip to is_read=true, team_unread_count resets).
 */
router.post("/conversations/:id/read", async (req, res) => {
  try {
    const { conv, error } = await loadAuthorizedConversation(req, req.params.id);
    if (error) return res.status(error.status).json({ error: error.message });
    const ok = await genie.markConversationRead({ conversationId: conv.id, side: "team" });
    res.json({ success: ok });
  } catch (e) {
    handleError(res, e, "Mark conversation read");
  }
});

/**
 * Search patients in the Genie/Supabase patients table so the scribe UI can
 * start a new chat with a specific patient. Returns id, name, phone.
 */
router.get("/genie-patients/search", async (req, res) => {
  try {
    if (!genie?.searchGeniePatients) return res.json({ data: [] });
    const q = (req.query.q || "").toString();
    const limitRaw = req.query.limit ? parseInt(req.query.limit, 10) : 20;
    const limit = Math.min(Math.max(limitRaw || 20, 1), 50);
    const rows = await genie.searchGeniePatients(q, { limit });
    res.json({ data: rows });
  } catch (e) {
    handleError(res, e, "Patient search");
  }
});

// If the caller passed a scribe-int id for a patient that has no genie row
// yet (non-gini patient — scribe-only history, never synced to Supabase),
// look the patient up in scribe Postgres and push a minimal profile to
// genie via gini_link_patient. After this, resolveAnyToGenieUuid in
// genie-sync.cjs returns a UUID and chat ensure / message routes work the
// same as for gini patients. No-op for callers passing a UUID.
async function ensureGenieLinkForScribePatient(rawId) {
  if (rawId == null || rawId === "") return;
  const s = String(rawId).trim();
  if (UUID_RX.test(s)) return; // already a genie UUID, nothing to do
  if (!genie?.syncPatientToGenie) return;

  // Resolve to a scribe `patients` row. The slug may be either:
  //   - a scribe int id (e.g. "16709") — happy path, look up by id
  //   - a gini_patient_id / file_no string (e.g. "TEST_COMPANION_USER")
  //     used by the patient app's resolveChatPatientId, which doesn't
  //     know the scribe int. Look up by file_no in that case.
  let patient = null;
  const asInt = parseInt(s, 10);
  if (Number.isFinite(asInt) && String(asInt) === s) {
    const { rows } = await pool.query(
      "SELECT id, name, phone, mobile, dob, sex, gender, blood_group, uhid, file_no FROM patients WHERE id = $1",
      [asInt],
    );
    patient = rows[0] || null;
  } else {
    const { rows } = await pool.query(
      "SELECT id, name, phone, mobile, dob, sex, gender, blood_group, uhid, file_no FROM patients WHERE file_no = $1 LIMIT 1",
      [s],
    );
    patient = rows[0] || null;
  }
  if (!patient) return;

  // Fast path: skip if the link already exists.
  const existing = await genie.resolveGeniePatientId?.(patient.id);
  if (existing) return;

  await genie
    .syncPatientToGenie(patient)
    .catch((e) =>
      console.warn(`[ensureGenieLink] syncPatientToGenie failed for ${patient.id}: ${e.message}`),
    );
}

/**
 * Ensure (find-or-create) a conversation for a patient. Idempotent.
 *
 * Auto-links non-gini patients to genie on first call so reception/lab
 * chat works for every patient — not just those already on the Genie app.
 */
router.post(
  "/patients/:id/conversations/ensure",
  validate(ensureConversationSchema),
  async (req, res) => {
    try {
      if (!genie?.ensureConversation) {
        return res.status(503).json({ error: "Messaging not configured" });
      }
      const { kind, doctor_id, doctor_name } = req.body;
      if (kind === "doctor" && !doctor_id) {
        return res.status(400).json({ error: "doctor_id required for kind=doctor" });
      }
      await ensureGenieLinkForScribePatient(req.params.id);
      const conv = await genie.ensureConversation({
        patientId: req.params.id,
        kind,
        doctorId: kind === "doctor" ? String(doctor_id) : null,
        doctorName: doctor_name || null,
      });
      if (!conv) return res.status(500).json({ error: "Failed to ensure conversation" });
      res.json(conv);
    } catch (e) {
      handleError(res, e, "Ensure conversation");
    }
  },
);

/**
 * Patient-app entry point: returns the care-team conversation list for a
 * patient. Always includes lab + reception. Adds one doctor conversation
 * per distinct doctor the patient has had a recorded consultation with
 * (scribe Postgres `consultations` table is the source of truth). The
 * server upserts all conversations before returning, so the patient app
 * always receives stable conversation_ids to bind its tabs to.
 *
 * Route is PUBLIC by design — the patient app has no scribe JWT. The
 * patient_id already scopes the response; there's no cross-patient leak.
 */
router.get("/patients/:id/care-team", async (req, res) => {
  try {
    if (!genie?.ensureConversation) {
      return res.json({ data: [] });
    }
    const patientId = req.params.id;
    await ensureGenieLinkForScribePatient(patientId);

    // Always ensure the shared team conversations exist.
    const [lab, reception] = await Promise.all([
      genie.ensureConversation({ patientId, kind: "lab" }),
      genie.ensureConversation({ patientId, kind: "reception" }),
    ]);

    // Doctor conversations: only the doctors the patient has actually seen.
    // Cross into scribe's Postgres to find distinct mo_doctor_ids.
    let doctorRows = [];
    try {
      const scribePid = await resolveScribePatientIdFromGenieUuid(patientId);
      if (scribePid != null) {
        const q = await pool.query(
          `SELECT DISTINCT d.id, d.name, d.short_name
             FROM consultations c
             JOIN doctors d ON d.id = c.mo_doctor_id
            WHERE c.patient_id = $1
              AND c.mo_doctor_id IS NOT NULL
            ORDER BY d.name`,
          [scribePid],
        );
        doctorRows = q.rows || [];
      }
    } catch (e) {
      console.warn("[care-team] scribe consult lookup failed:", e.message);
    }

    const doctorConvs = [];
    for (const d of doctorRows) {
      const conv = await genie.ensureConversation({
        patientId,
        kind: "doctor",
        doctorId: String(d.id),
        doctorName: d.name,
      });
      if (conv) doctorConvs.push(conv);
    }

    // Preserve a consistent order: doctors first (alpha), then reception, then lab.
    const data = [...doctorConvs, reception, lab].filter(Boolean);
    res.json({ data });
  } catch (e) {
    handleError(res, e, "Care team");
  }
});

/**
 * Patient-app appointments list. Public by design (mirrors /care-team) —
 * the patient app has no scribe JWT, and the patient_id in the URL
 * scopes the response so there's no cross-patient leak. Returns past +
 * upcoming appointments straight from scribe `appointments`, which is
 * the source of truth (the gini→supabase mirror can lag).
 *
 * Optional ?from=YYYY-MM-DD&to=YYYY-MM-DD windows the query (defaults
 * to ±90 days from today). Status='cancelled' rows are still returned —
 * the patient app filters them client-side so it can show e.g. "your
 * last visit was cancelled" if needed.
 */
router.get("/patients/:id/appointments", async (req, res) => {
  try {
    const scribePid = await resolveScribePatientIdFromGenieUuid(req.params.id);
    if (scribePid == null) return res.json({ data: [] });

    const today = new Date();
    const from = String(req.query.from || "").match(/^\d{4}-\d{2}-\d{2}$/)
      ? req.query.from
      : new Date(today.getFullYear(), today.getMonth(), today.getDate() - 90)
          .toISOString()
          .slice(0, 10);
    const to = String(req.query.to || "").match(/^\d{4}-\d{2}-\d{2}$/)
      ? req.query.to
      : new Date(today.getFullYear(), today.getMonth(), today.getDate() + 90)
          .toISOString()
          .slice(0, 10);

    // Front-desk-booked OPD rows often have only `file_no` set (no
    // patient_id) — scribe's own OPD list joins on either column, so we
    // mirror that here. Without this match, freshly-booked OPD slots
    // never reach the patient app's pre-visit pill / Visits tab.
    const fileNoR = await pool.query(`SELECT file_no FROM patients WHERE id = $1`, [scribePid]);
    const fileNo = fileNoR.rows[0]?.file_no || null;

    const { rows } = await pool.query(
      `SELECT id, patient_id, patient_name, file_no, doctor_name,
              appointment_date, time_slot, visit_type, status, notes,
              location, healthray_id, created_at,
              pre_visit_symptoms, pre_visit_notes, pre_visit_symptoms_at,
              pre_visit_compliance, pre_visit_compliance_at
         FROM appointments
        WHERE (patient_id = $1
               OR ($2::text IS NOT NULL AND file_no = $2))
          AND appointment_date BETWEEN $3 AND $4
        ORDER BY appointment_date DESC, time_slot DESC NULLS LAST
        LIMIT 200`,
      [scribePid, fileNo, from, to],
    );

    // Dedup by id — the OR condition double-counts rows that have BOTH
    // matching patient_id and matching file_no.
    const seen = new Set();
    const data = [];
    for (const r of rows) {
      const k = String(r.id);
      if (seen.has(k)) continue;
      seen.add(k);
      data.push(r);
    }
    res.json({ data });
  } catch (e) {
    handleError(res, e, "Patient appointments");
  }
});

/**
 * Patient-app: save pre-visit symptoms onto a booked appointment.
 * Public endpoint (no scribe JWT) — scoped by both patient_id and
 * appointment id in the URL, and we re-validate ownership via
 * patient_id/file_no before writing so a stray appointment id can't
 * be hijacked.
 *
 * Body: { symptoms: string[], notes?: string }
 *   - symptoms: chip labels selected by the patient (deduped, max 30)
 *   - notes: free-text ("kuch aur batana hai?"), max 2000 chars
 *
 * Resubmissions overwrite — the row reflects the latest state and
 * pre_visit_symptoms_at is bumped so the doctor sees how fresh it is.
 */
router.post("/patients/:id/appointments/:apptId/pre-visit-symptoms", async (req, res) => {
  try {
    const scribePid = await resolveScribePatientIdFromGenieUuid(req.params.id);
    if (scribePid == null) return res.status(404).json({ error: "Patient not found" });

    const apptId = parseInt(req.params.apptId, 10);
    if (!Number.isFinite(apptId)) return res.status(400).json({ error: "Invalid appointment id" });

    const rawSyms = Array.isArray(req.body?.symptoms) ? req.body.symptoms : [];
    const symptoms = Array.from(
      new Set(
        rawSyms
          .map((s) => (typeof s === "string" ? s.trim() : ""))
          .filter((s) => s.length > 0 && s.length <= 80),
      ),
    ).slice(0, 30);
    const notes =
      typeof req.body?.notes === "string" ? req.body.notes.trim().slice(0, 2000) || null : null;

    // Ownership check: appointment must belong to this patient (by id or file_no).
    const fileNoR = await pool.query(`SELECT file_no FROM patients WHERE id = $1`, [scribePid]);
    const fileNo = fileNoR.rows[0]?.file_no || null;
    const ownership = await pool.query(
      `SELECT id FROM appointments
        WHERE id = $1
          AND (patient_id = $2 OR ($3::text IS NOT NULL AND file_no = $3))
        LIMIT 1`,
      [apptId, scribePid, fileNo],
    );
    if (!ownership.rows[0]) {
      return res.status(404).json({ error: "Appointment not found for this patient" });
    }

    const { rows } = await pool.query(
      `UPDATE appointments
          SET pre_visit_symptoms = $2,
              pre_visit_notes = $3,
              pre_visit_symptoms_at = NOW(),
              updated_at = NOW()
        WHERE id = $1
        RETURNING id, pre_visit_symptoms, pre_visit_notes, pre_visit_symptoms_at`,
      [apptId, symptoms, notes],
    );
    // Push the new pre-visit fields into the Genie Supabase mirror so the
    // patient home re-reads them on next refresh without depending on the
    // scribe REST list-fetcher (which can return [] when the genie→scribe
    // patient-id resolver fails). Best-effort — the response succeeds even
    // if the mirror push errors; patient sees their own write either way.
    if (genie?.syncAppointmentToGenie) {
      genie.syncAppointmentToGenie(scribePid, pool).catch((err) => {
        console.warn("[pre-visit-symptoms] genie mirror push failed:", err?.message || err);
      });
    }
    res.json({ data: rows[0] });
  } catch (e) {
    handleError(res, e, "Pre-visit symptoms save");
  }
});

/**
 * Patient-app: save pre-visit medication-compliance entries onto a booked
 * appointment. Public, ownership-checked (same pattern as pre-visit symptoms).
 *
 * Body: { items: Array<{ medication: string, schedule?: string,
 *                        adherence?: 'always'|'mostly'|'sometimes'|'missed',
 *                        notes?: string }> }
 *
 * Items are sanitized server-side: max 30 entries, each text field clipped
 * to 200 chars, unknown adherence values null'd out. Resubmissions overwrite;
 * pre_visit_compliance_at is bumped so the doctor sees how fresh it is.
 */
router.post("/patients/:id/appointments/:apptId/pre-visit-compliance", async (req, res) => {
  try {
    const scribePid = await resolveScribePatientIdFromGenieUuid(req.params.id);
    if (scribePid == null) return res.status(404).json({ error: "Patient not found" });

    const apptId = parseInt(req.params.apptId, 10);
    if (!Number.isFinite(apptId)) return res.status(400).json({ error: "Invalid appointment id" });

    const ALLOWED_ADHERENCE = new Set(["always", "mostly", "sometimes", "missed"]);
    const clip = (v, n) => (typeof v === "string" ? v.trim().slice(0, n) : "");
    const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];
    const items = rawItems
      .map((it) => {
        const medication = clip(it?.medication, 200);
        if (!medication) return null;
        const schedule = clip(it?.schedule, 200) || null;
        const notes = clip(it?.notes, 500) || null;
        const adherenceRaw = clip(it?.adherence, 20).toLowerCase();
        const adherence = ALLOWED_ADHERENCE.has(adherenceRaw) ? adherenceRaw : null;
        return { medication, schedule, adherence, notes };
      })
      .filter(Boolean)
      .slice(0, 30);

    const fileNoR = await pool.query(`SELECT file_no FROM patients WHERE id = $1`, [scribePid]);
    const fileNo = fileNoR.rows[0]?.file_no || null;
    const ownership = await pool.query(
      `SELECT id FROM appointments
        WHERE id = $1
          AND (patient_id = $2 OR ($3::text IS NOT NULL AND file_no = $3))
        LIMIT 1`,
      [apptId, scribePid, fileNo],
    );
    if (!ownership.rows[0]) {
      return res.status(404).json({ error: "Appointment not found for this patient" });
    }

    const { rows } = await pool.query(
      `UPDATE appointments
          SET pre_visit_compliance = $2::jsonb,
              pre_visit_compliance_at = NOW(),
              updated_at = NOW()
        WHERE id = $1
        RETURNING id, pre_visit_compliance, pre_visit_compliance_at`,
      [apptId, JSON.stringify(items)],
    );
    if (genie?.syncAppointmentToGenie) {
      genie.syncAppointmentToGenie(scribePid, pool).catch((err) => {
        console.warn("[pre-visit-compliance] genie mirror push failed:", err?.message || err);
      });
    }
    res.json({ data: rows[0] });
  } catch (e) {
    handleError(res, e, "Pre-visit compliance save");
  }
});

/**
 * Patient-app chat attachment upload. Public by design (mirrors
 * /care-team) — the patient app has no scribe JWT. Authorization comes
 * from the conversation lookup: the route only accepts uploads when the
 * conversation actually belongs to the :patientId in the URL, and the
 * conversation kind must be lab or reception (doctor chat is text-only
 * by product decision).
 *
 * Body matches the team-side `/conversations/:id/attachments` endpoint:
 * { base64, mediaType, fileName }. The actual upload reuses the same
 * `genie.uploadChatAttachment` function the team route uses, so both
 * directions write to the same `patient-files` bucket via the service
 * key — no patient-side storage RLS, no native upload module dependency,
 * and no anon-key edge cases.
 */
router.post(
  "/patients/:patientId/conversations/:conversationId/chat-attachment",
  validate(conversationAttachmentSchema),
  async (req, res) => {
    try {
      if (!genie?.getConversationById || !genie?.uploadChatAttachment) {
        return res.status(503).json({ error: "Storage not configured" });
      }
      const { patientId, conversationId } = req.params;
      const conv = await genie.getConversationById(conversationId);
      if (!conv) return res.status(404).json({ error: "Conversation not found" });
      if (conv.patient_id !== patientId) {
        return res.status(403).json({ error: "Conversation does not belong to this patient" });
      }
      if (!["lab", "reception"].includes(conv.kind)) {
        return res
          .status(400)
          .json({ error: "Attachments are only supported in lab/reception chats" });
      }

      const result = await genie.uploadChatAttachment({
        patientId,
        conversationId,
        base64: req.body.base64,
        mediaType: req.body.mediaType,
        fileName: req.body.fileName,
      });
      if (result?.error) return res.status(400).json({ error: result.error });

      res.json({
        attachment_path: result.path,
        attachment_mime: result.mime,
        attachment_name: result.name,
      });
    } catch (e) {
      handleError(res, e, "Patient chat attachment upload");
    }
  },
);

/**
 * Public sign-URL helper for the patient app. Validates that the
 * requested storage path lives under the patient's own folder so a
 * patient can only sign their own attachments (the bucket is private,
 * so without this they couldn't fetch anything anyway, but we add the
 * scoping check for defense-in-depth).
 */
router.post("/patients/:patientId/chat-attachments/sign-url", async (req, res) => {
  try {
    if (!genie?.signChatAttachmentUrl) {
      return res.status(503).json({ error: "Storage not configured" });
    }
    const { patientId } = req.params;
    const path = String(req.body?.path || "");
    const expected = new RegExp(`^patients/${patientId}/chat/[0-9a-f-]+/.+`);
    if (!expected.test(path)) {
      return res.status(400).json({ error: "Path does not match this patient's chat folder" });
    }
    const url = await genie.signChatAttachmentUrl(path, 300);
    if (!url) return res.status(404).json({ error: "Object not found" });
    res.json({ url, expires_in: 300 });
  } catch (e) {
    handleError(res, e, "Patient chat attachment sign-url");
  }
});

// ═════════════════════════════════════════════════════════════════════════
// LEGACY routes — kept during rollout so old clients still work
// ═════════════════════════════════════════════════════════════════════════

// Legacy inbox — latest message per patient. Used by the old MessagesPage.jsx
// before the care-team refactor lands.
router.get("/messages/from-genie", async (req, res) => {
  try {
    if (!genie?.getMessagesFromGenie) return res.json({ data: [], total: 0 });
    const role = req.query.role || null;
    const messages = await genie.getMessagesFromGenie(null, role);
    const grouped = {};
    for (const m of messages) {
      if (!grouped[m.patient_id]) grouped[m.patient_id] = [];
      grouped[m.patient_id].push(m);
    }
    const inbox = Object.entries(grouped).map(([pid, msgs]) => {
      const latest = msgs[0];
      const unread = msgs.filter((m) => !m.is_read).length;
      return {
        ...latest,
        patient_id: pid,
        patient_name: latest.sender_name || "Patient",
        unread_count: unread,
        direction: "outbound",
      };
    });
    inbox.sort((a, b) => {
      if (a.unread_count > 0 && b.unread_count === 0) return -1;
      if (a.unread_count === 0 && b.unread_count > 0) return 1;
      return new Date(b.created_at) - new Date(a.created_at);
    });
    res.json({ data: inbox, total: inbox.length });
  } catch (e) {
    handleError(res, e, "Messages inbox");
  }
});

router.get("/messages/inbox", async (req, res) => {
  try {
    if (!genie?.getMessagesFromGenie)
      return res.json({ data: [], total: 0, page: 1, totalPages: 1 });
    const messages = await genie.getMessagesFromGenie(null);
    const grouped = {};
    for (const m of messages) {
      if (!grouped[m.patient_id]) grouped[m.patient_id] = [];
      grouped[m.patient_id].push(m);
    }
    const inbox = Object.entries(grouped).map(([pid, msgs]) => {
      const latest = msgs[0];
      const unread = msgs.filter((m) => !m.is_read).length;
      return {
        ...latest,
        patient_id: pid,
        patient_name: latest.sender_name || "Patient",
        unread_count: unread,
        direction: "outbound",
      };
    });
    inbox.sort((a, b) => {
      if (a.unread_count > 0 && b.unread_count === 0) return -1;
      if (a.unread_count === 0 && b.unread_count > 0) return 1;
      return new Date(b.created_at) - new Date(a.created_at);
    });
    res.json({ data: inbox, total: inbox.length, page: 1, totalPages: 1 });
  } catch (e) {
    handleError(res, e, "Inbox");
  }
});

router.get("/messages/unread-count", async (req, res) => {
  try {
    if (!genie?.getMessagesFromGenie) return res.json({ count: 0 });
    const messages = await genie.getMessagesFromGenie(null);
    const count = messages.filter((m) => !m.is_read).length;
    res.json({ count });
  } catch (e) {
    handleError(res, e, "Unread count");
  }
});

router.put("/messages/:id/read", async (req, res) => {
  try {
    if (!genie?.markMessageReadInGenie) return res.json({ success: false });
    const success = await genie.markMessageReadInGenie(req.params.id);
    res.json({ success });
  } catch (e) {
    handleError(res, e, "Mark read");
  }
});

// Legacy per-patient thread — returns the full merged conversation stream.
// Still used by a handful of older callers. Internally maps to conversations.
router.get("/patients/:id/messages", async (req, res) => {
  try {
    if (!genie?.getThreadFromGenie) {
      if (req.query.limit) return res.json({ data: [], nextCursor: null, hasMore: false });
      return res.json([]);
    }
    const limitRaw = req.query.limit ? parseInt(req.query.limit, 10) : null;
    const limit = limitRaw && limitRaw > 0 ? Math.min(limitRaw, 200) : null;
    const before = req.query.before || null;
    const roleParam = (req.query.role || "").toString().toLowerCase();
    const role = ["doctor", "lab", "reception"].includes(roleParam) ? roleParam : null;
    const doctor = req.query.doctor ? String(req.query.doctor) : null;
    const result = await genie.getThreadFromGenie(req.params.id, { limit, before, role, doctor });
    res.json(result);
  } catch (e) {
    handleError(res, e, "Messages thread");
  }
});

// Legacy send — retained for old clients. New clients should POST to
// /api/conversations/:id/messages.
router.post("/patients/:id/messages", validate(messageCreateSchema), async (req, res) => {
  try {
    const { message, sender_name, sender_role } = req.body;
    if (!genie?.sendReplyToGenie)
      return res.status(400).json({ error: "Genie sync not configured" });
    const patientId = req.params.id;
    const doctorName = sender_name || req.doctor?.doctor_name || "Doctor";
    const reply = await genie.sendReplyToGenie(patientId, message, doctorName, sender_role || null);
    if (!reply) return res.status(500).json({ error: "Failed to send reply" });
    res.json(reply);
  } catch (e) {
    handleError(res, e, "Send message");
  }
});

export default router;
