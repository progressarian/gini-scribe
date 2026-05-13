// Auto-save prescription PDF when a visit/appointment completes.
//
// Two entry points:
//   savePrescriptionForVisit(pid, payload, opts)
//     Renders the Rx (Puppeteer) and persists it to documents + Supabase
//     storage + Genie. Idempotent — skips if a prescription row already
//     exists for this patient + consultation + source.
//
//   buildVisitPayloadFromDb(pid, { appointmentId })
//     Reconstructs the canonical visit payload (same shape the front-end
//     POSTs from /visit) from the DB. Used by completion paths that don't
//     have a client-side payload (HealthRay sync, status PATCH, etc.).
//
// The renderer (generatePrescriptionPdf) and template are shared with the
// in-app End Visit flow so the PDF format is identical regardless of which
// path triggered the save.
import { createRequire } from "module";
import pool from "../config/db.js";
import { t } from "../utils/helpers.js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY, STORAGE_BUCKET } from "../config/storage.js";
import { sanitizeForStorageKey } from "../utils/storageKey.js";
import { generatePrescriptionPdf, buildPrescriptionFileName } from "./prescriptionHtmlPdf.js";
import { getCanonical } from "../utils/labCanonical.js";
import { computeCarePhase } from "../utils/carePhase.js";
import { generatePatientSummary } from "./patientSummaryAI.js";

const require = createRequire(import.meta.url);
// Outbound Genie sync removed 2026-05-01 — dual-DB routing replaces it.
const syncDocumentsToGenie = null;

// Returns a row already saved for this consultation/source, or null.
async function findExistingPrescription(client, pid, consultationId, source) {
  const r = await client.query(
    `SELECT id, patient_id, consultation_id, doc_type, title, file_name, doc_date,
            source, notes, extracted_data, storage_path, file_url, mime_type, created_at
       FROM documents
      WHERE patient_id = $1
        AND consultation_id IS NOT DISTINCT FROM $2
        AND doc_type = 'prescription'
        AND source = $3
      ORDER BY created_at DESC
      LIMIT 1`,
    [pid, consultationId, source],
  );
  return r.rows[0] || null;
}

