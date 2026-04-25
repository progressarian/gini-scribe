import { Router } from "express";
import { createRequire } from "module";
import pool from "../config/db.js";

const require = createRequire(import.meta.url);
const {
  syncDocumentsToGenie,
  syncLabsToGenie,
  syncMedicationsToGenie,
} = require("../genie-sync.cjs");
import { SUPABASE_URL, SUPABASE_SERVICE_KEY, STORAGE_BUCKET } from "../config/storage.js";
import { n, safeJson } from "../utils/helpers.js";
import { handleError } from "../utils/errorHandler.js";
import { getCanonical } from "../utils/labCanonical.js";
import { validate } from "../middleware/validate.js";
import { documentCreateSchema, fileUploadSchema } from "../schemas/index.js";
import { fetchMedicalRecords } from "../services/healthray/client.js";
import {
  downloadAndStore,
  syncDiagnoses,
  syncSymptoms,
  syncStoppedMedications,
  syncLabResults,
  syncBiomarkersFromLatestLabs,
  syncVitals,
} from "../services/healthray/db.js";
import {
  extractPrescription,
  extractFromFile,
} from "../services/healthray/prescriptionExtractor.js";
import { extractWithRetry, detectMediaType } from "../services/extraction.js";
import {
  stripFormPrefix,
  canonicalMedKey,
  routeForForm,
} from "../services/medication/normalize.js";
import {
  findEarliestStartDates,
  resolveStartedDate,
} from "../services/medication/historicalStart.js";

const router = Router();

// ── DB migration: ensure document_id columns exist ──────────────────────────
pool
  .query(
    `ALTER TABLE lab_results ADD COLUMN IF NOT EXISTS document_id INTEGER;
   ALTER TABLE medications ADD COLUMN IF NOT EXISTS document_id INTEGER;`,
  )
  .catch(() => {});

// ── DB migration: reviewed flag for unread report rule ───────────────────────
pool
  .query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS reviewed BOOLEAN DEFAULT FALSE`)
  .catch(() => {});

// ── Refresh OPD consultations when prescription data changes ────────────────
async function refreshOpdConsultations(client, patientId) {
  // Get ALL prescription documents for this patient
  const { rows: rxDocs } = await client.query(
    `SELECT extracted_data, doc_date, created_at FROM documents
     WHERE patient_id = $1 AND source = 'opd_upload' AND doc_type = 'prescription'
       AND extracted_data IS NOT NULL
     ORDER BY doc_date DESC NULLS LAST, created_at DESC`,
    [patientId],
  );
  if (!rxDocs.length) return;

  // Aggregate all prescription data
  const allDiags = [];
  const allMeds = [];
  const allStopped = [];
  const transcriptParts = [];

  for (const doc of rxDocs) {
    const rx = doc.extracted_data || {};
    const parts = [];
    if (rx.diagnoses?.length) {
      parts.push(
        "DIAGNOSIS:\n" +
          rx.diagnoses.map((d) => `${d.label}${d.status ? ` (${d.status})` : ""}`).join("\n"),
      );
      for (const d of rx.diagnoses) {
        if (d.id) allDiags.push(d);
      }
    }
    if (rx.medications?.length) {
      parts.push(
        "TREATMENT:\n" +
          rx.medications
            .map(
              (m) =>
                `-${m.name}${m.dose ? " " + m.dose : ""}${m.frequency ? " " + m.frequency : ""}${m.timing ? " " + m.timing : ""}`,
            )
            .join("\n"),
      );
      allMeds.push(...rx.medications);
    }
    if (rx.stopped_medications?.length) {
      parts.push(
        "STOPPED:\n" +
          rx.stopped_medications
            .map((m) => `-${m.name}${m.reason ? " (" + m.reason + ")" : ""}`)
            .join("\n"),
      );
      allStopped.push(...rx.stopped_medications);
    }
    if (rx.advice?.length) parts.push("ADVICE:\n" + rx.advice.join("\n"));
    if (rx.follow_up) parts.push("FOLLOW UP: " + rx.follow_up);
    if (rx.doctor_name)
      transcriptParts.push(
        `Rx by ${rx.doctor_name}${rx.visit_date ? " on " + rx.visit_date : ""}:`,
      );
    if (parts.length) transcriptParts.push(parts.join("\n\n"));
    transcriptParts.push("");
  }

  // Deduplicate diagnoses by id
  const diagMap = {};
  for (const d of allDiags) {
    if (d?.id) diagMap[d.id] = d;
  }
  const mergedDiags = Object.values(diagMap);
  const conTranscript = transcriptParts.filter(Boolean).join("\n\n");

  // Update ALL OPD consultations for this patient
  const { rows: opdCons } = await client.query(
    `SELECT id, mo_data, con_data FROM consultations
     WHERE patient_id = $1 AND visit_type = 'OPD'`,
    [patientId],
  );

  for (const con of opdCons) {
    const moData = con.mo_data || {};
    moData.diagnoses = mergedDiags;
    moData.previous_medications = allMeds;
    moData.stopped_medications = allStopped;
    moData.chief_complaints = mergedDiags.map((d) => d.label);

    const conData = con.con_data || {};
    conData.medications_confirmed = allMeds;

    await client.query(
      `UPDATE consultations
       SET mo_data = $2::jsonb, con_data = $3::jsonb, con_transcript = $4
       WHERE id = $1`,
      [con.id, JSON.stringify(moData), JSON.stringify(conData), conTranscript || null],
    );
  }

  // Link unlinked documents to the latest consultation
  if (opdCons.length) {
    await client.query(
      `UPDATE documents SET consultation_id = $1
       WHERE patient_id = $2 AND source = 'opd_upload' AND consultation_id IS NULL`,
      [opdCons[0].id, patientId],
    );
  }
}

// ── Write an extracted follow-up onto the appointment that matches this
// prescription (by patient + doc/visit date ±1 day). Silently no-ops if the
// follow-up is empty or no matching appointment can be found, so we never
// clobber an unrelated appointment's follow_up.
async function syncFollowUpToAppointment(client, patientId, followUp, anchorDate) {
  if (!patientId || !followUp || !anchorDate) return;
  const hasAny =
    followUp.date ||
    (followUp.timing && String(followUp.timing).trim()) ||
    (followUp.notes && String(followUp.notes).trim());
  if (!hasAny) return;

  const { rows } = await client.query(
    `SELECT id FROM appointments
     WHERE patient_id = $1
       AND appointment_date::date BETWEEN ($2::date - INTERVAL '1 day') AND ($2::date + INTERVAL '1 day')
     ORDER BY appointment_date DESC
     LIMIT 1`,
    [patientId, anchorDate],
  );
  const apptId = rows[0]?.id;
  if (!apptId) return;

  await client.query(
    `UPDATE appointments
     SET healthray_follow_up = $1::jsonb, updated_at = NOW()
     WHERE id = $2`,
    [JSON.stringify(followUp), apptId],
  );
}

// Save document metadata
router.post("/patients/:id/documents", validate(documentCreateSchema), async (req, res) => {
  try {
    const {
      doc_type,
      title,
      file_name,
      file_url,
      extracted_text,
      extracted_data,
      doc_date,
      source,
      notes,
      consultation_id,
    } = req.body;
    const result = await pool.query(
      `INSERT INTO documents (patient_id, consultation_id, doc_type, title, file_name, file_url, extracted_text, extracted_data, doc_date, source, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [
        req.params.id,
        n(consultation_id),
        n(doc_type),
        n(title),
        n(file_name),
        n(file_url),
        n(extracted_text),
        safeJson(extracted_data),
        n(doc_date) || null,
        n(source),
        n(notes),
      ],
    );
    res.json(result.rows[0]);
  } catch (e) {
    handleError(res, e, "Document");
  }
});

// Get specific document
router.get("/documents/:id", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM documents WHERE id=$1", [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: "Not found" });
    res.json(result.rows[0]);
  } catch (e) {
    handleError(res, e, "Document");
  }
});

// Supabase storage keys must be ASCII-only and URL-safe; filenames that come
// from the OS (especially after renaming) often contain em-dashes, smart
// quotes, or other unicode that Supabase rejects with InvalidKey. Sanitize
// for the key while preserving the extension.
export function sanitizeForStorageKey(name) {
  if (!name) return `file_${Date.now()}`;
  const lastDot = name.lastIndexOf(".");
  const base = lastDot > 0 ? name.slice(0, lastDot) : name;
  const ext = lastDot > 0 ? name.slice(lastDot + 1).toLowerCase() : "";
  const cleanBase = base
    .normalize("NFKD")
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[\u2018\u2019\u201C\u201D]/g, "")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/\s+/g, "_")
    .replace(/[^\w.\-]/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^[_.-]+|[_.-]+$/g, "")
    .slice(0, 120);
  const cleanExt = ext.replace(/[^a-z0-9]/g, "").slice(0, 8);
  const safeBase = cleanBase || `file_${Date.now()}`;
  return cleanExt ? `${safeBase}.${cleanExt}` : safeBase;
}

