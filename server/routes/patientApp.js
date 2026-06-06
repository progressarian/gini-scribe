// ── Patient-app profile endpoints ────────────────────────────────────────────
// Server-side companions to the mobile app's "Complete Your Profile" step 2.
// All three require an authenticated PATIENT session (req.patient from
// authMiddleware). They run here — not in the app — because they need the
// genie (app DB) SERVICE key and/or the hospital DB:
//
//   POST /api/patient/app/avatar                { image_base64, mime }
//   POST /api/patient/app/ensure-scribe-patient {}
//   POST /api/patient/app/link-file-no          { file_no }
//
import { Router } from "express";
import pool from "../config/db.js";
import { handleError } from "../utils/errorHandler.js";
import { getGenieDb, importGenieHistoryToScribePatient } from "../services/genieImport.js";

const router = Router();

const AVATAR_BUCKET = "avatars";
const AVATAR_MAX_BYTES = 5 * 1024 * 1024; // 5MB
const AVATAR_MIMES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

const last10 = (p) =>
  String(p || "")
    .replace(/\D/g, "")
    .slice(-10);

function requirePatient(req, res) {
  if (!req.patient) {
    res.status(401).json({ error: "Patient login required" });
    return null;
  }
  return req.patient;
}

// Resolve the genie (app DB) patient row for this session. App-DB sessions
// carry the genie uuid directly; hospital-DB sessions are matched by phone.
async function resolveGeniePatient(patient) {
  const db = getGenieDb();
  if (!db) return { db: null, genie: null };

  if (patient.db === "app") {
    const { data } = await db.from("patients").select("*").eq("id", patient.id).single();
    return { db, genie: data || null };
  }

  const l10 = last10(patient.phone);
  if (!l10) return { db, genie: null };
  const { data } = await db.from("patients").select("*").ilike("phone", `%${l10}`).limit(1);
  return { db, genie: data?.[0] || null };
}

// Find a hospital (scribe) patient by phone, tolerant of the inconsistent
// formats stored in scribe (`+91…`, raw 10-digit, spaced). Mirrors
// patientAuth.findHospitalPatient.
async function findScribePatientByPhone(phone) {
  const l10 = last10(phone);
  if (!l10) return null;
  const { rows } = await pool.query(
    `SELECT id, name, phone, file_no FROM patients
      WHERE right(regexp_replace(COALESCE(phone, ''), '\\D', '', 'g'), 10) = $1
      ORDER BY id ASC LIMIT 1`,
    [l10],
  );
  return rows[0] || null;
}

// ── POST /patient/app/avatar — upload profile photo ─────────────────────────
// Stores the image in the genie storage `avatars` bucket (public, unguessable
// path) and writes the public URL to genie patients.avatar_url.
router.post("/patient/app/avatar", async (req, res) => {
  try {
    const patient = requirePatient(req, res);
    if (!patient) return;

    const { image_base64, mime } = req.body || {};
    const ext = AVATAR_MIMES[mime];
    if (!image_base64 || !ext) {
      return res.status(400).json({ error: "image_base64 and a jpeg/png/webp mime required" });
    }

    const buffer = Buffer.from(image_base64, "base64");
    if (!buffer.length) return res.status(400).json({ error: "Empty image" });
    if (buffer.length > AVATAR_MAX_BYTES) {
      return res.status(413).json({ error: "Image too large (max 5MB)" });
    }

    const { db, genie } = await resolveGeniePatient(patient);
    if (!db) return res.status(503).json({ error: "App DB not configured" });
    if (!genie) return res.status(404).json({ error: "App profile not found for this account" });

    // FIXED path ("{id}/avatar", no extension — contentType carries the mime):
    // the app derives this URL by convention, so the feature works even before
    // the optional patients.avatar_url column migration is applied.
    const path = `${genie.id}/avatar`;
    const { error: upErr } = await db.storage
      .from(AVATAR_BUCKET)
      .upload(path, buffer, { contentType: mime, upsert: true });
    if (upErr) return res.status(502).json({ error: `Avatar upload failed: ${upErr.message}` });

    const { data: pub } = db.storage.from(AVATAR_BUCKET).getPublicUrl(path);
    const avatarUrl = pub?.publicUrl;
    if (!avatarUrl) return res.status(502).json({ error: "Could not resolve avatar URL" });

    // Best-effort write-through to patients.avatar_url. NON-FATAL: the column
    // only exists once the 2026-06-05_patients_avatar_url.sql migration has
    // been applied; until then the app resolves the conventional URL itself.
    const { error: updErr } = await db
      .from("patients")
      .update({ avatar_url: avatarUrl })
      .eq("id", genie.id);
    if (updErr) {
      console.warn(
        `[PatientApp] avatar_url column write skipped (${updErr.message}) — apply migrations/2026-06-05_patients_avatar_url.sql when convenient`,
      );
    }

    // Best-effort: remove legacy timestamped avatar files for this patient.
    db.storage
      .from(AVATAR_BUCKET)
      .list(genie.id)
      .then(({ data: files }) => {
        const stale = (files || []).map((f) => `${genie.id}/${f.name}`).filter((p) => p !== path);
        if (stale.length) return db.storage.from(AVATAR_BUCKET).remove(stale);
      })
      .catch(() => {});

    // Cache-bust so the fresh image renders immediately in-session (the CDN
    // caches the stable path).
    res.json({ avatar_url: `${avatarUrl}?t=${Date.now()}` });
  } catch (e) {
    handleError(res, e, "Patient avatar upload");
  }
});