export async function savePrescriptionForVisit(pid, payload, opts = {}) {
  const {
    source = "visit",
    appointmentId = null,
    consultationId: consultationIdOverride = null,
    clientInitiated = false,
  } = opts;

  if (!pid) throw new Error("savePrescriptionForVisit: missing patient id");
  const data = payload || {};

  // Resolve consultation id: explicit override → latest consultation for patient.
  let consultationId = consultationIdOverride;
  if (consultationId == null) {
    const latestCon = await pool.query(
      `SELECT id FROM consultations WHERE patient_id = $1
        ORDER BY visit_date DESC, created_at DESC LIMIT 1`,
      [pid],
    );
    consultationId = latestCon.rows[0]?.id || null;
  }

  // Idempotency — never write a second prescription for the same consultation+source.
  const existing = await findExistingPrescription(pool, pid, consultationId, source);
  if (existing) {
    return {
      document: existing,
      file_name: existing.file_name,
      storage_path: existing.storage_path || null,
      skipped: true,
      reason: "already-saved",
    };
  }

  // Empty-data guard for non-client-initiated saves: skip if there are no meds
  // and no diagnoses to render. Doctors who explicitly end a visit always save,
  // even if the payload is sparse.
  if (!clientInitiated) {
    const noMeds = !Array.isArray(data.activeMeds) || data.activeMeds.length === 0;
    const noDx = !Array.isArray(data.activeDx) || data.activeDx.length === 0;
    if (noMeds && noDx) {
      console.warn(
        `[prescriptionAutoSave] Skipping pid=${pid} appt=${appointmentId} — empty meds & diagnoses`,
      );
      return {
        document: null,
        file_name: null,
        storage_path: null,
        skipped: true,
        reason: "empty-payload",
      };
    }
  }

  // Generate patient summary before PDF if not already present in payload.
  if (!data.visitSummaryText) {
    try {
      const summaryResult = await generatePatientSummary(data);
      data = { ...data, visitSummaryText: summaryResult.body };
      // Persist back to appointments so future fetches see it.
      if (appointmentId) {
        pool.query(
          "UPDATE appointments SET post_visit_summary=$1 WHERE id=$2",
          [summaryResult.body, appointmentId],
        ).catch((e) =>
          console.warn("[prescriptionAutoSave] post_visit_summary update skipped:", e.message),
        );
      }
    } catch (summaryErr) {
      console.warn("[prescriptionAutoSave] Summary generation skipped:", summaryErr.message);
    }
  }

  const doctorName = data?.doctor?.name || "doctor";
  const pdfBuffer = await generatePrescriptionPdf(data);
  const fileName = buildPrescriptionFileName(doctorName);
  const now = new Date();
  const istParts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  })
    .formatToParts(now)
    .reduce((acc, p) => ((acc[p.type] = p.value), acc), {});
  const dateLabel = `${istParts.year}-${istParts.month}-${istParts.day}`;
  const timeLabel = `${istParts.hour}:${istParts.minute} ${(istParts.dayPeriod || "").toUpperCase()}`;
  const doctorLabel = (data?.doctor?.name || "").trim();
  const doctorSegment = doctorLabel
    ? ` — ${/^dr\.?\s/i.test(doctorLabel) ? doctorLabel : `Dr. ${doctorLabel}`}`
    : "";
  const title = `Prescription${doctorSegment} — Visit — ${dateLabel} ${timeLabel}`;

  const ins = await pool.query(
    `INSERT INTO documents
       (patient_id, consultation_id, doc_type, title, file_name, doc_date,
        source, notes, extracted_data)
     VALUES ($1,$2,'prescription',$3,$4,CURRENT_DATE,
             $5,$6,$7::jsonb)
     RETURNING *`,
    [
      pid,
      consultationId,
      t(title, 200),
      t(fileName, 200),
      source,
      clientInitiated
        ? "Generated on visit completion"
        : "Auto-generated on appointment completion",
      JSON.stringify(data),
    ],
  );
  const docRow = ins.rows[0];

  if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
    const safeName = sanitizeForStorageKey(fileName);
    const storagePath = `patients/${pid}/prescription/${Date.now()}_${safeName}`;
    try {
      const uploadResp = await fetch(
        `${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${storagePath}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
            "Content-Type": "application/pdf",
            "x-upsert": "true",
          },
          body: pdfBuffer,
        },
      );
      if (uploadResp.ok) {
        await pool.query(
          "UPDATE documents SET storage_path=$1, mime_type='application/pdf' WHERE id=$2",
          [storagePath, docRow.id],
        );
        docRow.storage_path = storagePath;
        docRow.mime_type = "application/pdf";
      } else {
        const errText = await uploadResp.text().catch(() => "");
        console.warn(
          "[prescriptionAutoSave] PDF upload failed:",
          uploadResp.status,
          errText.slice(0, 200),
        );
      }
    } catch (uploadErr) {
      console.warn("[prescriptionAutoSave] PDF upload error:", uploadErr.message);
    }
  }

  if (consultationId) {
    pool
      .query("UPDATE consultations SET status='completed' WHERE id=$1", [consultationId])
      .catch((e) =>
        console.warn("[prescriptionAutoSave] consultation status update skipped:", e.message),
      );
  }

  if (syncDocumentsToGenie) {
    syncDocumentsToGenie(pid, pool).catch((e) =>
      console.warn("[prescriptionAutoSave] Genie doc push skipped:", e.message),
    );
  }

  return {
    document: docRow,
    file_name: fileName,
    storage_path: docRow.storage_path || null,
    skipped: false,
  };
}

// Build the same payload shape the front end POSTs to /visit/:pid/complete,
// pulled from current DB state. Called from cron/sync paths where no client
// payload exists.
export async function buildVisitPayloadFromDb(pid, { appointmentId } = {}) {
  if (!pid) return null;

  const [
    patientR,
    apptR,
    activeMedsR,
    activeDxR,
    vitalsR,
    labsR,
    consultationsR,
    goalsR,
    followupApptR,
  ] = await Promise.all([
    pool.query("SELECT * FROM patients WHERE id=$1", [pid]),
    appointmentId
      ? pool.query(
          `SELECT id, doctor_name, appointment_date, post_visit_summary
             FROM appointments WHERE id=$1`,
          [appointmentId],
        )
      : pool.query(
          `SELECT id, doctor_name, appointment_date, post_visit_summary
             FROM appointments WHERE patient_id=$1
            ORDER BY appointment_date DESC NULLS LAST, id DESC LIMIT 1`,
          [pid],
        ),
    pool.query(
      `SELECT m.*, c.con_name AS prescriber,
              COALESCE(c.visit_date, m.started_date) AS prescribed_date,
              COALESCE(m.last_prescribed_date, c.visit_date, m.started_date) AS last_prescribed_date
         FROM medications m LEFT JOIN consultations c ON c.id = m.consultation_id
        WHERE m.patient_id=$1 AND m.is_active = true
        ORDER BY COALESCE(c.visit_date, m.started_date) DESC, m.created_at DESC`,
      [pid],
    ),
    pool.query(
      `SELECT DISTINCT ON (diagnosis_id) * FROM diagnoses
        WHERE patient_id=$1 AND is_active != false
        ORDER BY diagnosis_id, updated_at DESC`,
      [pid],
    ),
    pool.query(
      `SELECT * FROM vitals WHERE patient_id=$1
        ORDER BY recorded_at DESC LIMIT 2`,
      [pid],
    ),
    pool.query(
      `SELECT id, patient_id, appointment_id, test_date, test_name, canonical_name,
              result, result_text, unit, ref_range, flag, is_critical, source,
              panel_name, created_at
         FROM lab_results
        WHERE patient_id=$1
          AND test_date >= NOW() - INTERVAL '5 years'
        ORDER BY test_date DESC, created_at DESC`,
      [pid],
    ),
    pool.query(
      `SELECT id, visit_date, visit_type, con_name, status, con_data, created_at
         FROM consultations
        WHERE patient_id=$1
        ORDER BY visit_date DESC, created_at DESC
        LIMIT 50`,
      [pid],
    ),
    pool.query(`SELECT * FROM goals WHERE patient_id=$1 ORDER BY status, created_at DESC`, [pid]),
    // Latest appointment carrying biomarkers.followup — same source the OPD
    // page reads, used as fallback when consultation/healthray follow-up
    // lacks a date.
    pool.query(
      `SELECT biomarkers, healthray_follow_up FROM appointments
          WHERE patient_id=$1 AND biomarkers ? 'followup'
          ORDER BY appointment_date DESC NULLS LAST, id DESC
          LIMIT 1`,
      [pid],
    ),
  ]);

  const patient = patientR.rows[0];
  if (!patient) return null;
  const appt = apptR.rows[0] || null;

  // Doctor block — appointments.doctor_name is the canonical reference for
  // who saw the patient. We don't currently join doctors metadata for the
  // template (qualification/reg_no) because the JSONB on the appointment
  // doesn't carry it; the template renders blanks gracefully.
  const doctor = { name: appt?.doctor_name || "" };

  // Lab history grouped by canonical name (mirrors GET /visit/:pid logic)
  const labHistory = {};
  for (const r of labsR.rows) {
    const key = r.canonical_name || getCanonical(r.test_name) || r.test_name;
    if (!labHistory[key]) labHistory[key] = [];
    labHistory[key].push({
      result: r.result,
      result_text: r.result_text,
      unit: r.unit,
      flag: r.flag,
      date: r.test_date,
      ref_range: r.ref_range,
      panel_name: r.panel_name,
    });
  }

  const totalVisits = consultationsR.rows.length;
  const firstVisit = consultationsR.rows[consultationsR.rows.length - 1] || null;
  const firstVisitDate = firstVisit?.visit_date || null;
  let monthsWithGini = 0;
  if (firstVisitDate) {
    const diff = Date.now() - new Date(firstVisitDate).getTime();
    monthsWithGini = Math.floor(diff / (1000 * 60 * 60 * 24 * 30));
  }
  const { carePhase } = computeCarePhase({
    labHistory,
    vitals: vitalsR.rows,
    totalVisits,
    diagnoses: activeDxR.rows,
  });

  const latestVitals = vitalsR.rows[0] || {};
  const prevVitals = vitalsR.rows[1] || {};

  const fuRow = followupApptR.rows[0] || null;
  const fuBio = fuRow?.biomarkers || {};
  const withDate = (fu) => (fu && fu.date ? fu : null);
  const followUpDate =
    withDate(fuRow?.healthray_follow_up) ||
    (fuBio.followup
      ? {
          date: fuBio.followup,
          notes: fuRow?.healthray_follow_up?.notes || null,
          timing: fuRow?.healthray_follow_up?.timing || null,
        }
      : null);

  return {
    patient,
    doctor,
    summary: { totalVisits, firstVisitDate, monthsWithGini, carePhase },
    activeDx: activeDxR.rows,
    activeMeds: activeMedsR.rows,
    latestVitals,
    prevVitals,
    labResults: labsR.rows,
    labHistory,
    consultations: consultationsR.rows,
    goals: goalsR.rows,
    appt_plan: followUpDate ? { follow_up: followUpDate } : null,
    visitSummaryText: appt?.post_visit_summary || undefined,
  };
}