// Upload file to Supabase Storage
router.post("/documents/:id/upload-file", validate(fileUploadSchema), async (req, res) => {
  try {
    const { base64, mediaType, fileName } = req.body;
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY)
      return res.status(400).json({ error: "Storage not configured" });

    const doc = await pool.query("SELECT * FROM documents WHERE id=$1", [req.params.id]);
    if (!doc.rows[0]) return res.status(404).json({ error: "Document not found" });
    const patientId = doc.rows[0].patient_id;

    const docType = doc.rows[0].doc_type || "other";
    const ts = Date.now();
    const safeName = sanitizeForStorageKey(fileName);
    const storagePath = `patients/${patientId}/${docType}/${ts}_${safeName}`;

    const fileBuffer = Buffer.from(base64, "base64");
    const uploadResp = await fetch(
      `${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${storagePath}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
          "Content-Type": mediaType || "application/octet-stream",
          "x-upsert": "true",
        },
        body: fileBuffer,
      },
    );

    if (!uploadResp.ok) {
      const err = await uploadResp.text();
      return res.status(500).json({ error: "Upload failed: " + err });
    }

    await pool.query(
      "UPDATE documents SET storage_path=$1, mime_type=$2, file_name=COALESCE(NULLIF($3,''),file_name) WHERE id=$4",
      [storagePath, mediaType, fileName || null, req.params.id],
    );

    // Kick off server-side extraction in the background. skipIfNotPending
    // means if the client (companion / OPD) finishes its own fast path
    // first, we no-op instead of clobbering the result. This is what
    // makes refresh-mid-upload recoverable: even if the tab closes, the
    // server still has the file and will produce extraction_status =
    // extracted | failed, never leaving the row stuck on "pending".
    runServerExtraction(req.params.id, { skipIfNotPending: true }).catch((err) => {
      console.error(`[upload-file] Background extraction for doc ${req.params.id} crashed:`, err);
    });

    syncDocumentsToGenie(patientId, pool).catch((e) =>
      console.warn("[upload-file] Genie doc push skipped:", e.message),
    );

    res.json({ success: true, storage_path: storagePath, file_name: fileName });
  } catch (e) {
    handleError(res, e, "Document");
  }
});

// ── Detect MIME type from file extension ─────────────────────────────────────
function mimeFromFileName(fileName) {
  const ext = (fileName || "").split(".").pop().toLowerCase();
  return (
    {
      pdf: "application/pdf",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      gif: "image/gif",
      webp: "image/webp",
      tiff: "image/tiff",
      tif: "image/tiff",
    }[ext] || null
  );
}

// ── Resolve accessible URL for a document (HealthRay or Supabase) ────────────
async function resolveDocumentUrl(docId) {
  const doc = await pool.query(
    `SELECT storage_path, file_url, mime_type, file_name, source, notes, patient_id, doc_date
     FROM documents
     WHERE id=$1`,
    [docId],
  );

  const d = doc.rows[0];
  if (!d) return { error: "Document not found", status: 404 };

  // ── HealthRay document ─────────────────────────────────────────────
  if (!d.storage_path && d.source === "healthray") {
    const notesStr = d.notes || "";
    const recordIdStr = notesStr.match(/healthray_record:(\d+)/)?.[1] || null;
    const medicalRecordIdStr = notesStr.match(/healthray_mrid:(\d+)/)?.[1] || null;
    // Only use stored rtype if it's in notes — never default to Prescription/Rx
    // because old docs may be "Other" type and defaulting to Prescription causes wrong file downloads.
    const recordTypeStr = notesStr.match(/healthray_rtype:([^|]+)/)?.[1] || null;
    const healthrayApptId = notesStr.match(/healthray_appt:(\d+)/)?.[1] || null;

    console.log(
      `[Document ${docId}] HealthRay resolve — record=${recordIdStr} mrid=${medicalRecordIdStr} rtype=${recordTypeStr} appt=${healthrayApptId} notes="${notesStr}"`,
    );

    // Helper: download with auth and cache to Supabase
    async function tryDownload(attachId, mrid, rtype, fileName) {
      if (!attachId || !mrid || !rtype) return null;
      const { downloadMedicalRecordFile } = await import("../services/healthray/client.js");
      const result = await downloadMedicalRecordFile(attachId, rtype, mrid);
      if (result?.buffer?.length > 0) {
        const { downloadAndStore } = await import("../services/healthray/db.js");
        downloadAndStore(d.patient_id, docId, d.file_url, fileName, attachId, rtype, mrid).catch(
          () => {},
        );
        return { buffer: result.buffer, mimeType: result.contentType, fileName };
      }
      console.log(
        `[Document ${docId}] downloadMedicalRecordFile returned null for attach=${attachId} mrid=${mrid}`,
      );
      return null;
    }

    // Step 0: both IDs AND rtype already in notes — fastest path (skip if rtype missing to avoid wrong type)
    if (recordIdStr && medicalRecordIdStr && recordTypeStr) {
      console.log(
        `[Document ${docId}] Step 0: direct download attach=${recordIdStr} mrid=${medicalRecordIdStr} rtype=${recordTypeStr}`,
      );
      try {
        const r = await tryDownload(recordIdStr, medicalRecordIdStr, recordTypeStr, d.file_name);
        if (r) return r;
      } catch (e) {
        console.error(`[Document ${docId}] Step 0 failed: ${e.message}`);
      }
    }

    // Step 1: look up appointment ID(s) — from notes or DB by doc_date
    const candidateApptIds = healthrayApptId ? [healthrayApptId] : [];
    if (candidateApptIds.length === 0) {
      const apptR = await pool
        .query(
          `SELECT healthray_id FROM appointments
           WHERE patient_id=$1
             AND appointment_date::date BETWEEN ($2::date - INTERVAL '1 day') AND ($2::date + INTERVAL '1 day')
             AND healthray_id IS NOT NULL
           ORDER BY appointment_date DESC`,
          [d.patient_id, d.doc_date],
        )
        .catch(() => ({ rows: [] }));
      for (const row of apptR.rows) candidateApptIds.push(row.healthray_id);
    }

    console.log(
      `[Document ${docId}] Step 1: candidate appt IDs = [${candidateApptIds.join(", ")}]`,
    );

    // Step 2: fetch records list from HealthRay, get mrid, download PDF
    for (const apptId of candidateApptIds) {
      try {
        const records = await fetchMedicalRecords(apptId);
        if (!Array.isArray(records) || records.length === 0) {
          console.log(`[Document ${docId}] Step 2: empty records for apptId=${apptId}`);
          continue;
        }

        // If we have a specific record ID, find exact match first.
        // Do NOT fall back to records[0] — that could be the prescription.
        // If not found by ID, try to match by record_type.
        let match = recordIdStr ? records.find((r) => String(r.id) === String(recordIdStr)) : null;
        if (!match && recordTypeStr) {
          match = records.find((r) => r.record_type === recordTypeStr);
        }
        if (!match) {
          console.log(
            `[Document ${docId}] Step 2: no match found for record=${recordIdStr} rtype=${recordTypeStr} in ${records.length} records`,
          );
          continue;
        }

        const attachId = match?.id ? String(match.id) : recordIdStr;
        const mrid = match?.medical_record_id ? String(match.medical_record_id) : null;
        const rtype = match?.record_type || recordTypeStr;
        const fileName = match?.file_name || d.file_name;

        console.log(
          `[Document ${docId}] Step 2: appt=${apptId} attach=${attachId} mrid=${mrid} rtype=${rtype}`,
        );

        // Persist mrid to notes so Step 0 hits next time
        if (mrid && mrid !== medicalRecordIdStr) {
          const updatedNotes = [
            notesStr.replace(/\|?healthray_mrid:\d+/, ""),
            `healthray_mrid:${mrid}`,
          ]
            .filter(Boolean)
            .join("|");
          pool
            .query(`UPDATE documents SET notes=$1 WHERE id=$2`, [updatedNotes, docId])
            .catch(() => {});
        }

        try {
          const r = await tryDownload(attachId, mrid, rtype, fileName);
          if (r) return r;

          // tryDownload returned null (e.g. HealthRay "no record found").
          // Fall back to the fresh URL from the records list (thumbnail/preview).
          const freshUrl = match.url || match.file_url || match.attachment_url || match.thumbnail;
          if (freshUrl && freshUrl.startsWith("http")) {
            console.log(
              `[Document ${docId}] Step 2: tryDownload null — trying fresh match.url fallback`,
            );
            const { healthrayRawFetch } = await import("../services/healthray/client.js");
            const rf = await healthrayRawFetch(freshUrl).catch(() => null);
            if (rf) {
              console.log(
                `[Document ${docId}] Step 2: match.url fallback succeeded (${rf.buffer.length} bytes)`,
              );
              return { buffer: rf.buffer, mimeType: rf.contentType, fileName };
            }
          }
        } catch (e) {
          console.error(
            `[Document ${docId}] Step 2 download failed for apptId=${apptId}: ${e.message}`,
          );
        }
      } catch (apiErr) {
        console.error(
          `[Document ${docId}] Step 2 fetchMedicalRecords failed for apptId=${apptId}: ${apiErr.message}`,
        );
      }
    }

    if (candidateApptIds.length === 0) {
      console.warn(
        `[Document ${docId}] No appointment candidates — patient=${d.patient_id} doc_date=${d.doc_date}`,
      );
    }

    // Step 3: try fetching stored file_url (thumbnail/preview) with HealthRay auth as last resort
    if (d.file_url && d.file_url.startsWith("http")) {
      console.log(
        `[Document ${docId}] Step 3: trying file_url fallback — ${d.file_url.slice(0, 80)}`,
      );
      try {
        const { healthrayRawFetch } = await import("../services/healthray/client.js");
        const r = await healthrayRawFetch(d.file_url);
        if (r) {
          console.log(
            `[Document ${docId}] Step 3: file_url fallback succeeded (${r.buffer.length} bytes)`,
          );
          return { buffer: r.buffer, mimeType: r.contentType, fileName: d.file_name };
        }
      } catch (e) {
        console.error(`[Document ${docId}] Step 3 file_url fallback failed: ${e.message}`);
      }
    }

    console.error(`[Document ${docId}] All download paths failed — returning 404`);
    return { error: "Could not retrieve file from HealthRay", status: 404 };
  }

  // ── Supabase storage ─────────────────────────────────────────────
  if (!d.storage_path) return { error: "No file attached", status: 404 };

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY)
    return { error: "Storage not configured", status: 400 };

  const signResp = await fetch(
    `${SUPABASE_URL}/storage/v1/object/sign/${STORAGE_BUCKET}/${d.storage_path}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ expiresIn: 3600 }),
    },
  );

  if (!signResp.ok) {
    return { error: "Failed to generate URL", status: 500 };
  }

  const signData = await signResp.json();
  const signedPath = signData.signedURL || signData.signedUrl || signData.token;
  const url = signedPath?.startsWith("http")
    ? signedPath
    : `${SUPABASE_URL}/storage/v1${signedPath}`;

  const mimeType = mimeFromFileName(d.file_name) || d.mime_type || "application/pdf";
  return { url, mimeType, fileName: d.file_name };
}