// ── POST /patient/app/ensure-scribe-patient ─────────────────────────────────
// Guarantees a hospital (scribe) patient record exists for this app account
// and returns its id — needed before the documents-upload pipeline (which is
// keyed by scribe patient id). Creates a GNI- patient when the phone has no
// hospital record; links + imports app history when it does.
router.post("/patient/app/ensure-scribe-patient", async (req, res) => {
  try {
    const patient = requirePatient(req, res);
    if (!patient) return;

    // Hospital-DB sessions already ARE the scribe patient.
    if (patient.db !== "app") {
      return res.json({ scribe_patient_id: patient.id, created: false });
    }

    const { db, genie } = await resolveGeniePatient(patient);
    if (!db) return res.status(503).json({ error: "App DB not configured" });
    if (!genie) return res.status(404).json({ error: "App profile not found" });

    // Already linked with the canonical numeric scribe id.
    if (genie.gini_patient_id && /^\d+$/.test(genie.gini_patient_id)) {
      return res.json({ scribe_patient_id: Number(genie.gini_patient_id), created: false });
    }

    // Legacy rows store the file_no (e.g. "P_175778") — resolve and normalise.
    if (genie.gini_patient_id) {
      const { rows } = await pool.query(
        `SELECT id FROM patients WHERE UPPER(file_no) = UPPER($1) LIMIT 1`,
        [genie.gini_patient_id],
      );
      if (rows[0]) {
        await db
          .from("patients")
          .update({ gini_patient_id: String(rows[0].id) })
          .eq("id", genie.id);
        return res.json({ scribe_patient_id: rows[0].id, created: false });
      }
    }

    // Not linked yet: variant-tolerant phone lookup picks the hospital record
    // if one exists; otherwise doConvert creates a fresh GNI- patient.
    const scribe = await findScribePatientByPhone(genie.phone || patient.phone);
    const result = await importGenieHistoryToScribePatient(genie, scribe?.id ?? null);
    if (!result.ok) {
      return res.status(500).json({ error: `Could not create hospital record (${result.reason})` });
    }
    console.log(
      `[PatientApp] ensure-scribe-patient: genie ${genie.id} → scribe ${result.scribePatientId}` +
        (scribe ? " (matched existing by phone)" : " (created)"),
    );
    res.json({ scribe_patient_id: result.scribePatientId, created: !scribe });
  } catch (e) {
    handleError(res, e, "Ensure scribe patient");
  }
});

// ── POST /patient/app/link-file-no — auto-link on phone match ONLY ──────────
// The patient types their hospital file number (e.g. P_57830). We link the
// app account to that hospital record ONLY when the hospital record's phone
// matches the verified phone on this session — otherwise anyone could attach
// a stranger's medical record. No match → error, nothing stored.
router.post("/patient/app/link-file-no", async (req, res) => {
  try {
    const patient = requirePatient(req, res);
    if (!patient) return;

    if (patient.db !== "app") {
      return res.status(400).json({ error: "This account is already a hospital account" });
    }

    const fileNo = String(req.body?.file_no || "").trim();
    if (!/^[A-Za-z0-9_-]{3,30}$/.test(fileNo)) {
      return res.status(400).json({ error: "Invalid file number format" });
    }

    const { rows } = await pool.query(
      `SELECT id, name, phone, file_no FROM patients WHERE UPPER(file_no) = UPPER($1) LIMIT 1`,
      [fileNo],
    );
    const scribe = rows[0];
    if (!scribe) {
      return res.status(404).json({ error: "File number not found. Please check and try again." });
    }

    // The security gate: verified app phone must match the hospital record.
    if (!scribe.phone || last10(scribe.phone) !== last10(patient.phone)) {
      console.log(
        `[PatientApp] link-file-no REFUSED: ${fileNo} phone mismatch for app patient ${patient.id}`,
      );
      return res.status(403).json({
        error:
          "We couldn't verify this file number against your registered mobile number. Please contact reception.",
      });
    }

    const { db, genie } = await resolveGeniePatient(patient);
    if (!db) return res.status(503).json({ error: "App DB not configured" });
    if (!genie) return res.status(404).json({ error: "App profile not found" });

    // Link + import app history into the verified hospital record.
    const result = await importGenieHistoryToScribePatient(genie, scribe.id);
    if (!result.ok) {
      return res.status(500).json({ error: `Linking failed (${result.reason})` });
    }
    console.log(
      `[PatientApp] link-file-no: genie ${genie.id} linked to scribe ${scribe.id} (${scribe.file_no}) via phone match`,
    );
    res.json({
      linked: true,
      file_no: scribe.file_no,
      patient_name: scribe.name,
      scribe_patient_id: scribe.id,
    });
  } catch (e) {
    handleError(res, e, "Link file number");
  }
});

export default router;
