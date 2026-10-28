import { createRequire } from "module";
import pool from "../config/db.js";
import { t } from "../utils/helpers.js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY, STORAGE_BUCKET } from "../config/storage.js";
import { sanitizeForStorageKey } from "../utils/storageKey.js";
import { generatePrescriptionPdf, buildPrescriptionFileName } from "./prescriptionHtmlPdf.js";
import { getCanonical } from "../utils/labCanonical.js";
import { computeCarePhase } from "../utils/carePhase.js";
import { sortDiagnoses } from "../utils/diagnosisSort.js";
import { generatePatientSummary } from "./patientSummaryAI.js";
import { datedFollowUp, followUpDueDate } from "../../shared/followUp.js";
import { borrowedFollowUp } from "./ghmDayWindow.js";
import { appointmentComplaints, appointmentHistory } from "./giniflow/visitComplaints.js";
import { appointmentAdvice } from "./giniflow/visitAdvice.js";
import { appointmentNextVisit } from "./giniflow/visitNextVisit.js";
import { workupForPrint } from "./visit/newPatientWorkup.js";

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
        AND ($2::int IS NOT NULL OR doc_date = CURRENT_DATE)
        AND doc_type = 'prescription'
        AND source = $3
      ORDER BY created_at DESC
      LIMIT 1`,
    [pid, consultationId, source],
  );
  return r.rows[0] || null;
}

export async function rxDoctorFor(doctorName) {
  const name = String(doctorName || "").trim();
  if (!name) return null;
  const docRow = (
    await pool.query(
      `SELECT license_no, specialty, qualification FROM doctors
        WHERE lower(btrim(name)) = lower(btrim($1))
          AND COALESCE(is_active, TRUE)
        LIMIT 1`,
      [name],
    )
  ).rows[0];
  return {
    name,
    reg_no: docRow?.license_no || null,
    designation: docRow?.specialty || null,
    qualification: docRow?.qualification || null,
  };
}

export async function rxDoctorForAppointment(appointmentId, pid) {
  if (!appointmentId) return null;
  const appt = (
    await pool.query(`SELECT doctor_name FROM appointments WHERE id = $1 AND patient_id = $2`, [
      appointmentId,
      pid,
    ])
  ).rows[0];
  return rxDoctorFor(appt?.doctor_name);
}

export async function todaysAppointmentId(pid) {
  const { rows } = await pool.query(
    `SELECT id FROM appointments
      WHERE patient_id = $1
        AND appointment_date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date
        AND NULLIF(btrim(doctor_name), '') IS NOT NULL
      ORDER BY id DESC LIMIT 1`,
    [pid],
  );
  return rows[0]?.id ?? null;
}

export async function withAppointmentRxContext(pid, givenAppointmentId, data) {
  const appointmentId = givenAppointmentId || (pid ? await todaysAppointmentId(pid) : null);
  const [doctor, workup] = await Promise.all([
    rxDoctorForAppointment(appointmentId, pid),
    appointmentId ? workupForPrint(appointmentId, pid) : null,
  ]);
  return { ...data, ...(doctor && { doctor }), workup };
}

export async function savePrescriptionForVisit(pid, payload, opts = {}) {
  const {
    source = "visit",
    appointmentId = null,
    consultationId: consultationIdOverride = null,
    clientInitiated = false,
    overwrite = false,
  } = opts;

  if (!pid) throw new Error("savePrescriptionForVisit: missing patient id");
  let data = await withAppointmentRxContext(pid, appointmentId, payload || {});

  let consultationId = consultationIdOverride;
  if (consultationId == null) {
    const con = await pool.query(
      `SELECT COALESCE(
                (SELECT consultation_id FROM appointments WHERE id = $2::int AND patient_id = $1),
                (SELECT c.id FROM consultations c
                  WHERE c.patient_id = $1
                    AND c.visit_date::date = COALESCE(
                          (SELECT appointment_date FROM appointments WHERE id = $2::int),
                          CURRENT_DATE)
                  ORDER BY c.created_at DESC LIMIT 1)
              ) AS id`,
      [pid, appointmentId],
    );
    consultationId = con.rows[0]?.id || null;
  }

  const existing = await findExistingPrescription(pool, pid, consultationId, source);
  if (existing) {
    if (!overwrite) {
      return {
        document: existing,
        file_name: existing.file_name,
        storage_path: existing.storage_path || null,
        skipped: true,
        reason: "already-saved",
      };
    }
    console.log(
      `[prescriptionAutoSave] Overwriting stale prescription id=${existing.id} for pid=${pid} consultationId=${consultationId}`,
    );
  }
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

  if (!data.visitSummaryText) {
    try {
      const summaryResult = await generatePatientSummary(data);
      data = { ...data, visitSummaryText: summaryResult.body };
      // Persist back to appointments so future fetches see it.
      if (appointmentId) {
        pool
          .query("UPDATE appointments SET post_visit_summary=$1 WHERE id=$2", [
            JSON.stringify(summaryResult.body),
            appointmentId,
          ])
          .catch((e) =>
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
     VALUES ($1,$2,'prescription',$3,$4,COALESCE($8::date, CURRENT_DATE),
             $5,$6,$7::jsonb)
     RETURNING *`,
    [
      pid,
      consultationId,
      t(title, 200),
      t(fileName, 200),
      source,
      clientInitiated ? "Generated on visit completion" : null,
      JSON.stringify(data),
      data.rxDate || null,
    ],
  );
  const docRow = ins.rows[0];

  let uploadError = SUPABASE_URL && SUPABASE_SERVICE_KEY ? null : "storage not configured";

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
        uploadError = `${uploadResp.status} ${errText.slice(0, 200)}`;
        console.warn("[prescriptionAutoSave] PDF upload failed:", uploadError);
      }
    } catch (uploadErr) {
      uploadError = uploadErr.message;
      console.warn("[prescriptionAutoSave] PDF upload error:", uploadErr.message);
    }
  }

  if (existing && uploadError) {
    await pool.query("DELETE FROM documents WHERE id=$1", [docRow.id]);
    throw new Error(`Could not store the regenerated prescription (${uploadError})`);
  }
  if (existing) {
    await pool.query("DELETE FROM documents WHERE id=$1", [existing.id]);
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
    pool.query(
      `SELECT appointment_date, biomarkers, healthray_follow_up, healthray_investigations,
              follow_up_with
         FROM appointments
          WHERE patient_id=$1
            AND (biomarkers ? 'followup'
                 OR healthray_follow_up->>'date' ~ '^\\d{4}-\\d{2}-\\d{2}'
                 OR btrim(COALESCE(healthray_follow_up->>'timing', '')) <> '')
            AND NOT ${borrowedFollowUp("appointments")}
            AND COALESCE(status, '') <> 'cancelled'
            AND appointment_date <= COALESCE(
                  (SELECT appointment_date FROM appointments WHERE id=$2::int),
                  appointment_date)
          ORDER BY appointment_date DESC NULLS LAST, id DESC
          LIMIT 1`,
      [pid, appointmentId],
    ),
  ]);

  const patient = patientR.rows[0];
  if (!patient) return null;
  const appt = apptR.rows[0] || null;
  const [complaints, history, advice, floorNextVisit] = await Promise.all([
    appointmentComplaints(pid, appt?.id),
    appointmentHistory(appt?.id),
    appointmentAdvice(appt?.id),
    appointmentNextVisit(appt?.id),
  ]);

  const doctor = (await rxDoctorFor(appt?.doctor_name)) || { name: "" };

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

  const latestConsultDay = String(consultationsR.rows[0]?.visit_date || "").slice(0, 10);
  const fuCandidate = followupApptR.rows[0] || null;
  const fuRow =
    fuCandidate && !(latestConsultDay && fuCandidate.appointment_date < latestConsultDay)
      ? fuCandidate
      : null;
  const fuBio = fuRow?.biomarkers || {};
  const fuInvestigations = floorNextVisit?.tests.length
    ? floorNextVisit.tests
    : (fuRow?.healthray_investigations || []).map((t) =>
        typeof t === "string" ? { name: t, urgency: "routine" } : t,
      );
  const visitDay = String(fuRow?.appointment_date || "").slice(0, 10);
  const afterVisit = (fu) => (fu && String(fu.date || "").slice(0, 10) > visitDay ? fu : null);
  const followUpDate =
    floorNextVisit?.followUp ||
    afterVisit(datedFollowUp(fuRow?.healthray_follow_up)) ||
    afterVisit(
      fuBio.followup
        ? {
            date: fuBio.followup,
            notes: fuRow?.healthray_follow_up?.notes || null,
            timing: fuRow?.healthray_follow_up?.timing || null,
          }
        : null,
    ) ||
    afterVisit(
      followUpDueDate(fuRow?.appointment_date, fuRow?.healthray_follow_up?.timing)
        ? {
            date: followUpDueDate(fuRow.appointment_date, fuRow.healthray_follow_up.timing),
            notes: fuRow.healthray_follow_up.notes || null,
            timing: fuRow.healthray_follow_up.timing,
          }
        : null,
    );

  return {
    patient,
    doctor,
    rxDate:
      appointmentId && appt?.appointment_date ? String(appt.appointment_date).slice(0, 10) : null,
    summary: { totalVisits, firstVisitDate, monthsWithGini, carePhase },
    activeDx: sortDiagnoses(activeDxR.rows),
    complaints: complaints.map((c) => c.label),
    history,
    advice,
    activeMeds: activeMedsR.rows,
    latestVitals,
    prevVitals,
    labResults: labsR.rows,
    labHistory,
    consultations: consultationsR.rows,
    goals: goalsR.rows,
    appt_plan:
      followUpDate || fuInvestigations.length > 0 || fuRow?.follow_up_with
        ? {
            follow_up: followUpDate,
            investigations_to_order: fuInvestigations,
            follow_up_with: fuRow?.follow_up_with || fuRow?.healthray_follow_up?.notes || null,
          }
        : null,
    visitSummaryText: (() => {
      const raw = appt?.post_visit_summary;
      if (!raw) return undefined;
      // Guard against legacy rows where the full summary object was stored instead of just the body string.
      if (typeof raw === "object") return raw.body || undefined;
      return raw;
    })(),
  };
}