// Get signed URL to view/download a file
router.get("/documents/:id/file-url", async (req, res) => {
  try {
    const result = await resolveDocumentUrl(req.params.id);
    if (result.error) return res.status(result.status).json({ error: result.error });
    return res.json({ url: result.url, mime_type: result.mimeType, file_name: result.fileName });
  } catch (e) {
    handleError(res, e, "Document");
  }
});

// Stream document file — proxies through backend (avoids CORS, always fresh URL)
router.get("/documents/:id/stream", async (req, res) => {
  try {
    const result = await resolveDocumentUrl(req.params.id);
    if (result.error) return res.status(result.status).json({ error: result.error });

    // Buffer-based path: HealthRay docs downloaded with auth (no external URL fetch needed)
    if (result.buffer) {
      res.set("Content-Type", result.mimeType || "application/pdf");
      res.set(
        "Content-Disposition",
        `inline; filename="${encodeURIComponent(result.fileName || "document")}"`,
      );
      res.set("Cache-Control", "private, max-age=300");
      return res.send(result.buffer);
    }

    const fileRes = await fetch(result.url);
    if (!fileRes.ok) {
      console.error(
        `[Document stream ${req.params.id}] Storage fetch failed: ${fileRes.status} ${fileRes.statusText} — URL: ${result.url.slice(0, 120)}`,
      );
      return res.status(502).json({ error: "Failed to fetch document from storage" });
    }

    // Detect MIME type:
    //   1. Actual response Content-Type (most accurate)
    //   2. result.mimeType — already URL-based detected in resolveDocumentUrl (catches JPEG thumbnails stored as "pdf" in DB)
    //   3. Filename extension (OPD uploads with generic octet-stream)
    //   4. Default PDF
    const responseMime = fileRes.headers.get("content-type")?.split(";")[0].trim();

    // Guard: if HealthRay returns a JSON error body (HTTP 200 but status!=200 in body), reject it
    if (responseMime === "application/json") {
      const body = await fileRes.json().catch(() => ({}));
      console.error(
        `[Document stream ${req.params.id}] URL returned JSON instead of file — status=${body.status}: ${body.message}`,
      );
      return res.status(502).json({ error: "Could not retrieve file from HealthRay" });
    }

    const mimeType =
      responseMime && responseMime !== "application/octet-stream"
        ? responseMime
        : result.mimeType || mimeFromFileName(result.fileName) || "application/pdf";
    const fileName = result.fileName || "document";
    const buffer = Buffer.from(await fileRes.arrayBuffer());

    res.set("Content-Type", mimeType);
    res.set("Content-Disposition", `inline; filename="${encodeURIComponent(fileName)}"`);
    res.set("Cache-Control", "private, max-age=300");
    res.send(buffer);
  } catch (e) {
    handleError(res, e, "Document");
  }
});

// Get prescription for a consultation (for reprinting)
router.get("/consultations/:id/prescription", async (req, res) => {
  try {
    const doc = await pool.query(
      "SELECT * FROM documents WHERE consultation_id=$1 AND doc_type='prescription' ORDER BY created_at DESC LIMIT 1",
      [req.params.id],
    );
    if (doc.rows[0]) return res.json(doc.rows[0]);

    const con = await pool.query(
      `SELECT c.*, p.name as patient_name, p.age, p.sex, p.phone, p.file_no, p.dob
       FROM consultations c JOIN patients p ON p.id=c.patient_id WHERE c.id=$1`,
      [req.params.id],
    );
    if (!con.rows[0]) return res.status(404).json({ error: "Not found" });
    const c = con.rows[0];
    res.json({
      doc_type: "prescription",
      title: `Prescription — ${c.con_name} — ${new Date(c.visit_date || c.created_at).toLocaleDateString("en-IN")}`,
      extracted_data: {
        patient: {
          name: c.patient_name,
          age: c.age,
          sex: c.sex,
          phone: c.phone,
          fileNo: c.file_no,
        },
        doctor: c.con_name,
        mo: c.mo_name,
        date: c.visit_date || c.created_at,
        diagnoses: c.mo_data?.diagnoses || [],
        medications: c.con_data?.medications_confirmed || [],
        diet_lifestyle: c.con_data?.diet_lifestyle || [],
        follow_up: c.con_data?.follow_up || {},
        assessment_summary: c.con_data?.assessment_summary || "",
        chief_complaints: c.mo_data?.chief_complaints || [],
        plan_edits: c.plan_edits,
      },
      source: "scribe",
      doc_date: c.visit_date || c.created_at,
    });
  } catch (e) {
    handleError(res, e, "Document");
  }
});

// Get imaging documents for a patient
router.get("/patients/:id/imaging", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, doc_type, title, file_name, doc_date, source, notes, extracted_data, created_at
       FROM documents WHERE patient_id=$1 AND doc_type NOT IN ('prescription','lab_report')
       ORDER BY doc_date DESC`,
      [req.params.id],
    );
    res.json(result.rows);
  } catch (e) {
    handleError(res, e, "Document");
  }
});

// Update a document (extracted_data, notes, etc.)
// When extracted_data contains lab panels, syncs all tests to lab_results table
router.patch("/documents/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { extracted_data, notes, doc_type } = req.body;
    const sets = [];
    const vals = [req.params.id];
    let idx = 2;
    if (extracted_data !== undefined) {
      sets.push(`extracted_data = $${idx}::jsonb`);
      vals.push(JSON.stringify(extracted_data));
      idx++;
    }
    if (notes !== undefined) {
      sets.push(`notes = $${idx}`);
      vals.push(notes);
      idx++;
    }
    if (doc_type !== undefined) {
      sets.push(`doc_type = $${idx}`);
      vals.push(doc_type);
      idx++;
    }
    if (!sets.length) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Nothing to update" });
    }
    const result = await client.query(
      `UPDATE documents SET ${sets.join(", ")} WHERE id = $1 RETURNING *`,
      vals,
    );
    if (!result.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Not found" });
    }

    const doc = result.rows[0];

    // ── Sync extracted lab tests to lab_results table ──
    if (extracted_data?.panels && doc.patient_id) {
      // Remove previous entries synced from this document
      await client.query(`DELETE FROM lab_results WHERE document_id = $1`, [doc.id]);

      const testDate =
        extracted_data.report_date ||
        extracted_data.collection_date ||
        (doc.doc_date
          ? new Date(doc.doc_date).toISOString().split("T")[0]
          : new Date().toISOString().split("T")[0]);

      for (const panel of extracted_data.panels) {
        for (const test of panel.tests || []) {
          if (test.result == null && !test.result_text) continue;
          const numResult = typeof test.result === "number" ? test.result : parseFloat(test.result);

          await client.query(
            `INSERT INTO lab_results
               (patient_id, document_id, consultation_id, test_date, panel_name, test_name, canonical_name, result, result_text, unit, flag, ref_range, source)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'report_extract')`,
            [
              doc.patient_id,
              doc.id,
              doc.consultation_id || null,
              testDate,
              panel.panel_name || null,
              test.test_name,
              getCanonical(test.test_name) || test.test_name,
              isNaN(numResult) ? null : numResult,
              test.result_text || null,
              test.unit || null,
              test.flag || null,
              test.ref_range || null,
            ],
          );
        }
      }

      // Sync vitals from extracted data (Weight, Height, BMI, BP) — same as HealthRay flow
      try {
        const { syncVitalsFromExtraction } = await import("../services/healthray/db.js");
        const reportDate =
          extracted_data.report_date ||
          extracted_data.collection_date ||
          (doc.doc_date ? new Date(doc.doc_date).toISOString().split("T")[0] : null);
        await syncVitalsFromExtraction(doc.patient_id, extracted_data, reportDate);
      } catch (syncErr) {
        console.error(
          `[DocSync] Vitals sync failed for patient ${doc.patient_id}:`,
          syncErr.message,
        );
      }

      // Sync biomarkers to latest appointment so OPD page reflects new values
      try {
        const { rows: apptRows } = await client.query(
          `SELECT id FROM appointments WHERE patient_id = $1 ORDER BY appointment_date DESC LIMIT 1`,
          [doc.patient_id],
        );
        if (apptRows[0]) {
          const { syncBiomarkersFromLatestLabs } = await import("../services/healthray/db.js");
          await syncBiomarkersFromLatestLabs(doc.patient_id, apptRows[0].id);
        }
      } catch (syncErr) {
        console.error(
          `[DocSync] Biomarker sync failed for patient ${doc.patient_id}:`,
          syncErr.message,
        );
      }
    }

    // ── Sync extracted prescription data (diagnoses + medications) ──
    if (doc.patient_id && extracted_data?.medications) {
      // Add document_id columns to medications if not yet there
      await client
        .query(`ALTER TABLE medications ADD COLUMN IF NOT EXISTS document_id INTEGER`)
        .catch(() => {});

      // Remove previous entries synced from this document
      await client.query(`DELETE FROM medications WHERE document_id = $1`, [doc.id]);

      const rxDate =
        extracted_data.visit_date ||
        (doc.doc_date
          ? new Date(doc.doc_date).toISOString().split("T")[0]
          : new Date().toISOString().split("T")[0]);

      for (const m of extracted_data.medications || []) {
        if (!m?.name) continue;
        const { name: cleanName, form: detectedForm } = stripFormPrefix(m.name);
        const storedName = cleanName || m.name;
        const storedRoute = m.route || routeForForm(detectedForm) || "Oral";
        await client.query(
          `INSERT INTO medications
             (patient_id, document_id, consultation_id, name, pharmacy_match, dose, frequency, timing, route, is_new, is_active, source, started_date)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, false, true, 'report_extract', $10)
           ON CONFLICT (patient_id, UPPER(COALESCE(pharmacy_match, name))) WHERE is_active = true
           DO UPDATE SET document_id = EXCLUDED.document_id,
             consultation_id = COALESCE(EXCLUDED.consultation_id, medications.consultation_id),
             pharmacy_match = COALESCE(EXCLUDED.pharmacy_match, medications.pharmacy_match),
             dose = COALESCE(EXCLUDED.dose, medications.dose),
             frequency = COALESCE(EXCLUDED.frequency, medications.frequency),
             timing = COALESCE(EXCLUDED.timing, medications.timing),
             route = COALESCE(EXCLUDED.route, medications.route),
             source = EXCLUDED.source,
             started_date = LEAST(medications.started_date, EXCLUDED.started_date),
             updated_at = NOW()`,
          [
            doc.patient_id,
            doc.id,
            doc.consultation_id || null,
            storedName.slice(0, 200),
            canonicalMedKey(storedName).slice(0, 200),
            (m.dose || "").slice(0, 100),
            (m.frequency || "").slice(0, 100),
            (m.timing || "").slice(0, 100),
            storedRoute.slice(0, 50),
            rxDate,
          ],
        );
      }

      // Sync stopped medications as inactive
      for (const m of extracted_data.stopped_medications || []) {
        if (!m?.name) continue;
        const { name: cleanName } = stripFormPrefix(m.name);
        const storedName = cleanName || m.name;
        await client.query(
          `INSERT INTO medications
             (patient_id, document_id, consultation_id, name, pharmacy_match, is_new, is_active, source, started_date)
           VALUES ($1, $2, $3, $4, $5, false, false, 'report_extract', $6)
           ON CONFLICT (patient_id, UPPER(COALESCE(pharmacy_match, name))) WHERE is_active = false
           DO UPDATE SET document_id = EXCLUDED.document_id,
             consultation_id = COALESCE(EXCLUDED.consultation_id, medications.consultation_id),
             pharmacy_match = COALESCE(EXCLUDED.pharmacy_match, medications.pharmacy_match),
             source = EXCLUDED.source,
             updated_at = NOW()`,
          [
            doc.patient_id,
            doc.id,
            doc.consultation_id || null,
            storedName.slice(0, 200),
            canonicalMedKey(storedName).slice(0, 200),
            rxDate,
          ],
        );
      }

      // Sync diagnoses
      for (const d of extracted_data.diagnoses || []) {
        if (!d?.id || !d?.label) continue;
        await client.query(
          `INSERT INTO diagnoses (patient_id, diagnosis_id, label, status)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (patient_id, diagnosis_id) DO UPDATE
             SET label = EXCLUDED.label,
                 status = EXCLUDED.status`,
          [doc.patient_id, d.id, d.label, d.status || "Controlled"],
        );
      }

      // Sync follow-up to the matching appointment
      if (extracted_data.follow_up) {
        const anchor =
          extracted_data.visit_date ||
          (doc.doc_date ? new Date(doc.doc_date).toISOString().split("T")[0] : null);
        await syncFollowUpToAppointment(client, doc.patient_id, extracted_data.follow_up, anchor);
      }

      // ── Refresh OPD consultations with latest prescription data ──
      await refreshOpdConsultations(client, doc.patient_id);
    }

    await client.query("COMMIT");

    if (doc.patient_id) {
      syncDocumentsToGenie(doc.patient_id, pool).catch((e) =>
        console.warn("[PATCH /documents] Genie doc push skipped:", e.message),
      );
      // Newly extracted lab values + meds rows from this document need to
      // reach Genie's lab_results / medications tables so the Journey page
      // and Medicines tab populate without waiting for a visit save.
      if (extracted_data?.panels) {
        syncLabsToGenie(doc.patient_id, pool).catch((e) =>
          console.warn("[PATCH /documents] Genie labs push skipped:", e.message),
        );
      }
      if (extracted_data?.medications || extracted_data?.medicines) {
        syncMedicationsToGenie(doc.patient_id, pool).catch((e) =>
          console.warn("[PATCH /documents] Genie meds push skipped:", e.message),
        );
      }
    }

    // Bust summary cache so the panel reflects the newly extracted report immediately
    if (doc.patient_id && extracted_data?.panels) {
      pool
        .query(
          `UPDATE appointments SET ai_summary=NULL, ai_summary_generated_at=NULL
           WHERE patient_id=$1
             AND appointment_date=(SELECT MAX(appointment_date) FROM appointments WHERE patient_id=$1)`,
          [doc.patient_id],
        )
        .catch(() => {});
    }

    res.json(doc);
  } catch (e) {
    await client.query("ROLLBACK");
    handleError(res, e, "Document patch");
  } finally {
    client.release();
  }
});

// ── Core extraction runner, reused by:
//   1. POST /documents/:id/retry-extract  (always runs, force=true)
//   2. POST /documents/:id/upload-file    (fire-and-forget after upload)
//   3. stale-pending cleanup cron         (kicks off extraction for docs
//      stuck pending when the client never finished)
//
// Flow:
//   1. Load doc; in skip-if-not-pending mode, bail if the client already
//      wrote extracted_data (so we don't race with companion/OPD client
//      extraction).
//   2. Flip extracted_data.extraction_status to "pending" so polling UIs
//      show "⏳ Extracting…" while this runs.
//   3. Resolve file bytes from Supabase/HealthRay.
//   4. Call extractWithRetry (3 attempts, 180s each, retries on 5xx/429,
//      parse failures, and "thin JSON" partial extractions).
//   5. On success: UPDATE extracted_data + cascade to labs/meds/vitals/
//      biomarkers/diagnoses/follow-up (same cascade PATCH /:id runs).
//   6. On failure: UPDATE extracted_data to { extraction_status:"failed",
//      error_message, retry_count, failed_at } so every doc-rendering
//      surface can show "❌ Failed — Retry".
// Returns a result object; the HTTP handler decides what to send to the
// client. Never throws to the caller.
async function runServerExtraction(docId, { skipIfNotPending = false } = {}) {
  docId = Number(docId);
  if (!docId) return { success: false, error_message: "Invalid document ID" };

  try {
    const { rows } = await pool.query(
      `SELECT id, patient_id, doc_type, file_url, storage_path, mime_type, file_name, doc_date, source, extracted_data
       FROM documents WHERE id = $1`,
      [docId],
    );
    if (!rows[0]) return { success: false, error_message: "Document not found" };
    const doc = rows[0];

    // Dedup: when fired from upload-file, the client may also extract. If
    // the client already wrote a real extraction (or a mismatch/failed),
    // don't clobber it. Only run when the row is still sitting at pending.
    if (skipIfNotPending) {
      let ext = doc.extracted_data;
      if (typeof ext === "string") {
        try {
          ext = JSON.parse(ext);
        } catch {
          ext = null;
        }
      }
      const status = ext?.extraction_status;
      if (status && status !== "pending") {
        return { success: true, skipped: true, reason: `status=${status}` };
      }
      // Thick extractions without extraction_status field — client already
      // finished and stripped the flag. Skip to avoid duplicate work.
      if (ext && !status && (ext.panels || ext.medications || ext.findings || ext.impression)) {
        return { success: true, skipped: true, reason: "already-extracted" };
      }
    }

    // Flip to pending so polling clients flip the pill to "Extracting…".
    await pool.query(`UPDATE documents SET extracted_data = $1::jsonb WHERE id = $2`, [
      JSON.stringify({ extraction_status: "pending" }),
      docId,
    ]);

    const resolved = await resolveDocumentUrl(docId);
    if (resolved.error) {
      const failPayload = {
        extraction_status: "failed",
        error_message: `File unavailable: ${resolved.error}`,
        retry_count: 0,
        failed_at: new Date().toISOString(),
      };
      await pool.query(`UPDATE documents SET extracted_data = $1::jsonb WHERE id = $2`, [
        JSON.stringify(failPayload),
        docId,
      ]);
      return { success: false, ...failPayload };
    }

    let buffer, base64, mediaType;
    if (resolved.buffer) {
      buffer = resolved.buffer;
      base64 = Buffer.from(buffer).toString("base64");
      mediaType = detectMediaType(buffer) || resolved.mimeType || "application/pdf";
    } else if (resolved.url) {
      const fileResp = await fetch(resolved.url);
      if (!fileResp.ok) {
        const failPayload = {
          extraction_status: "failed",
          error_message: `File download failed (${fileResp.status})`,
          retry_count: 0,
          failed_at: new Date().toISOString(),
        };
        await pool.query(`UPDATE documents SET extracted_data = $1::jsonb WHERE id = $2`, [
          JSON.stringify(failPayload),
          docId,
        ]);
        return { success: false, ...failPayload };
      }
      buffer = Buffer.from(await fileResp.arrayBuffer());
      base64 = buffer.toString("base64");
      mediaType = detectMediaType(buffer) || resolved.mimeType || "application/pdf";
    } else {
      const failPayload = {
        extraction_status: "failed",
        error_message: "No file attached to this document",
        retry_count: 0,
        failed_at: new Date().toISOString(),
      };
      await pool.query(`UPDATE documents SET extracted_data = $1::jsonb WHERE id = $2`, [
        JSON.stringify(failPayload),
        docId,
      ]);
      return { success: false, ...failPayload };
    }

    let extracted, attempts;
    try {
      const result = await extractWithRetry({ base64, mediaType, docType: doc.doc_type });
      extracted = result.data;
      attempts = result.attempts;
    } catch (e) {
      const failPayload = {
        extraction_status: "failed",
        error_message: e.message || "Extraction failed",
        retry_count: e.attempts || 3,
        failed_at: new Date().toISOString(),
      };
      await pool.query(`UPDATE documents SET extracted_data = $1::jsonb WHERE id = $2`, [
        JSON.stringify(failPayload),
        docId,
      ]);
      console.error(`[extract] Doc ${docId} failed after retries: ${e.message}`);
      return { success: false, ...failPayload };
    }

    // Guard: between flipping to pending and finishing extraction, the
    // client may have already written a successful extraction (companion's
    // in-memory path is usually faster). Re-check and bail if so.
    if (skipIfNotPending) {
      const { rows: freshRows } = await pool.query(
        `SELECT extracted_data FROM documents WHERE id = $1`,
        [docId],
      );
      let freshExt = freshRows[0]?.extracted_data;
      if (typeof freshExt === "string") {
        try {
          freshExt = JSON.parse(freshExt);
        } catch {
          freshExt = null;
        }
      }
      const freshStatus = freshExt?.extraction_status;
      if (freshStatus && freshStatus !== "pending" && freshStatus !== "failed") {
        return { success: true, skipped: true, reason: `client-wrote=${freshStatus}` };
      }
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`UPDATE documents SET extracted_data = $1::jsonb WHERE id = $2`, [
        JSON.stringify(extracted),
        docId,
      ]);

      if (extracted?.panels && doc.patient_id) {
        await client.query(`DELETE FROM lab_results WHERE document_id = $1`, [doc.id]);
        const testDate =
          extracted.report_date ||
          extracted.collection_date ||
          (doc.doc_date
            ? new Date(doc.doc_date).toISOString().split("T")[0]
            : new Date().toISOString().split("T")[0]);
        for (const panel of extracted.panels) {
          for (const test of panel.tests || []) {
            if (test.result == null && !test.result_text) continue;
            const numResult =
              typeof test.result === "number" ? test.result : parseFloat(test.result);
            await client.query(
              `INSERT INTO lab_results
                 (patient_id, document_id, test_date, panel_name, test_name, canonical_name, result, result_text, unit, flag, ref_range, source)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'report_extract')`,
              [
                doc.patient_id,
                doc.id,
                testDate,
                panel.panel_name || null,
                test.test_name,
                getCanonical(test.test_name) || test.test_name,
                isNaN(numResult) ? null : numResult,
                test.result_text || null,
                test.unit || null,
                test.flag || null,
                test.ref_range || null,
              ],
            );
          }
        }
        try {
          const { syncVitalsFromExtraction } = await import("../services/healthray/db.js");
          const reportDate =
            extracted.report_date ||
            extracted.collection_date ||
            (doc.doc_date ? new Date(doc.doc_date).toISOString().split("T")[0] : null);
          await syncVitalsFromExtraction(doc.patient_id, extracted, reportDate);
        } catch (syncErr) {
          console.error(
            `[extract] Vitals sync failed for patient ${doc.patient_id}:`,
            syncErr.message,
          );
        }
        try {
          const { rows: apptRows } = await client.query(
            `SELECT id FROM appointments WHERE patient_id = $1 ORDER BY appointment_date DESC LIMIT 1`,
            [doc.patient_id],
          );
          if (apptRows[0]) {
            await syncBiomarkersFromLatestLabs(doc.patient_id, apptRows[0].id);
          }
        } catch (syncErr) {
          console.error(
            `[extract] Biomarker sync failed for patient ${doc.patient_id}:`,
            syncErr.message,
          );
        }
      }

      if (doc.patient_id && extracted?.medications) {
        await client.query(`DELETE FROM medications WHERE document_id = $1`, [doc.id]);
        const rxDate =
          extracted.visit_date ||
          (doc.doc_date
            ? new Date(doc.doc_date).toISOString().split("T")[0]
            : new Date().toISOString().split("T")[0]);
        for (const m of extracted.medications || []) {
          if (!m?.name) continue;
          const { name: cleanName, form: detectedForm } = stripFormPrefix(m.name);
          const storedName = cleanName || m.name;
          const storedRoute = m.route || routeForForm(detectedForm) || "Oral";
          await client.query(
            `INSERT INTO medications
               (patient_id, document_id, name, pharmacy_match, dose, frequency, timing, route, is_new, is_active, source, started_date)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, true, 'report_extract', $9)
             ON CONFLICT (patient_id, UPPER(COALESCE(pharmacy_match, name))) WHERE is_active = true
             DO UPDATE SET document_id = EXCLUDED.document_id,
               pharmacy_match = COALESCE(EXCLUDED.pharmacy_match, medications.pharmacy_match),
               dose = COALESCE(EXCLUDED.dose, medications.dose),
               frequency = COALESCE(EXCLUDED.frequency, medications.frequency),
               timing = COALESCE(EXCLUDED.timing, medications.timing),
               route = COALESCE(EXCLUDED.route, medications.route),
               source = EXCLUDED.source,
               started_date = LEAST(medications.started_date, EXCLUDED.started_date),
               updated_at = NOW()`,
            [
              doc.patient_id,
              doc.id,
              storedName.slice(0, 200),
              canonicalMedKey(storedName).slice(0, 200),
              (m.dose || "").slice(0, 100),
              (m.frequency || "").slice(0, 100),
              (m.timing || "").slice(0, 100),
              storedRoute.slice(0, 50),
              rxDate,
            ],
          );
        }
        for (const m of extracted.stopped_medications || []) {
          if (!m?.name) continue;
          const { name: cleanName } = stripFormPrefix(m.name);
          const storedName = cleanName || m.name;
          await client.query(
            `INSERT INTO medications
               (patient_id, document_id, name, pharmacy_match, is_new, is_active, source, started_date)
             VALUES ($1, $2, $3, $4, false, false, 'report_extract', $5)
             ON CONFLICT (patient_id, UPPER(COALESCE(pharmacy_match, name))) WHERE is_active = false
             DO UPDATE SET document_id = EXCLUDED.document_id,
               pharmacy_match = COALESCE(EXCLUDED.pharmacy_match, medications.pharmacy_match),
               source = EXCLUDED.source,
               updated_at = NOW()`,
            [
              doc.patient_id,
              doc.id,
              storedName.slice(0, 200),
              canonicalMedKey(storedName).slice(0, 200),
              rxDate,
            ],
          );
        }
        for (const d of extracted.diagnoses || []) {
          if (!d?.id || !d?.label) continue;
          await client.query(
            `INSERT INTO diagnoses (patient_id, diagnosis_id, label, status)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (patient_id, diagnosis_id) DO UPDATE
               SET label = EXCLUDED.label, status = EXCLUDED.status`,
            [doc.patient_id, d.id, d.label, d.status || "Controlled"],
          );
        }
        if (extracted.follow_up) {
          const anchor =
            extracted.visit_date ||
            (doc.doc_date ? new Date(doc.doc_date).toISOString().split("T")[0] : null);
          await syncFollowUpToAppointment(client, doc.patient_id, extracted.follow_up, anchor);
        }
        await refreshOpdConsultations(client, doc.patient_id);
      }

      await client.query("COMMIT");

      if (doc.patient_id) {
        syncDocumentsToGenie(doc.patient_id, pool).catch((e) =>
          console.warn("[extract] Genie doc push skipped:", e.message),
        );
        if (extracted?.panels) {
          syncLabsToGenie(doc.patient_id, pool).catch((e) =>
            console.warn("[extract] Genie labs push skipped:", e.message),
          );
        }
        if (extracted?.medications) {
          syncMedicationsToGenie(doc.patient_id, pool).catch((e) =>
            console.warn("[extract] Genie meds push skipped:", e.message),
          );
        }
      }

      if (doc.patient_id && extracted?.panels) {
        pool
          .query(
            `UPDATE appointments SET ai_summary=NULL, ai_summary_generated_at=NULL
             WHERE patient_id=$1
               AND appointment_date=(SELECT MAX(appointment_date) FROM appointments WHERE patient_id=$1)`,
            [doc.patient_id],
          )
          .catch(() => {});
      }
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }

    return { success: true, attempts, extracted_data: extracted };
  } catch (e) {
    console.error(`[extract] Doc ${docId} unexpected error:`, e);
    return { success: false, error_message: e.message || "Unknown error" };
  }
}

// ── Retry extraction for a stuck / failed document ──────────────────────────
// POST /api/documents/:id/retry-extract
// Delegates to runServerExtraction with force=true (always runs, ignores
// dedup). Callable from any doctor-facing page or the companion app.
router.post("/documents/:id/retry-extract", async (req, res) => {
  const docId = Number(req.params.id);
  if (!docId) return res.status(400).json({ error: "Valid document ID required" });
  const result = await runServerExtraction(docId, { skipIfNotPending: false });
  if (result.error_message && !result.extraction_status && !result.success) {
    return res.status(404).json({ error: result.error_message });
  }
  res.json(result);
});

export { runServerExtraction };

// ── Extract medicines from a HealthRay prescription PDF/image using Claude vision
// Shared core used by the HTTP route and one-off scripts. Uses the unified
// CLINICAL_EXTRACTION_PROMPT (same as HealthRay sync) and runs the full
// syncDiagnoses / syncStoppedMedications / syncLabResults / syncVitals /
// syncSymptoms / syncBiomarkersFromLatestLabs chain.
async function runPrescriptionExtraction(docId) {
  docId = Number(docId);
  if (!docId) return { error: "Valid document ID required", status: 400 };

  const { rows } = await pool.query(
    `SELECT id, patient_id, doc_type, file_url, doc_date FROM documents WHERE id = $1`,
    [docId],
  );
  if (!rows[0]) return { error: "Document not found", status: 404 };
  const doc = rows[0];

  if (doc.doc_type !== "prescription")
    return { error: "Document is not a prescription", status: 400 };

  // Resolve through the same path uploads/retries use — handles HealthRay auth,
  // storage_path fallback, and re-signing expired URLs. A plain fetch on
  // file_url fails with 403 for HealthRay-sourced docs.
  const resolved = await resolveDocumentUrl(docId);
  if (resolved.error) return { error: `File unavailable: ${resolved.error}`, status: 400 };

  let buffer;
  if (resolved.buffer) {
    buffer = resolved.buffer;
  } else if (resolved.url) {
    const fileResp = await fetch(resolved.url);
    if (!fileResp.ok) return { error: `File download failed (${fileResp.status})`, status: 400 };
    buffer = Buffer.from(await fileResp.arrayBuffer());
  } else {
    return { error: "No file attached to this document", status: 400 };
  }
  const base64 = Buffer.from(buffer).toString("base64");
  const extracted = await extractFromFile(base64, buffer);

  // Back-compat alias: older consumers (refreshOpdConsultations) read
  // `stopped_medications`; unified schema calls it `previous_medications`.
  if (!extracted.stopped_medications && Array.isArray(extracted.previous_medications)) {
    extracted.stopped_medications = extracted.previous_medications;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`UPDATE documents SET extracted_data = $1::jsonb WHERE id = $2`, [
      JSON.stringify(extracted),
      docId,
    ]);

    // Prescription date (clinical): what's printed on the Rx. Used everywhere
    // that needs the real clinical date — started_date, follow-up sync, labs.
    const rxDate = doc.doc_date
      ? new Date(doc.doc_date).toISOString().split("T")[0]
      : new Date().toISOString().split("T")[0];

    // Latest consultation for this patient — extracted meds get linked to it
    // so they survive the /medications/reconcile sweep (both branches skip
    // rows whose consultation_id points to the most recent consultation) AND
    // the visit page shows the correct `prescribed_date` (=
    // consultations.visit_date, which matches the Rx date for HealthRay
    // prescriptions). If the patient has no consultations yet, we skip the
    // link — the reconcile deploy fix + stale-sweep already cover that path.
    let latestConsId = null;
    if (doc.patient_id) {
      const { rows: consRows } = await client.query(
        `SELECT id FROM consultations
          WHERE patient_id = $1
          ORDER BY visit_date DESC NULLS LAST, id DESC
          LIMIT 1`,
        [doc.patient_id],
      );
      latestConsId = consRows[0]?.id || null;
    }

    if (doc.patient_id && extracted.follow_up) {
      await syncFollowUpToAppointment(client, doc.patient_id, extracted.follow_up, rxDate);
    }

    // Match an appointment by patient + date (±1 day) so appt-scoped syncs
    // (vitals, symptoms, biomarkers) can attach. It's fine if none exists —
    // diagnoses/labs/medications still sync at patient scope.
    let apptId = null;
    if (doc.patient_id) {
      const { rows: apptRows } = await client.query(
        `SELECT id FROM appointments
           WHERE patient_id = $1
             AND appointment_date::date BETWEEN ($2::date - INTERVAL '1 day')
                                           AND ($2::date + INTERVAL '1 day')
           ORDER BY appointment_date DESC LIMIT 1`,
        [doc.patient_id, rxDate],
      );
      apptId = apptRows[0]?.id || null;
    }

    // Synthetic healthray-style scope ID so sync helpers can tag rows to this doc
    const scopeId = `opd-doc-${docId}`;

    // Medications — keep document-scoped upsert so deleting the doc can clean up.
    //
    // Three pitfalls we guard against, because the user reported missing meds:
    //   1. Same canonical key twice in the current list (same brand at two
    //      strengths, or Claude returning a morning+evening split as two
    //      rows): the unique index
    //      (patient_id, UPPER(COALESCE(pharmacy_match, name))) WHERE is_active
    //      lets only ONE active row survive. Second INSERT's DO UPDATE
    //      overwrites the first's dose/frequency → a medicine is lost.
    //      Merge those in JS before insert, combining doses/frequencies.
    //   2. Silent `.catch(() => {})` hid all errors. Log every failure.
    //   3. `previous_medications` (stopped/dose-changed) was only reaching
    //      the DB via post-commit syncStoppedMedications, which writes rows
    //      WITHOUT document_id. Doc-scoped medication listings on the visit
    //      page then missed them. Now we also insert previous_medications
    //      as inactive rows scoped to this document.
    const prescriptionMeds = Array.isArray(extracted.medications) ? extracted.medications : [];
    const prevMeds = Array.isArray(extracted.previous_medications)
      ? extracted.previous_medications
      : Array.isArray(extracted.stopped_medications)
        ? extracted.stopped_medications
        : [];

    if (doc.patient_id && (prescriptionMeds.length > 0 || prevMeds.length > 0)) {
      await client.query(`DELETE FROM medications WHERE document_id = $1`, [docId]);

      const join = (a, b) => {
        if (!a) return b || "";
        if (!b || a === b) return a;
        return a.includes(b) ? a : `${a} / ${b}`;
      };
      const buildMerged = (list) => {
        const map = new Map();
        for (const m of list) {
          if (!m?.name) continue;
          const { name: cleanName, form: detectedForm } = stripFormPrefix(m.name);
          const storedName = (cleanName || m.name).slice(0, 200);
          const canonical = canonicalMedKey(storedName).slice(0, 200);
          const key = canonical || storedName.toUpperCase();
          const route = (m.route || routeForForm(detectedForm) || "Oral").slice(0, 50);
          const existing = map.get(key);
          if (!existing) {
            map.set(key, {
              storedName,
              canonical,
              dose: m.dose || "",
              frequency: m.frequency || "",
              timing: m.timing || "",
              route,
              status: m.status || null,
              reason: m.reason || null,
            });
          } else {
            existing.dose = join(existing.dose, m.dose || "");
            existing.frequency = join(existing.frequency, m.frequency || "");
            existing.timing = join(existing.timing, m.timing || "");
            if (!existing.route || existing.route === "Oral") existing.route = route;
            existing.status = existing.status || m.status || null;
            existing.reason = existing.reason || m.reason || null;
          }
        }
        return map;
      };

      const currentByKey = buildMerged(prescriptionMeds);
      const prevByKey = buildMerged(prevMeds);
      // A drug appearing in both current and previous = dose/frequency change,
      // not a stop. Keep it only in the active list.
      for (const k of currentByKey.keys()) prevByKey.delete(k);

      // Historical started_date lookup — see services/medication/historicalStart.js
      const earliestByKey = await findEarliestStartDates(
        client,
        doc.patient_id,
        [...currentByKey.keys(), ...prevByKey.keys()],
        docId,
      );
      const resolveStarted = (canonical) => resolveStartedDate(earliestByKey, canonical, rxDate);

      let okCur = 0,
        failCur = 0;
      for (const [, m] of currentByKey) {
        try {
          await client.query(
            `INSERT INTO medications
                 (patient_id, document_id, consultation_id, name, pharmacy_match, dose, frequency, timing, route, is_new, is_active, source, started_date)
               VALUES ($1, $2, $10, $3, $4, $5, $6, $7, $8, false, true, 'report_extract', $9)
               ON CONFLICT (patient_id, UPPER(COALESCE(pharmacy_match, name))) WHERE is_active = true
               DO UPDATE SET document_id = EXCLUDED.document_id,
                 consultation_id = EXCLUDED.consultation_id,
                 pharmacy_match = COALESCE(EXCLUDED.pharmacy_match, medications.pharmacy_match),
                 dose = COALESCE(NULLIF(EXCLUDED.dose, ''), medications.dose),
                 frequency = COALESCE(NULLIF(EXCLUDED.frequency, ''), medications.frequency),
                 timing = COALESCE(NULLIF(EXCLUDED.timing, ''), medications.timing),
                 route = COALESCE(NULLIF(EXCLUDED.route, ''), medications.route),
                 name = EXCLUDED.name,
                 source = EXCLUDED.source,
                 started_date = LEAST(medications.started_date, EXCLUDED.started_date),
                 updated_at = NOW()`,
            [
              doc.patient_id,
              docId,
              m.storedName,
              m.canonical,
              m.dose.slice(0, 100),
              m.frequency.slice(0, 100),
              m.timing.slice(0, 100),
              m.route,
              resolveStarted(m.canonical),
              latestConsId,
            ],
          );
          okCur += 1;
        } catch (e) {
          failCur += 1;
          console.error(
            `[extract-prescription] active med insert failed doc=${docId} patient=${doc.patient_id} name="${m.storedName}" canonical="${m.canonical}": ${e.message}`,
          );
        }
      }

      let okPrev = 0,
        failPrev = 0;
      for (const [, m] of prevByKey) {
        const stopReason = `report_extract:${docId}${
          m.reason ? " — " + m.reason : m.status ? " — " + m.status : ""
        }`;
        try {
          // Deactivate any currently-active row with the same canonical (in
          // case a prior extraction had marked it active), then insert the
          // inactive doc-scoped row. DO NOTHING on conflict with the
          // inactive partial unique index so we never crash — the UPDATE
          // branch above already handled the live side.
          await client.query(
            `UPDATE medications
                  SET is_active = false,
                      stopped_date = CURRENT_DATE,
                      stop_reason = $3,
                      updated_at = NOW()
                WHERE patient_id = $1
                  AND UPPER(COALESCE(pharmacy_match, name)) = $2
                  AND is_active = true`,
            [doc.patient_id, m.canonical || m.storedName.toUpperCase(), stopReason],
          );
          await client.query(
            `INSERT INTO medications
                 (patient_id, document_id, consultation_id, name, pharmacy_match, dose, frequency, timing, route,
                  is_new, is_active, source, started_date, stopped_date, stop_reason)
               VALUES ($1, $2, $11, $3, $4, $5, $6, $7, $8,
                       false, false, 'report_extract', $9, CURRENT_DATE, $10)
               ON CONFLICT (patient_id, UPPER(COALESCE(pharmacy_match, name))) WHERE is_active = false
               DO UPDATE SET document_id = EXCLUDED.document_id,
                 consultation_id = EXCLUDED.consultation_id,
                 dose = COALESCE(NULLIF(EXCLUDED.dose, ''), medications.dose),
                 frequency = COALESCE(NULLIF(EXCLUDED.frequency, ''), medications.frequency),
                 timing = COALESCE(NULLIF(EXCLUDED.timing, ''), medications.timing),
                 route = COALESCE(NULLIF(EXCLUDED.route, ''), medications.route),
                 name = EXCLUDED.name,
                 source = EXCLUDED.source,
                 stop_reason = EXCLUDED.stop_reason,
                 stopped_date = EXCLUDED.stopped_date,
                 updated_at = NOW()`,
            [
              doc.patient_id,
              docId,
              m.storedName,
              m.canonical,
              m.dose.slice(0, 100),
              m.frequency.slice(0, 100),
              m.timing.slice(0, 100),
              m.route,
              resolveStarted(m.canonical),
              stopReason,
              latestConsId,
            ],
          );
          okPrev += 1;
        } catch (e) {
          failPrev += 1;
          console.error(
            `[extract-prescription] stopped med insert failed doc=${docId} patient=${doc.patient_id} name="${m.storedName}" canonical="${m.canonical}": ${e.message}`,
          );
        }
      }

      // ── Stale-med sweep ───────────────────────────────────────────────
      // Deactivate any active meds for this patient that the new
      // prescription doesn't mention (neither current nor previous).
      // Only touches auto-synced rows (source in report_extract/healthray);
      // manually-added rows (source NULL / 'manual' / 'scribe' / 'consultation'
      // / 'opd_upload') are preserved.
      //
      // Safety: skip the sweep entirely when the extraction produced zero
      // medications AND zero previous_medications — mirrors
      // stopStaleHealthrayMeds which refuses to sweep against an empty
      // prescription (prevents a failed Claude call from wiping the regimen).
      let staleSwept = 0;
      if (currentByKey.size > 0 || prevByKey.size > 0) {
        const keepKeys = [...currentByKey.keys(), ...prevByKey.keys()];
        const stopReason = `report_extract:${docId} — not in latest prescription`;

        // Phase 1: DELETE inactive-row collisions that would block the UPDATE
        // (same canonical already sits inactive). Same pattern as
        // stopStaleHealthrayMeds:1209-1246.
        await client
          .query(
            `DELETE FROM medications
                WHERE patient_id = $1
                  AND is_active = false
                  AND UPPER(COALESCE(pharmacy_match, name)) IN (
                    SELECT UPPER(COALESCE(pharmacy_match, name))
                      FROM medications
                     WHERE patient_id = $1
                       AND is_active = true
                       AND source IN ('report_extract', 'healthray')
                       AND UPPER(COALESCE(pharmacy_match, name)) <> ALL($2::text[])
                       AND (document_id IS NULL OR document_id <> $3)
                  )`,
            [doc.patient_id, keepKeys, docId],
          )
          .catch((e) =>
            console.error(
              `[extract-prescription] stale-sweep DELETE failed doc=${docId} patient=${doc.patient_id}: ${e.message}`,
            ),
          );

        // Phase 2: deactivate the stale active rows.
        const sweepRes = await client
          .query(
            `UPDATE medications
                  SET is_active = false,
                      stopped_date = $4::date,
                      stop_reason = $5,
                      updated_at = NOW()
                WHERE patient_id = $1
                  AND is_active = true
                  AND source IN ('report_extract', 'healthray')
                  AND UPPER(COALESCE(pharmacy_match, name)) <> ALL($2::text[])
                  AND (document_id IS NULL OR document_id <> $3)`,
            [doc.patient_id, keepKeys, docId, rxDate, stopReason],
          )
          .catch((e) => {
            console.error(
              `[extract-prescription] stale-sweep UPDATE failed doc=${docId} patient=${doc.patient_id}: ${e.message}`,
            );
            return { rowCount: 0 };
          });
        staleSwept = sweepRes?.rowCount || 0;
      }

      console.log(
        `[extract-prescription] doc=${docId} meds: ` +
          `current extracted=${prescriptionMeds.length} merged=${currentByKey.size} inserted=${okCur} failed=${failCur} | ` +
          `previous extracted=${prevMeds.length} merged=${prevByKey.size} inserted=${okPrev} failed=${failPrev} | ` +
          `stale swept=${staleSwept}`,
      );
    }

    await client.query("COMMIT");

    // ── Post-commit: pool-based sync helpers mirror HealthRay flow ──
    if (doc.patient_id) {
      try {
        await syncDiagnoses(doc.patient_id, scopeId, extracted.diagnoses || [], {
          sweepStale: true,
        });
        await syncStoppedMedications(
          doc.patient_id,
          scopeId,
          extracted.previous_medications || extracted.stopped_medications || [],
          extracted.medications || [],
        );
        await syncLabResults(doc.patient_id, apptId, rxDate, extracted.labs || []);

        // Vitals — pick the dated entry matching rxDate (unified schema is an array)
        const vitalsArr = Array.isArray(extracted.vitals) ? extracted.vitals : [];
        const todaysVitals = vitalsArr.find((v) => v && v.date === rxDate) || vitalsArr[0] || null;
        if (apptId && todaysVitals) {
          await syncVitals(doc.patient_id, apptId, rxDate, {
            bpSys: todaysVitals.bpSys,
            bpDia: todaysVitals.bpDia,
            weight: todaysVitals.weight,
            height: todaysVitals.height,
            bmi: todaysVitals.bmi,
            waist: todaysVitals.waist,
            bodyFat: todaysVitals.bodyFat,
          });
        }

        if (apptId) {
          await syncSymptoms(doc.patient_id, apptId, extracted.symptoms || []);
          await syncBiomarkersFromLatestLabs(doc.patient_id, apptId);
        }
      } catch (syncErr) {
        // Don't fail the request — extraction itself already committed
        console.error("extract-prescription post-sync:", syncErr.message);
      }
    }

    return {
      success: true,
      documentId: docId,
      medicinesExtracted: extracted.medications?.length || 0,
      diagnosesExtracted: extracted.diagnoses?.length || 0,
      symptomsExtracted: extracted.symptoms?.length || 0,
      labsExtracted: extracted.labs?.length || 0,
      vitalsExtracted: Array.isArray(extracted.vitals) ? extracted.vitals.length : 0,
      medicines: extracted.medications || [],
    };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export { runPrescriptionExtraction };

// POST /api/documents/:id/extract-prescription
router.post("/documents/:id/extract-prescription", async (req, res) => {
  try {
    const result = await runPrescriptionExtraction(req.params.id);
    if (result?.error) return res.status(result.status || 500).json({ error: result.error });
    res.json(result);
  } catch (e) {
    handleError(res, e, "Extract prescription PDF");
  }
});

// ── Mark a document as reviewed by the doctor ────────────────────────────────
router.patch("/documents/:id/reviewed", async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE documents SET reviewed=TRUE WHERE id=$1 RETURNING id, reviewed`,
      [req.params.id],
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Not found" });
    res.json(result.rows[0]);
  } catch (e) {
    handleError(res, e, "Mark document reviewed");
  }
});

// List all docs across patients that are awaiting mismatch review.
// Used by the companion bell/notification icon.
router.get("/companion/mismatch-reviews", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT d.id,
              d.patient_id,
              d.title,
              d.doc_type,
              d.doc_date,
              d.extracted_data,
              d.created_at,
              p.name AS patient_name,
              p.file_no AS patient_file_no
         FROM documents d
         JOIN patients p ON p.id = d.patient_id
        WHERE d.extracted_data->>'extraction_status' = 'mismatch_review'
        ORDER BY d.created_at DESC
        LIMIT 100`,
    );
    res.json(rows);
  } catch (e) {
    handleError(res, e, "List mismatch reviews");
  }
});

// Delete a document and its file from storage
router.delete("/documents/:id", async (req, res) => {
  try {
    const doc = await pool.query("SELECT * FROM documents WHERE id=$1", [req.params.id]);
    if (!doc.rows[0]) return res.status(404).json({ error: "Not found" });

    // Delete file from Supabase Storage if it exists
    if (doc.rows[0].storage_path && SUPABASE_URL && SUPABASE_SERVICE_KEY) {
      await fetch(
        `${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${doc.rows[0].storage_path}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
        },
      ).catch(() => {}); // Don't fail if storage delete fails
    }

    const deletedDoc = doc.rows[0];

    // Remove synced records linked to this document
    await pool.query("DELETE FROM lab_results WHERE document_id=$1", [req.params.id]);
    await pool.query("DELETE FROM medications WHERE document_id=$1", [req.params.id]);
    await pool.query("DELETE FROM documents WHERE id=$1", [req.params.id]);

    // Refresh OPD consultations with remaining prescription data
    if (deletedDoc.patient_id && deletedDoc.doc_type === "prescription") {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await refreshOpdConsultations(client, deletedDoc.patient_id);
        await client.query("COMMIT");
      } catch (e2) {
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    }

    res.json({ success: true });
  } catch (e) {
    handleError(res, e, "Document delete");
  }
});

// ── Backfill: re-download HealthRay docs that are blurry thumbnails or missing ─
// POST /api/admin/backfill-healthray-docs
// Query params: ?limit=50&patient_id=<optional>&today=1 (today's patients only)
router.post("/admin/backfill-healthray-docs", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || "50", 10), 500);
    let patientFilter = "";
    if (req.query.patient_id) {
      patientFilter = `AND patient_id = ${parseInt(req.query.patient_id, 10)}`;
    } else if (req.query.today === "1") {
      patientFilter = `AND patient_id IN (
        SELECT DISTINCT patient_id FROM appointments
        WHERE appointment_date::date = CURRENT_DATE AND patient_id IS NOT NULL
      )`;
    }

    // Find docs that are either: blurry JPEG thumbnails stored in Supabase, or never downloaded
    const { rows: docs } = await pool.query(
      `SELECT id, patient_id, file_name, file_url, mime_type, storage_path, notes
       FROM documents
       WHERE source = 'healthray'
         AND (storage_path IS NULL OR mime_type = 'image/jpeg')
         ${patientFilter}
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit],
    );

    if (docs.length === 0) {
      return res.json({
        message: "No documents need backfilling",
        processed: 0,
        success: 0,
        failed: 0,
      });
    }

    let success = 0;
    let failed = 0;
    let skipped = 0;
    const errors = [];

    for (const doc of docs) {
      try {
        const notesStr = doc.notes || "";
        // Parse attachment ID (healthray_record:12345)
        const attachmentId = notesStr.match(/healthray_record:(\d+)/)?.[1];
        // Parse medical_record_id (healthray_mrid:12345) — stored for recently synced docs
        let medicalRecordId = notesStr.match(/healthray_mrid:(\d+)/)?.[1] || null;
        // Parse record type (healthray_rtype:Prescription/Rx)
        const recordType = notesStr.match(/healthray_rtype:([^|]+)/)?.[1] || "Prescription/Rx";
        // Parse appointment ID (healthray_appt:12345)
        const healthrayApptId = notesStr.match(/healthray_appt:(\d+)/)?.[1] || null;

        if (!attachmentId) {
          skipped++;
          continue;
        }

        // If medical_record_id missing, try fetching from HealthRay using appointment ID
        // Works for today's appointments only — historical ones return 422
        if (!medicalRecordId) {
          // Prefer appt ID from notes; fall back to today's appointment for this patient
          let candidateApptIds = healthrayApptId ? [healthrayApptId] : [];
          if (candidateApptIds.length === 0) {
            const { rows: apptRows } = await pool
              .query(
                `SELECT healthray_id FROM appointments
               WHERE patient_id = $1
                 AND appointment_date::date = CURRENT_DATE
                 AND healthray_id IS NOT NULL
               ORDER BY appointment_date DESC`,
                [doc.patient_id],
              )
              .catch(() => ({ rows: [] }));
            for (const r of apptRows) candidateApptIds.push(r.healthray_id);
          }

          for (const apptId of candidateApptIds) {
            try {
              const records = await fetchMedicalRecords(apptId);
              if (Array.isArray(records)) {
                const match = records.find((r) => String(r.id) === String(attachmentId));
                if (match?.medical_record_id) {
                  medicalRecordId = String(match.medical_record_id);
                  // Back-fill notes for future runs
                  const newNotes = [
                    notesStr.replace(/\|?healthray_mrid:\d+/, ""),
                    `healthray_mrid:${medicalRecordId}`,
                  ]
                    .filter(Boolean)
                    .join("|");
                  await pool
                    .query(`UPDATE documents SET notes = $1 WHERE id = $2`, [newNotes, doc.id])
                    .catch(() => {});
                  break;
                }
              }
            } catch (e) {
              // Historical appointment — API returns error, try next
            }
          }
        }

        if (!medicalRecordId) {
          // Can't download actual PDF without medical_record_id — skip
          skipped++;
          continue;
        }

        const storagePath = await downloadAndStore(
          doc.patient_id,
          doc.id,
          doc.file_url,
          doc.file_name,
          attachmentId,
          recordType,
          medicalRecordId,
        );

        if (storagePath) {
          success++;
        } else {
          failed++;
          errors.push(`doc ${doc.id}: downloadAndStore returned null`);
        }
      } catch (e) {
        failed++;
        errors.push(`doc ${doc.id}: ${e.message}`);
      }
    }

    res.json({
      message: `Backfill complete`,
      total: docs.length,
      success,
      failed,
      skipped,
      errors: errors.slice(0, 20),
    });
  } catch (e) {
    handleError(res, e, "Backfill healthray docs");
  }
});

export default router;
