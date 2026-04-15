import { Router } from "express";
import { handleError } from "../utils/errorHandler.js";
import { createLogger } from "../services/logger.js";
const { log, error } = createLogger("Backfill");
import {
  syncWalkingAppointments,
  syncTodayWalkingAppointments,
  syncWalkingAppointmentsByDate,
  syncDateRange,
  getRangeSyncStatus,
  runLabSync,
  getLabSyncStatus,
  backfillLabRanges,
  runDailyOpdBackfill,
} from "../services/cron/index.js";
import { retryPendingLabCases } from "../services/cron/labSync.js";
import { labLogin } from "../services/lab/labHealthrayApi.js";
import { readSheetTab, readUpcomingAppointments } from "../services/sheets/reader.js";
import { syncFromSheets } from "../services/cron/sheetsSync.js";
import pool from "../config/db.js";
import { parseClinicalWithAI } from "../services/healthray/parser.js";
import {
  syncDiagnoses,
  syncLabResults,
  syncMedications,
  syncStoppedMedications,
  stopStaleHealthrayMeds,
  syncBiomarkersFromLatestLabs,
} from "../services/healthray/db.js";
import { extractPrescription } from "../services/healthray/prescriptionExtractor.js";
import { normalizeTestName } from "../utils/labNormalization.js";

const router = Router();

// ── Force resync a single patient by file_no ─────────────────────────────────
// POST /api/sync/patient/:fileNo/resync
// Clears the fast-path skip flags on all appointments for the patient,
// then re-parses existing clinical notes (AI) + re-syncs normalized tables.
// For today's appointments the next 5-min cron will also re-fetch from HealthRay.
router.post("/sync/patient/:fileNo/resync", async (req, res) => {
  const fileNo = req.params.fileNo;
  try {
    const { rows: patients } = await pool.query(
      `SELECT id, name FROM patients WHERE file_no = $1 LIMIT 1`,
      [fileNo],
    );
    if (!patients[0]) return res.status(404).json({ error: `Patient ${fileNo} not found` });
    const { id: patientId, name } = patients[0];

    // Clear fast-path flags so next cron re-enriches from HealthRay
    const { rowCount: cleared } = await pool.query(
      `UPDATE appointments
       SET healthray_diagnoses    = '[]'::jsonb,
           healthray_medications  = '[]'::jsonb,
           updated_at             = NOW()
       WHERE patient_id = $1
         AND healthray_clinical_notes IS NOT NULL`,
      [patientId],
    );

    log("Force Resync", `${fileNo} (${name}): cleared fast-path on ${cleared} appointments`);

    // Re-parse all appointments with clinical notes (most-recent first)
    const { rows: appts } = await pool.query(
      `SELECT id, healthray_id, appointment_date, healthray_clinical_notes
       FROM appointments
       WHERE patient_id = $1
         AND healthray_clinical_notes IS NOT NULL
         AND LENGTH(healthray_clinical_notes) > 20
       ORDER BY appointment_date DESC`,
      [patientId],
    );

    let parsed = 0, errors = 0;
    for (const appt of appts) {
      try {
        const result = await parseClinicalWithAI(appt.healthray_clinical_notes);
        if (!result) { errors++; continue; }

        const diagnoses  = result.diagnoses  || [];
        const meds       = result.medications || [];
        const prevMeds   = result.previous_medications || [];

        await pool.query(
          `UPDATE appointments
           SET healthray_diagnoses   = $1::jsonb,
               healthray_medications = $2::jsonb,
               updated_at            = NOW()
           WHERE id = $3`,
          [JSON.stringify(diagnoses), JSON.stringify(meds), appt.id],
        );

        if (diagnoses.length) await syncDiagnoses(patientId, appt.healthray_id, diagnoses);
        if (meds.length) {
          await syncMedications(patientId, appt.healthray_id, appt.appointment_date, meds);
          await stopStaleHealthrayMeds(patientId, appt.healthray_id, appt.appointment_date);
        }
        if (prevMeds.length) await syncStoppedMedications(patientId, appt.healthray_id, prevMeds, meds);
        await syncBiomarkersFromLatestLabs(patientId, appt.id);

        parsed++;
        log("Force Resync", `${fileNo}: re-parsed appt ${appt.healthray_id} (${appt.appointment_date}) — ${diagnoses.length} dx, ${meds.length} meds`);
      } catch (e) {
        errors++;
        error("Force Resync", `${fileNo} appt ${appt.healthray_id}: ${e.message}`);
      }
    }

    res.json({
      success: true,
      fileNo,
      name,
      clearedAppointments: cleared,
      reparsed: parsed,
      errors,
      note: "Fast-path cleared — next 5-min cron will re-fetch today's data from HealthRay",
    });
  } catch (e) {
    handleError(res, e, "Force resync patient");
  }
});

// Manual trigger: full sync
router.post("/sync/healthray/full", async (req, res) => {
  try {
    const result = await syncWalkingAppointments();
    res.json({ success: true, ...result });
  } catch (e) {
    handleError(res, e, "HealthRay full sync");
  }
});

// Manual trigger: daily OPD re-parse (fixes diagnoses + medicines JSONB and normalized tables)
// POST /api/sync/opd/daily-backfill?date=2026-04-10  (defaults to today)
router.post("/sync/opd/daily-backfill", async (req, res) => {
  try {
    const date = req.query.date || req.body.date || null;
    // Run in background — responds immediately
    res.json({ success: true, started: true, date: date || "today" });
    runDailyOpdBackfill(date).catch((e) => error("Daily OPD Backfill", e.message));
  } catch (e) {
    handleError(res, e, "Daily OPD backfill");
  }
});

// Manual trigger: today only
router.post("/sync/healthray/today", async (req, res) => {
  try {
    const result = await syncTodayWalkingAppointments();
    res.json({ success: true, ...result });
  } catch (e) {
    handleError(res, e, "HealthRay today sync");
  }
});

// Manual trigger: specific date (e.g. POST /api/sync/healthray/date?date=2026-03-26)
router.post("/sync/healthray/date", async (req, res) => {
  try {
    const date = req.query.date || req.body.date;
    if (!date) return res.status(400).json({ error: "date query param required (YYYY-MM-DD)" });
    const result = await syncWalkingAppointmentsByDate(date);
    res.json({ success: true, ...result });
  } catch (e) {
    handleError(res, e, "HealthRay date sync");
  }
});

// ── Debug: inspect raw HealthRay data stored in DB for a patient ────────────
// GET /api/sync/debug/patient/:fileNo
// Returns the last appointment's raw healthray_clinical_notes + all parsed JSONB fields
router.get("/sync/debug/patient/:fileNo", async (req, res) => {
  try {
    const fileNo = req.params.fileNo;
    const { rows: patients } = await pool.query(
      `SELECT id, name, phone FROM patients WHERE file_no = $1 LIMIT 1`,
      [fileNo],
    );
    if (!patients[0]) return res.status(404).json({ error: `Patient ${fileNo} not found` });
    const patient = patients[0];

    const { rows: appts } = await pool.query(
      `SELECT id, healthray_id, appointment_date, status,
              healthray_clinical_notes,
              healthray_diagnoses, healthray_medications, healthray_labs,
              healthray_advice, healthray_investigations, healthray_follow_up,
              healthray_previous_medications
       FROM appointments
       WHERE patient_id = $1
       ORDER BY appointment_date DESC
       LIMIT 5`,
      [patient.id],
    );

    // Run the exact same query visit.js uses for active meds
    const { rows: activeMeds } = await pool.query(
      `WITH latest_cons AS (
         SELECT DISTINCT ON (COALESCE(con_name, mo_name, 'unknown')) id
         FROM consultations WHERE patient_id=$1
         ORDER BY COALESCE(con_name, mo_name, 'unknown'), visit_date DESC, created_at DESC
       )
       SELECT m.id, m.name, m.dose, m.is_active, m.consultation_id, m.source, m.notes
       FROM medications m LEFT JOIN consultations c ON c.id = m.consultation_id
       WHERE m.patient_id=$1 AND m.is_active = true
         AND (m.consultation_id IN (SELECT id FROM latest_cons) OR m.consultation_id IS NULL)
       ORDER BY COALESCE(c.visit_date, m.started_date) DESC, m.created_at DESC`,
      [patient.id],
    );

    res.json({
      patient: { id: patient.id, name: patient.name, phone: patient.phone, file_no: fileNo },
      activeMedsFromVisitQuery: activeMeds,
      activeMedsCount: activeMeds.length,
      appointments: appts.map((a) => ({
        id: a.id,
        healthray_id: a.healthray_id,
        date: a.appointment_date,
        status: a.status,
        has_clinical_notes: !!a.healthray_clinical_notes,
        clinical_notes_length: a.healthray_clinical_notes?.length || 0,
        clinical_notes_preview: a.healthray_clinical_notes?.slice(0, 500) || null,
        diagnoses_count: (a.healthray_diagnoses || []).length,
        diagnoses: a.healthray_diagnoses,
        medications_count: (a.healthray_medications || []).length,
        medications: a.healthray_medications,
        labs_count: (a.healthray_labs || []).length,
        labs: a.healthray_labs,
        advice: a.healthray_advice,
        investigations: a.healthray_investigations,
        follow_up: a.healthray_follow_up,
        previous_medications_count: (a.healthray_previous_medications || []).length,
        previous_medications: a.healthray_previous_medications,
      })),
    });
  } catch (e) {
    handleError(res, e, "Debug patient HealthRay data");
  }
});

// ── Debug: inspect medications table for a patient ──────────────────────────
// GET /api/sync/debug/meds/:fileNo
router.get("/sync/debug/meds/:fileNo", async (req, res) => {
  try {
    const { rows: patients } = await pool.query(
      `SELECT id, name FROM patients WHERE file_no = $1 LIMIT 1`,
      [req.params.fileNo],
    );
    if (!patients[0]) return res.status(404).json({ error: "Patient not found" });

    const { rows: meds } = await pool.query(
      `SELECT id, name, pharmacy_match, dose, frequency, timing, route,
              is_active, is_new, source, started_date, stopped_date, stop_reason, notes, document_id, consultation_id
       FROM medications WHERE patient_id = $1
       ORDER BY is_active DESC, started_date DESC NULLS LAST`,
      [patients[0].id],
    );

    res.json({
      patient: { id: patients[0].id, name: patients[0].name },
      total: meds.length,
      active: meds.filter((m) => m.is_active).length,
      stopped: meds.filter((m) => !m.is_active).length,
      medications: meds,
    });
  } catch (e) {
    handleError(res, e, "Debug medications");
  }
});

// ── Debug: inspect lab_results table for a patient ───────────────────────────
// GET /api/sync/debug/labs/:fileNo
router.get("/sync/debug/diagnoses/:fileNo", async (req, res) => {
  try {
    const { rows: patients } = await pool.query(
      `SELECT id, name FROM patients WHERE file_no = $1 LIMIT 1`,
      [req.params.fileNo],
    );
    if (!patients[0]) return res.status(404).json({ error: "Patient not found" });
    const pid = patients[0].id;
    const { rows } = await pool.query(
      `SELECT diagnosis_id, label, status, is_active, notes, created_at, updated_at
       FROM diagnoses WHERE patient_id = $1
       ORDER BY is_active DESC, updated_at DESC`,
      [pid],
    );
    res.json({ patient: { id: pid, name: patients[0].name }, total: rows.length, diagnoses: rows });
  } catch (e) {
    handleError(res, e, "Debug diagnoses");
  }
});

router.get("/sync/debug/labs/:fileNo", async (req, res) => {
  try {
    const { rows: patients } = await pool.query(
      `SELECT id, name FROM patients WHERE file_no = $1 LIMIT 1`,
      [req.params.fileNo],
    );
    if (!patients[0]) return res.status(404).json({ error: "Patient not found" });
    const pid = patients[0].id;

    const { rows: labs } = await pool.query(
      `SELECT id, test_date, test_name, canonical_name, result, unit, source, appointment_id
       FROM lab_results WHERE patient_id = $1
       ORDER BY test_date DESC NULLS LAST, test_name`,
      [pid],
    );
    res.json({ patient: { id: pid, name: patients[0].name }, total: labs.length, labs });
  } catch (e) {
    handleError(res, e, "Debug labs");
  }
});

// ── Bulk labs backfill: re-sync labs from stored JSONB for ALL appointments ───
// Fixes the date bug where per-lab dates (e.g. follow-up labs) were stored as appt date.
// Safe to re-run — DELETE + re-INSERT per appointment.
// POST /api/sync/backfill/labs/all  (must be before /:appointmentId to avoid wildcard match)

const labsBackfillStatus = {
  running: false,
  total: 0,
  done: 0,
  errors: 0,
  startedAt: null,
};

router.get("/sync/backfill/labs/all/status", (_req, res) => {
  const elapsed = labsBackfillStatus.startedAt
    ? Math.round((Date.now() - labsBackfillStatus.startedAt) / 1000)
    : 0;
  res.json({ ...labsBackfillStatus, elapsed: `${elapsed}s` });
});

router.post("/sync/backfill/labs/all", async (req, res) => {
  if (labsBackfillStatus.running) {
    return res.status(409).json({ error: "Backfill already running", status: labsBackfillStatus });
  }
  try {
    // Find distinct patients scheduled today or in future, then get each patient's
    // last completed appointment that has labs JSONB
    const { rows: appts } = await pool.query(
      `SELECT DISTINCT ON (a.patient_id)
         a.id, a.patient_id, a.appointment_date, a.healthray_labs
       FROM appointments a
       WHERE a.patient_id IN (
         SELECT DISTINCT patient_id FROM appointments
         WHERE appointment_date >= CURRENT_DATE
       )
         AND a.healthray_labs IS NOT NULL
         AND jsonb_array_length(a.healthray_labs) > 0
       ORDER BY a.patient_id, a.appointment_date DESC`,
    );
    labsBackfillStatus.running = true;
    labsBackfillStatus.total = appts.length;
    labsBackfillStatus.done = 0;
    labsBackfillStatus.errors = 0;
    labsBackfillStatus.startedAt = Date.now();
    res.json({
      success: true,
      started: true,
      total: appts.length,
      statusUrl: "/api/sync/backfill/labs/all/status",
    });
    (async () => {
      for (const appt of appts) {
        try {
          await syncLabResults(
            appt.patient_id,
            appt.id,
            appt.appointment_date,
            appt.healthray_labs,
          );
          labsBackfillStatus.done++;
        } catch (e) {
          labsBackfillStatus.errors++;
          labsBackfillStatus.done++;
          error("Labs Backfill", `appt ${appt.id}: ${e.message}`);
        }
      }
      labsBackfillStatus.running = false;
      log(
        "Labs Backfill",
        `Done — ${labsBackfillStatus.done} appts, ${labsBackfillStatus.errors} errors`,
      );
    })();
  } catch (e) {
    labsBackfillStatus.running = false;
    handleError(res, e, "Labs backfill all");
  }
});

// ── Backfill labs: re-sync labs from stored JSONB for an appointment ──────────
// POST /api/sync/backfill/labs/:appointmentId
router.post("/sync/backfill/labs/:appointmentId", async (req, res) => {
  const apptId = Number(req.params.appointmentId);
  if (!apptId) return res.status(400).json({ error: "Valid appointmentId required" });
  try {
    const { rows } = await pool.query(
      `SELECT id, patient_id, healthray_id, appointment_date, healthray_labs, healthray_clinical_notes
       FROM appointments WHERE id = $1`,
      [apptId],
    );
    if (!rows[0]) return res.status(404).json({ error: "Appointment not found" });
    const appt = rows[0];

    let labs = appt.healthray_labs || [];

    // Force re-parse if ?force=true or labs JSONB is empty
    const forceReparse = req.query.force === "true" || req.body?.force === true;
    if ((labs.length === 0 || forceReparse) && appt.healthray_clinical_notes) {
      const parsed = await parseClinicalWithAI(appt.healthray_clinical_notes);
      if (parsed?.labs?.length) {
        labs = parsed.labs;
        await pool.query(
          `UPDATE appointments SET healthray_labs = $1::jsonb, updated_at = NOW() WHERE id = $2`,
          [JSON.stringify(labs), apptId],
        );
      }
    }

    if (labs.length === 0) return res.json({ success: true, synced: 0, message: "No labs found" });

    await syncLabResults(appt.patient_id, apptId, appt.appointment_date, labs);
    res.json({ success: true, synced: labs.length, labs });
  } catch (e) {
    handleError(res, e, "Backfill labs");
  }
});

// ── Debug: stop stale duplicate active meds for a patient ────────────────────
// POST /api/sync/debug/stop-stale-meds  body: { ids: [1,2,3], reason: "..." }
router.post("/sync/debug/stop-stale-meds", async (req, res) => {
  const { ids, reason } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: "ids array required" });
  }
  try {
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(",");
    const { rows } = await pool.query(
      `DELETE FROM medications WHERE id IN (${placeholders}) RETURNING id, name, dose`,
      ids,
    );
    res.json({ success: true, deleted: rows });
  } catch (e) {
    handleError(res, e, "Stop stale meds");
  }
});

// ── Debug: update started_date for specific med IDs (fix truncated-note date issues) ──
// POST /api/sync/debug/update-med-date  body: { ids: [1,2,3], date: "2026-02-18" }
router.post("/sync/debug/update-med-date", async (req, res) => {
  const { ids, date } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0)
    return res.status(400).json({ error: "ids array required" });
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date))
    return res.status(400).json({ error: "date required (YYYY-MM-DD)" });
  try {
    const placeholders = ids.map((_, i) => `$${i + 2}`).join(",");
    const { rows } = await pool.query(
      `UPDATE medications SET started_date = $1, updated_at = NOW()
       WHERE id IN (${placeholders}) RETURNING id, name, started_date`,
      [date, ...ids],
    );
    res.json({ success: true, updated: rows });
  } catch (e) {
    handleError(res, e, "Update med date");
  }
});

// ── Debug: rename a medication (fix generic→brand name issues from AI extraction) ──
// POST /api/sync/debug/rename-med  body: { id: 502127, name: "Atchol", pharmacy_match: "ATCHOL" }
router.post("/sync/debug/rename-med", async (req, res) => {
  const { id, name, pharmacy_match } = req.body || {};
  if (!id || !name) return res.status(400).json({ error: "id and name required" });
  try {
    const { rows } = await pool.query(
      `UPDATE medications SET name = $1, pharmacy_match = COALESCE($2, pharmacy_match), updated_at = NOW()
       WHERE id = $3 RETURNING id, name, pharmacy_match`,
      [name, pharmacy_match || null, id],
    );
    res.json({ success: true, updated: rows[0] });
  } catch (e) {
    handleError(res, e, "Rename med");
  }
});

// ── Debug: inspect all diagnoses for a patient ───────────────────────────────
// GET /api/sync/debug/diagnoses/:fileNo
router.get("/sync/debug/diagnoses/:fileNo", async (req, res) => {
  try {
    const { rows: patients } = await pool.query(
      `SELECT id FROM patients WHERE file_no = $1 LIMIT 1`,
      [req.params.fileNo],
    );
    if (!patients[0]) return res.status(404).json({ error: "Patient not found" });
    const { rows } = await pool.query(
      `SELECT id, diagnosis_id, label, status, since_year, notes, consultation_id, is_active, created_at
       FROM diagnoses WHERE patient_id = $1 ORDER BY is_active DESC, label`,
      [patients[0].id],
    );
    res.json({
      total: rows.length,
      active: rows.filter((r) => r.is_active).length,
      diagnoses: rows,
    });
  } catch (e) {
    handleError(res, e, "Debug diagnoses");
  }
});

// ── Patient note inject: parse + sync a pasted clinical note for a patient ───
// POST /api/sync/patient/:fileNo/note  body: { notes: "...", date: "YYYY-MM-DD" (optional) }
// Finds the patient's most recent appointment (or creates one for the given date),
// saves the note, then runs the full AI parse → diagnoses + meds + labs pipeline.
router.post("/sync/patient/:fileNo/note", async (req, res) => {
  const fileNo = req.params.fileNo;
  const { notes, date } = req.body || {};
  if (!notes || notes.trim().length < 20)
    return res.status(400).json({ error: "notes required (min 20 chars)" });

  try {
    // Find patient
    const { rows: patients } = await pool.query(
      `SELECT id, name FROM patients WHERE file_no = $1 LIMIT 1`,
      [fileNo],
    );
    if (!patients[0]) return res.status(404).json({ error: `Patient ${fileNo} not found` });
    const patient = patients[0];

    // Find or create appointment
    const apptDate = date || new Date().toISOString().split("T")[0];
    let appt;
    const { rows: existing } = await pool.query(
      `SELECT id, patient_id, healthray_id, appointment_date FROM appointments
       WHERE patient_id = $1 AND appointment_date = $2 LIMIT 1`,
      [patient.id, apptDate],
    );
    if (existing[0]) {
      appt = existing[0];
    } else {
      // Use most recent appointment if no date match
      const { rows: latest } = await pool.query(
        `SELECT id, patient_id, healthray_id, appointment_date FROM appointments
         WHERE patient_id = $1 ORDER BY appointment_date DESC LIMIT 1`,
        [patient.id],
      );
      if (!latest[0]) return res.status(404).json({ error: "No appointments found for patient" });
      appt = latest[0];
    }

    // Save note
    await pool.query(
      `UPDATE appointments SET healthray_clinical_notes = $1, updated_at = NOW() WHERE id = $2`,
      [notes.trim(), appt.id],
    );

    // Parse
    const parsed = await parseClinicalWithAI(notes.trim());
    if (!parsed) return res.status(422).json({ error: "AI parsing failed" });

    const medications = parsed.medications || [];
    const previousMeds = parsed.previous_medications || [];
    const diagnoses = parsed.diagnoses || [];
    const labs = parsed.labs || [];

    // Store parsed JSONB
    await pool.query(
      `UPDATE appointments SET
         healthray_medications = $1::jsonb,
         healthray_diagnoses = $2::jsonb,
         healthray_labs = $3::jsonb,
         updated_at = NOW()
       WHERE id = $4`,
      [JSON.stringify(medications), JSON.stringify(diagnoses), JSON.stringify(labs), appt.id],
    );

    // Sync to tables
    if (medications.length > 0)
      await syncMedications(patient.id, appt.healthray_id, appt.appointment_date, medications);
    if (previousMeds.length > 0)
      await syncStoppedMedications(patient.id, appt.healthray_id, previousMeds, medications);
    if (medications.length > 0)
      await stopStaleHealthrayMeds(patient.id, appt.healthray_id, appt.appointment_date);
    if (diagnoses.length > 0) await syncDiagnoses(patient.id, appt.healthray_id, diagnoses);
    if (labs.length > 0) await syncLabResults(patient.id, appt.id, appt.appointment_date, labs);

    res.json({
      success: true,
      patient: patient.name,
      appointmentId: appt.id,
      appointmentDate: appt.appointment_date,
      medications: medications.length,
      diagnoses: diagnoses.length,
      labs: labs.length,
    });
  } catch (e) {
    handleError(res, e, "Patient note inject");
  }
});

// ── Debug: delete specific diagnosis rows by ID ──────────────────────────────
// POST /api/sync/debug/delete-diagnoses  body: { ids: [1,2,3] }
// POST /api/sync/debug/add-diagnosis  body: { fileNo, name, status? }
router.post("/sync/debug/add-diagnosis", async (req, res) => {
  const { fileNo, name, status = "Active" } = req.body || {};
  if (!fileNo || !name) return res.status(400).json({ error: "fileNo and name required" });
  try {
    const { rows: patients } = await pool.query(
      `SELECT id FROM patients WHERE file_no = $1 LIMIT 1`,
      [fileNo],
    );
    if (!patients[0]) return res.status(404).json({ error: "Patient not found" });
    const patientId = patients[0].id;
    const diagId = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 100);
    const { rows } = await pool.query(
      `INSERT INTO diagnoses (patient_id, diagnosis_id, label, status, is_active)
       VALUES ($1,$2,$3,$4,true)
       ON CONFLICT (patient_id, diagnosis_id) DO UPDATE SET
         label = EXCLUDED.label, status = EXCLUDED.status, is_active = true, updated_at = NOW()
       RETURNING id, patient_id, diagnosis_id, label, status`,
      [patientId, diagId, name, status],
    );
    res.json({ success: true, diagnosis: rows[0] });
  } catch (e) {
    handleError(res, e, "Add diagnosis");
  }
});

// POST /api/sync/debug/deactivate-diagnosis  body: { fileNo, diagnosisId }
router.post("/sync/debug/deactivate-diagnosis", async (req, res) => {
  const { fileNo, diagnosisId } = req.body || {};
  if (!fileNo || !diagnosisId)
    return res.status(400).json({ error: "fileNo and diagnosisId required" });
  try {
    const { rows: patients } = await pool.query(
      `SELECT id FROM patients WHERE file_no = $1 LIMIT 1`,
      [fileNo],
    );
    if (!patients[0]) return res.status(404).json({ error: "Patient not found" });
    const { rowCount } = await pool.query(
      `UPDATE diagnoses SET is_active = false, updated_at = NOW()
       WHERE patient_id = $1 AND diagnosis_id = $2`,
      [patients[0].id, diagnosisId],
    );
    res.json({ success: true, deactivated: rowCount });
  } catch (e) {
    handleError(res, e, "Deactivate diagnosis");
  }
});

router.post("/sync/debug/delete-diagnoses", async (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0)
    return res.status(400).json({ error: "ids array required" });
  try {
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(",");
    const { rows } = await pool.query(
      `DELETE FROM diagnoses WHERE id IN (${placeholders}) RETURNING id, patient_id, label, diagnosis_id`,
      ids,
    );
    res.json({ success: true, deleted: rows });
  } catch (e) {
    handleError(res, e, "Delete diagnoses");
  }
});

// ── Cleanup: remove absent/negative diagnoses stored incorrectly ─────────────
// POST /api/sync/debug/cleanup-absent-diagnoses
// Deletes diagnoses where notes contain "absent" or details have "(-)" marker
router.post("/sync/debug/cleanup-absent-diagnoses", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `DELETE FROM diagnoses
       WHERE notes ~* '^healthray:[0-9]+(\\s*[—–-]+\\s*)(negative|absent|not present|no history|ruled out|\\(\\-\\))\\s*$'
          OR label ~* '[\\-]$'
       RETURNING id, patient_id, label, notes`,
    );
    res.json({ success: true, deleted: rows.length, examples: rows.slice(0, 10) });
  } catch (e) {
    handleError(res, e, "Cleanup absent diagnoses");
  }
});

// Manual trigger: retry pending/reset lab cases
router.post("/sync/lab/retry", async (req, res) => {
  try {
    const result = await retryPendingLabCases();
    res.json({ success: true, ...result });
  } catch (e) {
    handleError(res, e, "Lab retry pending cases");
  }
});

// ── Google Sheets: import upcoming OPD appointments into DB ─────────────────

// Manual trigger: import all 3 upcoming tabs into appointments table
router.post("/sync/sheets/import", async (req, res) => {
  try {
    const result = await syncFromSheets();
    res.json({ success: true, ...result });
  } catch (e) {
    handleError(res, e, "Sheets OPD import");
  }
});

// Read all 3 upcoming tabs (Tomorrow, Day After, Day After + 1)
router.get("/sync/sheets/upcoming", async (req, res) => {
  try {
    const data = await readUpcomingAppointments();
    res.json({ success: true, tabs: data });
  } catch (e) {
    handleError(res, e, "Sheets upcoming read");
  }
});

// Read a single tab by name (e.g. GET /api/sync/sheets/tab?name=Tomorrow)
router.get("/sync/sheets/tab", async (req, res) => {
  try {
    const name = req.query.name;
    if (!name) return res.status(400).json({ error: "name query param required" });
    const data = await readSheetTab(name);
    res.json({ success: true, tab: name, ...data });
  } catch (e) {
    handleError(res, e, "Sheets tab read");
  }
});

// Date-range backfill: POST /api/sync/healthray/range?from=2025-01-01&to=2026-04-03
router.post("/sync/healthray/range", async (req, res) => {
  try {
    const from = req.query.from || req.body.from;
    const to = req.query.to || req.body.to;
    if (!from || !to)
      return res.status(400).json({ error: "from and to query params required (YYYY-MM-DD)" });
    if (from > to) return res.status(400).json({ error: "from must be before to" });

    const days = Math.round((new Date(to) - new Date(from)) / 86400000) + 1;
    if (days > 730)
      return res.status(400).json({ error: "Range too large — max 2 years at a time" });

    const result = await syncDateRange(from, to);
    res.json({ success: true, from, to, ...result });
  } catch (e) {
    handleError(res, e, "HealthRay range sync");
  }
});

// Poll range sync progress: GET /api/sync/healthray/range/status
router.get("/sync/healthray/range/status", (req, res) => {
  res.json(getRangeSyncStatus());
});

// Backfill: copy opd_vitals → vitals table for all appointments that have weight/BP
// POST /api/sync/backfill/vitals
router.post("/sync/backfill/vitals", async (req, res) => {
  try {
    // Ensure columns exist (added after initial schema)
    await pool
      .query(
        `
      ALTER TABLE vitals ADD COLUMN IF NOT EXISTS appointment_id INTEGER;
      ALTER TABLE vitals ADD COLUMN IF NOT EXISTS waist REAL;
      ALTER TABLE vitals ADD COLUMN IF NOT EXISTS body_fat REAL;
    `,
      )
      .catch(() => {});

    const { rows } = await pool.query(`
      SELECT id, patient_id, appointment_date, opd_vitals
      FROM appointments
      WHERE patient_id IS NOT NULL
        AND opd_vitals IS NOT NULL
        AND (
          (opd_vitals->>'weight') IS NOT NULL
          OR (opd_vitals->>'bpSys') IS NOT NULL
        )
      ORDER BY appointment_date ASC
    `);

    let inserted = 0;
    for (const appt of rows) {
      const v = appt.opd_vitals || {};
      const w = parseFloat(v.weight) || null;
      const bpSys = parseFloat(v.bpSys) || null;
      if (!w && !bpSys) continue;

      await pool.query(`DELETE FROM vitals WHERE appointment_id = $1`, [appt.id]);
      await pool
        .query(
          `INSERT INTO vitals
         (patient_id, appointment_id, recorded_at, bp_sys, bp_dia, weight, height, bmi, waist, body_fat)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            appt.patient_id,
            appt.id,
            appt.appointment_date,
            bpSys,
            parseFloat(v.bpDia) || null,
            w,
            parseFloat(v.height) || null,
            parseFloat(v.bmi) || null,
            parseFloat(v.waist) || null,
            parseFloat(v.bodyFat) || null,
          ],
        )
        .catch(() => {});
      inserted++;
    }

    res.json({ success: true, appointmentsBackfilled: inserted });
  } catch (e) {
    handleError(res, e, "Backfill vitals");
  }
});

// One-time cleanup: delete low-priority import/prescription_parsed lab rows where
// a better source already exists for the same patient + test + date.
// POST /api/sync/backfill/labs-renormalize
// Re-applies canonical name normalization to all existing lab_results rows,
// then removes duplicates. Run this once after updating labNormalization.js.
router.post("/sync/backfill/labs-renormalize", async (req, res) => {
  const startTime = Date.now();
  const elapsed = () => `${((Date.now() - startTime) / 1000).toFixed(1)}s`;

  try {
    // 1. Count total rows + patients for context
    const { rows: stats } = await pool.query(
      `SELECT COUNT(*) AS total_rows, COUNT(DISTINCT patient_id) AS total_patients FROM lab_results`,
    );
    const totalRows = Number(stats[0].total_rows);
    const totalPatients = Number(stats[0].total_patients);
    log("Labs Renormalize", `Starting — ${totalRows} rows across ${totalPatients} patients`);

    // 2. Fetch all distinct test_names and their current canonical_names
    const { rows: tests } = await pool.query(
      `SELECT DISTINCT test_name, canonical_name FROM lab_results WHERE test_name IS NOT NULL`,
    );
    log("Labs Renormalize", `[${elapsed()}] Found ${tests.length} distinct test names`);

    // 3. Build update map: current canonical → new canonical
    const updates = [];
    for (const { test_name, canonical_name } of tests) {
      const newCanonical = normalizeTestName(test_name);
      if (newCanonical !== canonical_name) {
        updates.push({ test_name, oldCanonical: canonical_name, newCanonical });
      }
    }
    log("Labs Renormalize", `[${elapsed()}] ${updates.length} test names need remapping:`);
    for (const u of updates) {
      log("Labs Renormalize", `  "${u.test_name}" : "${u.oldCanonical}" → "${u.newCanonical}"`);
    }

    // 4. Apply canonical name updates
    let updated = 0;
    for (const { test_name, newCanonical } of updates) {
      const { rowCount } = await pool.query(
        `UPDATE lab_results SET canonical_name = $1 WHERE test_name = $2`,
        [newCanonical, test_name],
      );
      updated += rowCount;
    }
    log("Labs Renormalize", `[${elapsed()}] Remapped ${updated} rows`);

    // 5. Fix legacy lowercase canonical names (from old normalization code)
    const legacyFixes = [
      ["creatinine", "Creatinine"],
      ["egfr", "eGFR"],
      ["hba1c", "HbA1c"],
      ["fasting_blood_glucose", "FBS"],
      ["post_prandial_glucose", "PPBS"],
      ["random_blood_glucose", "RBS"],
      ["urine_acr", "UACR"],
      ["vitamin_d", "Vitamin D"],
      ["haemoglobin", "Hemoglobin"],
      ["Haemoglobin", "Hemoglobin"],
    ];
    let legacyFixed = 0;
    for (const [old, fixed] of legacyFixes) {
      const { rowCount } = await pool.query(
        `UPDATE lab_results SET canonical_name = $1 WHERE canonical_name = $2`,
        [fixed, old],
      );
      if (rowCount > 0) {
        log("Labs Renormalize", `  Legacy fix: "${old}" → "${fixed}" (${rowCount} rows)`);
        legacyFixed += rowCount;
      }
    }
    updated += legacyFixed;
    log("Labs Renormalize", `[${elapsed()}] Legacy fixes applied: ${legacyFixed} rows`);

    // 6. Dedup — keep highest-priority source per patient+canonical+date
    log("Labs Renormalize", `[${elapsed()}] Running dedup...`);
    const { rows: deleted } = await pool.query(`
      DELETE FROM lab_results
      WHERE id IN (
        SELECT id FROM (
          SELECT id,
            ROW_NUMBER() OVER (
              PARTITION BY patient_id, COALESCE(canonical_name, test_name), test_date::date
              ORDER BY
                CASE source
                  WHEN 'opd'                 THEN 1
                  WHEN 'report_extract'      THEN 2
                  WHEN 'lab_healthray'       THEN 3
                  WHEN 'vitals_sheet'        THEN 4
                  WHEN 'prescription_parsed' THEN 5
                  WHEN 'healthray'           THEN 6
                  ELSE 7
                END ASC,
                created_at DESC
            ) AS rn
          FROM lab_results
        ) ranked
        WHERE rn > 1
      )
      RETURNING id
    `);

    log(
      "Labs Renormalize",
      `[${elapsed()}] Done — ${updated} rows renormalized, ${deleted.length} duplicates removed`,
    );

    res.json({
      success: true,
      totalRows,
      totalPatients,
      testNamesRemapped: updates.length,
      rowsUpdated: updated,
      duplicatesRemoved: deleted.length,
      elapsedSeconds: ((Date.now() - startTime) / 1000).toFixed(1),
      remappedNames: updates.map(
        (u) => `"${u.test_name}": "${u.oldCanonical}" → "${u.newCanonical}"`,
      ),
    });
  } catch (e) {
    handleError(res, e, "Labs renormalize");
  }
});

// ── Backfill biomarkers from latest lab_results for all patients ──────────────
// POST /api/sync/backfill/biomarkers-from-labs
// Fixes stale biomarker values in appointments.biomarkers by pulling the most
// recent lab_results per patient and merging into their latest appointment.
router.post("/sync/backfill/biomarkers-from-labs", async (req, res) => {
  const startTime = Date.now();
  const date = req.query.date || null; // optional ?date=YYYY-MM-DD — limits to today's appointments
  try {
    const { rows: patients } = date
      ? await pool.query(
          `SELECT a.patient_id, a.id AS latest_appt_id
           FROM appointments a
           WHERE a.appointment_date = $1
             AND a.patient_id IS NOT NULL`,
          [date],
        )
      : await pool.query(`
          SELECT DISTINCT lr.patient_id,
            (SELECT a.id FROM appointments a
             WHERE a.patient_id = lr.patient_id
               AND a.patient_id IS NOT NULL
             ORDER BY a.appointment_date DESC NULLS LAST
             LIMIT 1) AS latest_appt_id
          FROM lab_results lr
          WHERE lr.patient_id IS NOT NULL
        `);

    let updated = 0;
    let skipped = 0;
    for (const { patient_id, latest_appt_id } of patients) {
      if (!latest_appt_id) {
        skipped++;
        continue;
      }
      try {
        await syncBiomarkersFromLatestLabs(patient_id, latest_appt_id);
        updated++;
      } catch (e) {
        log("BackfillBiomarkers", `Patient ${patient_id}: ${e.message}`);
        skipped++;
      }
    }

    res.json({
      success: true,
      patientsProcessed: updated,
      patientsSkipped: skipped,
      elapsedSeconds: ((Date.now() - startTime) / 1000).toFixed(1),
    });
  } catch (e) {
    handleError(res, e, "Backfill biomarkers");
  }
});

// ── Backfill: fix duplicate diagnoses across all patients ────────────────────
// POST /api/sync/backfill/diagnoses-dedup
// 1. Deactivates stale old-ID rows (DIAGNOSIS_ID_RENAMES)
// 2. Merges duplicate rows where two diagnosis_ids map to the same canonical
//    (keeps the canonical-ID row active, deactivates the old-ID row)
router.post("/sync/backfill/diagnoses-dedup", async (req, res) => {
  const startTime = Date.now();
  try {
    // Step 1: deactivate all known old/stale diagnosis_ids across every patient
    const RENAMES = {
      hashimotos_thyroiditis: "hashimoto_thyroiditis",
      hashimoto_s_thyroiditis: "hashimoto_thyroiditis",
      seropositive_hashimoto_s_thyroiditis: "hashimoto_thyroiditis",
      seronegative_hashimoto_s_thyroiditis: "hashimoto_thyroiditis",
      acanthosis: "acanthosis_nigricans",
      hyposomatotropisim: "hyposomatotropism",
      hyposomatotropis: "hyposomatotropism",
      osas: "obstructive_sleep_apnea",
      type_2_dm: "type_2_diabetes_mellitus",
      t2dm: "type_2_diabetes_mellitus",
      dm2: "type_2_diabetes_mellitus",
      asld: "masld",
      nafld: "masld",
      mafld: "masld",
      m_a_s_l_d: "masld",
      nephropathy: "diabetic_nephropathy",
      neuropathy: "diabetic_neuropathy",
      htn: "hypertension",
      essential_hypertension: "hypertension",
      cad: "coronary_artery_disease",
      subclinical_hypothyroidism: "hypothyroidism",
      subclinical_hypothyrodism: "hypothyroidism",
      sunclinical_hypothyrodism: "hypothyroidism",
      thallasemia_minor: "thalassemia_minor",
      thallasemia_major: "thalassemia_major",
      thallasemia: "thalassemia",
      mild_dr: "diabetic_retinopathy",
      hypo: "hypothyroidism",
    };

    const oldIds = Object.keys(RENAMES);
    const placeholders = oldIds.map((_, i) => `$${i + 1}`).join(",");
    const { rowCount: deactivated } = await pool.query(
      `UPDATE diagnoses SET is_active = false, updated_at = NOW()
       WHERE diagnosis_id IN (${placeholders})`,
      oldIds,
    );

    // Step 2: for each rename, if the canonical row exists for the same patient,
    // make sure it is active (the old row was just deactivated above)
    let reactivated = 0;
    for (const [oldId, canonicalId] of Object.entries(RENAMES)) {
      const { rowCount } = await pool.query(
        `UPDATE diagnoses d SET is_active = true, updated_at = NOW()
         WHERE d.diagnosis_id = $1
           AND EXISTS (
             SELECT 1 FROM diagnoses old
             WHERE old.patient_id = d.patient_id
               AND old.diagnosis_id = $2
           )`,
        [canonicalId, oldId],
      );
      reactivated += rowCount;
    }

    // Step 3: for patients that only had the old ID (no canonical row yet),
    // rename diagnosis_id to canonical so data isn't lost
    let renamed = 0;
    for (const [oldId, canonicalId] of Object.entries(RENAMES)) {
      const { rowCount } = await pool.query(
        `UPDATE diagnoses SET diagnosis_id = $1, updated_at = NOW()
         WHERE diagnosis_id = $2
           AND is_active = false
           AND NOT EXISTS (
             SELECT 1 FROM diagnoses d2
             WHERE d2.patient_id = diagnoses.patient_id
               AND d2.diagnosis_id = $1
           )`,
        [canonicalId, oldId],
      );
      renamed += rowCount;
    }

    log(
      "DiagnosesDedup",
      `Done — ${deactivated} stale rows deactivated, ${reactivated} canonical rows confirmed active, ${renamed} rows renamed to canonical`,
    );

    res.json({
      success: true,
      staleRowsDeactivated: deactivated,
      canonicalRowsConfirmedActive: reactivated,
      rowsRenamedToCanonical: renamed,
      elapsedSeconds: ((Date.now() - startTime) / 1000).toFixed(1),
    });
  } catch (e) {
    handleError(res, e, "Diagnoses dedup");
  }
});

// POST /api/sync/backfill/labs-dedup
router.post("/sync/backfill/labs-dedup", async (req, res) => {
  try {
    const { rows } = await pool.query(`
      DELETE FROM lab_results
      WHERE id IN (
        SELECT id FROM (
          SELECT id,
            ROW_NUMBER() OVER (
              PARTITION BY patient_id, COALESCE(canonical_name, test_name), test_date::date
              ORDER BY
                CASE source
                  WHEN 'opd'                THEN 1
                  WHEN 'report_extract'     THEN 2
                  WHEN 'lab_healthray'      THEN 3
                  WHEN 'vitals_sheet'       THEN 4
                  WHEN 'prescription_parsed' THEN 5
                  WHEN 'healthray'          THEN 6
                  ELSE 7
                END ASC,
                created_at DESC
            ) AS rn
          FROM lab_results
        ) ranked
        WHERE rn > 1
      )
      RETURNING id
    `);
    res.json({ success: true, deleted: rows.length });
  } catch (e) {
    handleError(res, e, "Labs dedup cleanup");
  }
});

// Backfill: re-parse clinical notes for a single appointment
// POST /api/sync/backfill/investigations/:appointmentId
router.post("/sync/backfill/investigations/:appointmentId", async (req, res) => {
  const apptId = Number(req.params.appointmentId);
  if (!apptId) return res.status(400).json({ error: "Valid appointmentId required" });

  try {
    const { rows } = await pool.query(
      `SELECT id, healthray_clinical_notes FROM appointments WHERE id = $1`,
      [apptId],
    );

    if (!rows[0]) return res.status(404).json({ error: "Appointment not found" });

    let notes = rows[0].healthray_clinical_notes;

    // If notes provided in body, save them first
    if (req.body?.notes) {
      notes = req.body.notes;
      await pool.query(
        `UPDATE appointments SET healthray_clinical_notes = $1, updated_at = NOW() WHERE id = $2`,
        [notes, apptId],
      );
    }

    if (!notes) {
      return res.status(400).json({
        error:
          "Appointment has no clinical notes to parse. Pass { notes: '...' } in the request body.",
      });
    }

    const parsed = await parseClinicalWithAI(notes);
    if (!parsed) return res.status(422).json({ error: "AI parsing failed or returned no data" });

    const investigations = (parsed.investigations_to_order || []).map((t) =>
      typeof t === "string" ? { name: t, urgency: "routine" } : t,
    );
    const followUp = parsed.follow_up || null;

    await pool.query(
      `UPDATE appointments
       SET healthray_investigations = $1::jsonb,
           healthray_follow_up = $2::jsonb,
           updated_at = NOW()
       WHERE id = $3`,
      [JSON.stringify(investigations), followUp ? JSON.stringify(followUp) : null, apptId],
    );

    res.json({ success: true, appointmentId: apptId, investigations, followUp });
  } catch (e) {
    handleError(res, e, "Backfill investigations");
  }
});

// ── Backfill diagnoses: re-parse clinical notes and sync diagnoses ──────────
// POST /api/sync/backfill/diagnoses/:appointmentId
// Re-parses clinical notes with updated AI prompt to extract all diagnoses
router.post("/sync/backfill/diagnoses/:appointmentId", async (req, res) => {
  const apptId = Number(req.params.appointmentId);
  if (!apptId) return res.status(400).json({ error: "Valid appointmentId required" });

  try {
    const { rows } = await pool.query(
      `SELECT id, patient_id, healthray_id, healthray_clinical_notes FROM appointments WHERE id = $1`,
      [apptId],
    );

    if (!rows[0]) return res.status(404).json({ error: "Appointment not found" });

    const appt = rows[0];
    let notes = appt.healthray_clinical_notes;

    // If notes provided in body, save them first
    if (req.body?.notes) {
      notes = req.body.notes;
      await pool.query(
        `UPDATE appointments SET healthray_clinical_notes = $1, updated_at = NOW() WHERE id = $2`,
        [notes, apptId],
      );
    }

    if (!notes) {
      return res.status(400).json({
        error:
          "Appointment has no clinical notes to parse. Pass { notes: '...' } in the request body.",
      });
    }

    const parsed = await parseClinicalWithAI(notes);
    if (!parsed) return res.status(422).json({ error: "AI parsing failed or returned no data" });

    const diagnoses = parsed.diagnoses || [];

    // Update appointments table with parsed diagnoses
    await pool.query(
      `UPDATE appointments SET healthray_diagnoses = $1::jsonb, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(diagnoses), apptId],
    );

    // Sync diagnoses to diagnoses table
    if (appt.patient_id && diagnoses.length > 0) {
      await syncDiagnoses(appt.patient_id, appt.healthray_id, diagnoses);
    }

    res.json({
      success: true,
      appointmentId: apptId,
      diagnosesExtracted: diagnoses.length,
      diagnoses,
    });
  } catch (e) {
    handleError(res, e, "Backfill diagnoses");
  }
});

// ── Backfill medicines: re-parse clinical notes and sync medications ────────
// POST /api/sync/backfill/medicines/:appointmentId
// Re-parses clinical notes with updated AI prompt to extract dose changes and previous medications
router.post("/sync/backfill/medicines/:appointmentId", async (req, res) => {
  const apptId = Number(req.params.appointmentId);
  if (!apptId) return res.status(400).json({ error: "Valid appointmentId required" });

  try {
    const { rows } = await pool.query(
      `SELECT id, patient_id, healthray_id, appointment_date, healthray_clinical_notes FROM appointments WHERE id = $1`,
      [apptId],
    );

    if (!rows[0]) return res.status(404).json({ error: "Appointment not found" });

    const appt = rows[0];
    let notes = appt.healthray_clinical_notes;

    // If notes provided in body, save them first
    if (req.body?.notes) {
      notes = req.body.notes;
      await pool.query(
        `UPDATE appointments SET healthray_clinical_notes = $1, updated_at = NOW() WHERE id = $2`,
        [notes, apptId],
      );
    }

    if (!notes) {
      return res.status(400).json({
        error:
          "Appointment has no clinical notes to parse. Pass { notes: '...' } in the request body.",
      });
    }

    const parsed = await parseClinicalWithAI(notes);
    if (!parsed) return res.status(422).json({ error: "AI parsing failed or returned no data" });

    const medications = parsed.medications || [];
    const previousMeds = parsed.previous_medications || [];

    // Update appointments table with parsed medications
    await pool.query(
      `UPDATE appointments SET healthray_medications = $1::jsonb, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(medications), apptId],
    );

    // Sync current medications
    if (appt.patient_id && medications.length > 0) {
      await syncMedications(appt.patient_id, appt.healthray_id, appt.appointment_date, medications);
    }

    // Sync stopped/previous medications
    if (appt.patient_id && previousMeds.length > 0) {
      await syncStoppedMedications(appt.patient_id, appt.healthray_id, previousMeds, medications);
    }

    // Stop any HealthRay-sourced meds not in current prescription
    if (appt.patient_id && medications.length > 0) {
      await stopStaleHealthrayMeds(appt.patient_id, appt.healthray_id, appt.appointment_date);
    }

    res.json({
      success: true,
      appointmentId: apptId,
      medicinesExtracted: medications.length,
      previousMedicinesExtracted: previousMeds.length,
      medicines: medications,
      previousMedicines: previousMeds,
    });
  } catch (e) {
    handleError(res, e, "Backfill medicines");
  }
});

// ── Backfill medicines for all patients scheduled on a given date ────────────
// Finds each patient's LAST completed appointment with clinical notes and re-parses it
// POST /api/sync/backfill/medicines/opd/:date  (YYYY-MM-DD, defaults to today)
const opdBackfillStatus = {
  running: false,
  date: null,
  total: 0,
  done: 0,
  errors: 0,
  results: [],
  startedAt: null,
};

router.get("/sync/backfill/medicines/opd/status", (_req, res) => {
  const elapsed = opdBackfillStatus.startedAt
    ? Math.round((Date.now() - opdBackfillStatus.startedAt) / 1000)
    : 0;
  res.json({ ...opdBackfillStatus, elapsed: `${elapsed}s` });
});

router.post("/sync/backfill/medicines/opd/:date?", async (req, res) => {
  if (opdBackfillStatus.running) {
    return res.status(409).json({ error: "Backfill already running", status: opdBackfillStatus });
  }

  const date = req.params.date || new Date().toISOString().split("T")[0];

  try {
    // Get all unique patients scheduled today
    const { rows: patients } = await pool.query(
      `SELECT DISTINCT patient_id FROM appointments WHERE appointment_date = $1 AND patient_id IS NOT NULL`,
      [date],
    );

    if (patients.length === 0) {
      return res.json({
        success: true,
        date,
        message: "No patients found for this date",
        total: 0,
      });
    }

    Object.assign(opdBackfillStatus, {
      running: true,
      date,
      total: patients.length,
      done: 0,
      errors: 0,
      results: [],
      startedAt: Date.now(),
    });

    res.json({
      success: true,
      started: true,
      date,
      total: patients.length,
      statusUrl: "/api/sync/backfill/medicines/opd/status",
    });

    (async () => {
      for (const { patient_id } of patients) {
        try {
          // Find this patient's last completed appointment with clinical notes
          const { rows } = await pool.query(
            `SELECT id, patient_id, healthray_id, appointment_date, healthray_clinical_notes, file_no,
                    (SELECT name FROM patients WHERE id = $1) AS patient_name
             FROM appointments
             WHERE patient_id = $1
               AND healthray_clinical_notes IS NOT NULL
               AND LENGTH(healthray_clinical_notes) > 20
             ORDER BY appointment_date DESC LIMIT 1`,
            [patient_id],
          );

          if (!rows[0]) {
            opdBackfillStatus.results.push({ patient_id, status: "no_notes" });
            opdBackfillStatus.done++;
            continue;
          }

          const appt = rows[0];
          const parsed = await parseClinicalWithAI(appt.healthray_clinical_notes);

          if (!parsed) {
            opdBackfillStatus.results.push({
              patient_id,
              name: appt.patient_name,
              status: "parse_failed",
            });
            opdBackfillStatus.errors++;
            opdBackfillStatus.done++;
            continue;
          }

          const medications = parsed.medications || [];
          const previousMeds = parsed.previous_medications || [];

          await pool.query(
            `UPDATE appointments SET healthray_medications = $1::jsonb, updated_at = NOW() WHERE id = $2`,
            [JSON.stringify(medications), appt.id],
          );

          if (patient_id && medications.length > 0) {
            await syncMedications(
              patient_id,
              appt.healthray_id,
              appt.appointment_date,
              medications,
            );
          }
          if (patient_id && previousMeds.length > 0) {
            await syncStoppedMedications(patient_id, appt.healthray_id, previousMeds, medications);
          }
          if (patient_id && medications.length > 0) {
            await stopStaleHealthrayMeds(patient_id, appt.healthray_id, appt.appointment_date);
          }

          opdBackfillStatus.results.push({
            patient_id,
            name: appt.patient_name,
            appt_date: appt.appointment_date,
            appt_id: appt.id,
            status: "ok",
            meds: medications.length,
            prev_meds: previousMeds.length,
          });
          log(
            "OPD Backfill",
            `Patient ${patient_id} (${appt.patient_name}): ${medications.length} meds from appt ${appt.id}`,
          );
        } catch (e) {
          opdBackfillStatus.results.push({ patient_id, status: "error", error: e.message });
          opdBackfillStatus.errors++;
          error("OPD Backfill", `Patient ${patient_id}: ${e.message}`);
        }
        opdBackfillStatus.done++;
      }
      log(
        "OPD Backfill",
        `Done — ${opdBackfillStatus.done} patients, ${opdBackfillStatus.errors} errors`,
      );
      opdBackfillStatus.running = false;
    })();
  } catch (e) {
    opdBackfillStatus.running = false;
    handleError(res, e, "OPD medicines backfill");
  }
});

// ── Backfill diagnoses for all patients scheduled on a given date ────────────
// POST /api/sync/backfill/diagnoses/opd/:date  (YYYY-MM-DD, defaults to today)
const opdDxBackfillStatus = {
  running: false,
  date: null,
  total: 0,
  done: 0,
  errors: 0,
  results: [],
  startedAt: null,
};

router.get("/sync/backfill/diagnoses/opd/status", (_req, res) => {
  const elapsed = opdDxBackfillStatus.startedAt
    ? Math.round((Date.now() - opdDxBackfillStatus.startedAt) / 1000)
    : 0;
  res.json({ ...opdDxBackfillStatus, elapsed: `${elapsed}s` });
});

router.post("/sync/backfill/diagnoses/opd/:date?", async (req, res) => {
  if (opdDxBackfillStatus.running) {
    return res.status(409).json({ error: "Backfill already running", status: opdDxBackfillStatus });
  }

  const date = req.params.date || new Date().toISOString().split("T")[0];

  try {
    const { rows: patients } = await pool.query(
      `SELECT DISTINCT patient_id FROM appointments WHERE appointment_date = $1 AND patient_id IS NOT NULL`,
      [date],
    );

    if (patients.length === 0) {
      return res.json({
        success: true,
        date,
        message: "No patients found for this date",
        total: 0,
      });
    }

    Object.assign(opdDxBackfillStatus, {
      running: true,
      date,
      total: patients.length,
      done: 0,
      errors: 0,
      results: [],
      startedAt: Date.now(),
    });

    res.json({
      success: true,
      started: true,
      date,
      total: patients.length,
      statusUrl: "/api/sync/backfill/diagnoses/opd/status",
    });

    (async () => {
      for (const { patient_id } of patients) {
        try {
          const { rows } = await pool.query(
            `SELECT id, patient_id, healthray_id, appointment_date, healthray_clinical_notes,
                    (SELECT name FROM patients WHERE id = $1) AS patient_name
             FROM appointments
             WHERE patient_id = $1
               AND healthray_clinical_notes IS NOT NULL
               AND LENGTH(healthray_clinical_notes) > 20
             ORDER BY appointment_date DESC LIMIT 1`,
            [patient_id],
          );

          if (!rows[0]) {
            opdDxBackfillStatus.results.push({ patient_id, status: "no_notes" });
            opdDxBackfillStatus.done++;
            continue;
          }

          const appt = rows[0];
          const parsed = await parseClinicalWithAI(appt.healthray_clinical_notes);

          if (!parsed) {
            opdDxBackfillStatus.results.push({
              patient_id,
              name: appt.patient_name,
              status: "parse_failed",
            });
            opdDxBackfillStatus.errors++;
            opdDxBackfillStatus.done++;
            continue;
          }

          const diagnoses = parsed.diagnoses || [];

          await pool.query(
            `UPDATE appointments SET healthray_diagnoses = $1::jsonb, updated_at = NOW() WHERE id = $2`,
            [JSON.stringify(diagnoses), appt.id],
          );

          if (patient_id && diagnoses.length > 0) {
            await syncDiagnoses(patient_id, appt.healthray_id, diagnoses);
          }

          opdDxBackfillStatus.results.push({
            patient_id,
            name: appt.patient_name,
            appt_date: appt.appointment_date,
            appt_id: appt.id,
            status: "ok",
            diagnoses: diagnoses.length,
          });
          log(
            "OPD Dx Backfill",
            `Patient ${patient_id} (${appt.patient_name}): ${diagnoses.length} diagnoses`,
          );
        } catch (e) {
          opdDxBackfillStatus.results.push({ patient_id, status: "error", error: e.message });
          opdDxBackfillStatus.errors++;
          error("OPD Dx Backfill", `Patient ${patient_id}: ${e.message}`);
        }
        opdDxBackfillStatus.done++;
      }
      log(
        "OPD Dx Backfill",
        `Done — ${opdDxBackfillStatus.done} patients, ${opdDxBackfillStatus.errors} errors`,
      );
      opdDxBackfillStatus.running = false;
    })();
  } catch (e) {
    opdDxBackfillStatus.running = false;
    handleError(res, e, "OPD diagnoses backfill");
  }
});

// ── Backfill medicines for all appointments on a given date ─────────────────
// POST /api/sync/backfill/medicines/date/:date  (YYYY-MM-DD, defaults to today)
router.post("/sync/backfill/medicines/date/:date?", async (req, res) => {
  const date = req.params.date || new Date().toISOString().split("T")[0];

  try {
    const { rows } = await pool.query(
      `SELECT id, patient_id, healthray_id, appointment_date, healthray_clinical_notes
       FROM appointments
       WHERE appointment_date = $1
         AND healthray_clinical_notes IS NOT NULL
         AND LENGTH(healthray_clinical_notes) > 20`,
      [date],
    );

    if (rows.length === 0) {
      return res.json({
        success: true,
        date,
        message: "No appointments with clinical notes found",
        processed: 0,
      });
    }

    res.json({
      success: true,
      date,
      total: rows.length,
      message: `Processing ${rows.length} appointments in background`,
      statusNote: "Check server logs for progress",
    });

    // Process in background
    (async () => {
      let done = 0,
        errors = 0,
        totalMeds = 0;
      for (const appt of rows) {
        try {
          const parsed = await parseClinicalWithAI(appt.healthray_clinical_notes);

          if (!parsed) {
            errors++;
            continue;
          }

          const medications = parsed.medications || [];
          const previousMeds = parsed.previous_medications || [];

          await pool.query(
            `UPDATE appointments SET healthray_medications = $1::jsonb, updated_at = NOW() WHERE id = $2`,
            [JSON.stringify(medications), appt.id],
          );

          if (appt.patient_id && medications.length > 0) {
            await syncMedications(
              appt.patient_id,
              appt.healthray_id,
              appt.appointment_date,
              medications,
            );
          }
          if (appt.patient_id && previousMeds.length > 0) {
            await syncStoppedMedications(
              appt.patient_id,
              appt.healthray_id,
              previousMeds,
              medications,
            );
          }
          if (appt.patient_id && medications.length > 0) {
            await stopStaleHealthrayMeds(appt.patient_id, appt.healthray_id, appt.appointment_date);
          }

          totalMeds += medications.length;
          done++;
          log(
            "Backfill",
            `Appt ${appt.id}: ${medications.length} meds, ${previousMeds.length} prev`,
          );
        } catch (e) {
          errors++;
          error("Backfill", `Appt ${appt.id}: ${e.message}`);
        }
      }
      log(
        "Backfill",
        `Date ${date} done — ${done}/${rows.length} appointments, ${totalMeds} total meds, ${errors} errors`,
      );
    })();
  } catch (e) {
    handleError(res, e, "Backfill medicines by date");
  }
});

// ── Backfill medications from appointments.healthray_medications ─────────────
// POST /api/sync/healthray/backfill-meds
// Reads every appointment that has healthray_medications stored and re-syncs
// any medications missing from the medications table (uses per-med UPSERT, safe to re-run)
router.post("/sync/healthray/backfill-meds", async (req, res) => {
  try {
    const r = await pool.query(
      `INSERT INTO medications
         (patient_id, name, dose, frequency, timing, route, is_active, started_date, notes)
       SELECT
         a.patient_id,
         med->>'name',
         NULLIF(med->>'dose', ''),
         NULLIF(med->>'frequency', ''),
         NULLIF(med->>'timing', ''),
         COALESCE(NULLIF(med->>'route', ''), 'Oral'),
         true,
         a.appointment_date,
         'healthray:' || a.healthray_id
       FROM appointments a,
            jsonb_array_elements(a.healthray_medications) AS med
       WHERE a.patient_id IS NOT NULL
         AND a.healthray_id IS NOT NULL
         AND a.healthray_medications IS NOT NULL
         AND jsonb_typeof(a.healthray_medications) = 'array'
         AND jsonb_array_length(a.healthray_medications) > 0
         AND med->>'name' IS NOT NULL
         AND med->>'name' != ''
       ON CONFLICT (patient_id, UPPER(COALESCE(pharmacy_match, name))) WHERE is_active = true
       DO NOTHING`,
    );
    res.json({ success: true, inserted: r.rowCount });
  } catch (e) {
    handleError(res, e, "Backfill medications");
  }
});

// ── Re-sync medicines + diagnoses for all patients on a given date ───────────
// Processes in batches of 3 concurrent patients; logs progress with index/total
// POST /api/sync/resync-opd/:date?  (YYYY-MM-DD, defaults to today)
// Optional query: ?batch=5  to override concurrency (default 3)
router.post("/sync/resync-opd/:date?", async (req, res) => {
  const date = req.params.date || new Date().toISOString().split("T")[0];
  const BATCH = Math.min(parseInt(req.query.batch || "3", 10), 10);

  try {
    const { rows: patients } = await pool.query(
      `SELECT DISTINCT patient_id FROM appointments WHERE appointment_date = $1 AND patient_id IS NOT NULL`,
      [date],
    );

    if (patients.length === 0) {
      return res.json({
        success: true,
        date,
        message: "No patients found for this date",
        total: 0,
      });
    }

    const total = patients.length;
    log("Re-sync OPD", `Starting — ${total} patients, batch size ${BATCH}`);

    const results = [];
    let medsTotal = 0,
      dxTotal = 0,
      errors = 0,
      done = 0;

    async function processPatient(patient_id) {
      const { rows } = await pool.query(
        `SELECT id, patient_id, healthray_id, appointment_date, healthray_clinical_notes,
                (SELECT name FROM patients WHERE id = $1) AS patient_name
         FROM appointments
         WHERE patient_id = $1
           AND healthray_clinical_notes IS NOT NULL
           AND LENGTH(healthray_clinical_notes) > 20
         ORDER BY appointment_date DESC LIMIT 1`,
        [patient_id],
      );

      if (!rows[0]) {
        done++;
        results.push({ patient_id, status: "no_notes" });
        log("Re-sync OPD", `[${done}/${total}] Patient ${patient_id}: no clinical notes — skipped`);
        return;
      }

      const appt = rows[0];
      const parsed = await parseClinicalWithAI(appt.healthray_clinical_notes);

      if (!parsed) {
        done++;
        errors++;
        results.push({ patient_id, name: appt.patient_name, status: "parse_failed" });
        log(
          "Re-sync OPD",
          `[${done}/${total}] Patient ${patient_id} (${appt.patient_name}): AI parse failed`,
        );
        return;
      }

      const medications = parsed.medications || [];
      const previousMeds = parsed.previous_medications || [];
      const diagnoses = parsed.diagnoses || [];

      await pool.query(
        `UPDATE appointments SET healthray_medications = $1::jsonb, healthray_diagnoses = $2::jsonb, updated_at = NOW() WHERE id = $3`,
        [JSON.stringify(medications), JSON.stringify(diagnoses), appt.id],
      );

      if (patient_id && medications.length > 0) {
        await syncMedications(patient_id, appt.healthray_id, appt.appointment_date, medications);
      }
      if (patient_id && previousMeds.length > 0) {
        await syncStoppedMedications(patient_id, appt.healthray_id, previousMeds, medications);
      }
      if (patient_id && medications.length > 0) {
        await stopStaleHealthrayMeds(patient_id, appt.healthray_id, appt.appointment_date);
      }
      if (patient_id && diagnoses.length > 0) {
        await syncDiagnoses(patient_id, appt.healthray_id, diagnoses);
      }

      done++;
      medsTotal += medications.length;
      dxTotal += diagnoses.length;
      results.push({
        patient_id,
        name: appt.patient_name,
        appt_id: appt.id,
        status: "ok",
        meds: medications.length,
        diagnoses: diagnoses.length,
      });
      log(
        "Re-sync OPD",
        `[${done}/${total}] Patient ${patient_id} (${appt.patient_name}): ${medications.length} meds, ${diagnoses.length} dx`,
      );
    }

    // Process in batches of BATCH concurrent patients
    for (let i = 0; i < patients.length; i += BATCH) {
      const batch = patients.slice(i, i + BATCH);
      await Promise.allSettled(
        batch.map(async ({ patient_id }) => {
          try {
            await processPatient(patient_id);
          } catch (e) {
            done++;
            errors++;
            results.push({ patient_id, status: "error", error: e.message });
            error("Re-sync OPD", `[${done}/${total}] Patient ${patient_id}: ${e.message}`);
          }
        }),
      );
    }

    log(
      "Re-sync OPD",
      `Done — ${total} patients, ${medsTotal} meds, ${dxTotal} dx, ${errors} errors`,
    );
    res.json({ success: true, date, total, medsTotal, dxTotal, errors, results });
  } catch (e) {
    handleError(res, e, "Re-sync OPD");
  }
});

// ── Lab HealthRay sync ───────────────────────────────────────────────────────

// Manual trigger: POST /api/sync/lab/trigger
router.post("/sync/lab/trigger", async (req, res) => {
  try {
    const result = await runLabSync();
    res.json({ success: true, ...result });
  } catch (e) {
    handleError(res, e, "Lab sync trigger");
  }
});

// Status: GET /api/sync/lab/status
router.get("/sync/lab/status", (req, res) => {
  res.json(getLabSyncStatus());
});

// Backfill ref_range + flag for a date's lab_healthray rows (UPDATE only, no deletes)
// POST /api/sync/lab/backfill-ranges?date=2026-04-06  (defaults to today)
router.post("/sync/lab/backfill-ranges", async (req, res) => {
  try {
    const date = req.query.date || req.body.date;
    const result = await backfillLabRanges(date);
    res.json({ success: true, ...result });
  } catch (e) {
    handleError(res, e, "Lab backfill ranges");
  }
});

// Debug: inspect raw patient data from stored lab cases
// GET /api/sync/lab/debug-cases?limit=5
router.get("/sync/lab/debug-cases", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT case_no, patient_case_no, patient_id,
              raw_list_json->'patient' AS patient_json,
              results_synced, case_date
       FROM lab_cases ORDER BY fetched_at DESC LIMIT 10`,
    );
    res.json({ total: rows.length, cases: rows });
  } catch (e) {
    handleError(res, e, "Lab debug cases");
  }
});

// Backfill: match lab_cases with null patient_id → patients table, then re-process results
// POST /api/sync/lab/backfill-patient-match
const labPatientMatchStatus = {
  running: false,
  matched: 0,
  reprocessed: 0,
  written: 0,
  errors: 0,
  done: false,
};
router.get("/sync/lab/backfill-patient-match/status", (_req, res) =>
  res.json(labPatientMatchStatus),
);
router.post("/sync/lab/backfill-patient-match", async (req, res) => {
  if (labPatientMatchStatus.running)
    return res.status(409).json({ error: "Already running", status: labPatientMatchStatus });

  // Step 1: update patient_id on unmatched cases where we can now find the patient
  try {
    const { rowCount: matched } = await pool.query(
      `UPDATE lab_cases lc
       SET patient_id = p.id
       FROM patients p
       WHERE lc.patient_id IS NULL
         AND p.file_no = lc.raw_list_json->'patient'->>'healthray_uid'`,
    );
    labPatientMatchStatus.matched = matched;
    log("Lab Backfill", `Matched ${matched} previously-unmatched lab cases to patients`);
  } catch (e) {
    return handleError(res, e, "Lab patient match backfill");
  }

  // Step 2: find all cases with patient_id set but no lab_results written (check via absence in lab_results)
  const { rows: toReprocess } = await pool.query(
    `SELECT lc.id, lc.case_no, lc.case_uid, lc.lab_case_id, lc.lab_user_id,
            lc.patient_id, lc.appointment_id, lc.case_date, lc.raw_detail_json
     FROM lab_cases lc
     WHERE lc.patient_id IS NOT NULL
       AND lc.raw_detail_json IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM lab_results lr
         WHERE lr.patient_id = lc.patient_id
           AND lr.source = 'lab_healthray'
           AND lr.test_date::date = lc.case_date::date
       )
     ORDER BY lc.case_date DESC`,
  );

  Object.assign(labPatientMatchStatus, {
    running: true,
    reprocessed: 0,
    written: 0,
    errors: 0,
    done: false,
  });

  // Step 3: reset results_synced=false for matched cases with no lab_healthray results
  // so the retry job re-fetches fresh results from the API
  const { rowCount: reset } = await pool.query(
    `UPDATE lab_cases lc SET results_synced = FALSE
     WHERE lc.patient_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM lab_results lr
         WHERE lr.patient_id = lc.patient_id
           AND lr.source = 'lab_healthray'
           AND lr.test_date::date = lc.case_date::date
       )`,
  );
  labPatientMatchStatus.reset = reset;
  log("Lab Backfill", `Reset results_synced=false for ${reset} cases (will re-fetch from API)`);

  res.json({
    success: true,
    matched: labPatientMatchStatus.matched,
    toReprocess: toReprocess.length,
    reset,
    statusUrl: "/api/sync/lab/backfill-patient-match/status",
  });

  (async () => {
    const { syncLabCaseResults } = await import("../services/lab/db.js");
    const { parseLabCaseResults } = await import("../services/lab/labHealthrayParser.js");

    for (const lc of toReprocess) {
      try {
        const results = parseLabCaseResults(lc.raw_detail_json);
        const written = await syncLabCaseResults(
          lc.patient_id,
          lc.appointment_id,
          lc.case_date,
          results,
        );
        labPatientMatchStatus.written += written;
        labPatientMatchStatus.reprocessed++;
        if (written > 0)
          log(
            "Lab Backfill",
            `Case ${lc.case_no} → patient ${lc.patient_id}: ${written} results written`,
          );
      } catch (e) {
        labPatientMatchStatus.errors++;
        log("Lab Backfill", `Case ${lc.case_no} error: ${e.message}`);
      }
    }
    labPatientMatchStatus.running = false;
    labPatientMatchStatus.done = true;
    log(
      "Lab Backfill",
      `Done — ${labPatientMatchStatus.reprocessed} cases, ${labPatientMatchStatus.written} results written, ${labPatientMatchStatus.errors} errors`,
    );
  })();
});

// Manual token refresh: POST /api/sync/lab/refresh-auth
router.post("/sync/lab/refresh-auth", async (_req, res) => {
  try {
    await labLogin();
    res.json({ success: true, message: "Lab API tokens refreshed" });
  } catch (e) {
    handleError(res, e, "Lab auth refresh");
  }
});

// ── Bulk backfill diagnoses: shared state for progress tracking ───────────────
const diagBackfillStatus = { running: false, total: 0, done: 0, errors: 0, startedAt: null };

// GET /api/sync/backfill/diagnoses-all/status — poll progress
router.get("/sync/backfill/diagnoses-all/status", (_req, res) => {
  const { running, total, done, errors, startedAt } = diagBackfillStatus;
  const elapsed = startedAt ? Math.round((Date.now() - startedAt) / 1000) : 0;
  const rate = elapsed > 0 ? (done / elapsed).toFixed(1) : 0;
  const remaining = rate > 0 ? Math.round((total - done) / rate) : null;
  res.json({
    running,
    total,
    done,
    errors,
    elapsed: `${elapsed}s`,
    rate: `${rate}/s`,
    remainingEst: remaining ? `${remaining}s` : null,
  });
});

// ── Bulk backfill diagnoses from existing JSONB data (no AI re-parse needed) ─
// POST /api/sync/backfill/diagnoses-all
// Reads appointments.healthray_diagnoses JSONB and syncs to diagnoses table
// Safe to re-run — uses ON CONFLICT DO UPDATE in syncDiagnoses
router.post("/sync/backfill/diagnoses-all", async (req, res) => {
  if (diagBackfillStatus.running) {
    return res.status(409).json({ error: "Backfill already running", status: diagBackfillStatus });
  }

  try {
    // Find all appointments with diagnoses in JSONB but patient has none in diagnoses table
    const { rows: appts } = await pool.query(`
      SELECT DISTINCT ON (a.patient_id)
        a.id, a.patient_id, a.healthray_id, a.appointment_date, a.healthray_diagnoses
      FROM appointments a
      WHERE a.patient_id IS NOT NULL
        AND a.healthray_diagnoses IS NOT NULL
        AND jsonb_typeof(a.healthray_diagnoses) = 'array'
        AND jsonb_array_length(a.healthray_diagnoses) > 0
        AND NOT EXISTS (
          SELECT 1 FROM diagnoses d WHERE d.patient_id = a.patient_id
        )
      ORDER BY a.patient_id, a.appointment_date DESC
    `);

    if (appts.length === 0) {
      log("Diagnoses", "No patients need backfill — already up to date");
      return res.json({ success: true, message: "No patients need backfill", synced: 0 });
    }

    Object.assign(diagBackfillStatus, {
      running: true,
      total: appts.length,
      done: 0,
      errors: 0,
      startedAt: Date.now(),
    });
    log("Diagnoses", `Starting bulk backfill — ${appts.length} patients to process`);

    // Respond immediately so the caller doesn't timeout
    res.json({
      success: true,
      started: true,
      total: appts.length,
      statusUrl: "/api/sync/backfill/diagnoses-all/status",
    });

    // Run in background
    (async () => {
      for (const appt of appts) {
        try {
          await syncDiagnoses(appt.patient_id, appt.healthray_id, appt.healthray_diagnoses);
          diagBackfillStatus.done++;

          // Log progress every 50 patients
          if (diagBackfillStatus.done % 50 === 0 || diagBackfillStatus.done === appts.length) {
            const pct = Math.round((diagBackfillStatus.done / appts.length) * 100);
            log(
              "Diagnoses",
              `Progress: ${diagBackfillStatus.done}/${appts.length} (${pct}%) — errors: ${diagBackfillStatus.errors}`,
            );
          }
        } catch (e) {
          diagBackfillStatus.errors++;
          error("Diagnoses", `patient_id ${appt.patient_id}: ${e.message}`);
        }
      }

      const elapsed = Math.round((Date.now() - diagBackfillStatus.startedAt) / 1000);
      log(
        "Diagnoses",
        `Bulk backfill complete — ${diagBackfillStatus.done} synced, ${diagBackfillStatus.errors} errors, ${elapsed}s elapsed`,
      );
      diagBackfillStatus.running = false;
    })();
  } catch (e) {
    diagBackfillStatus.running = false;
    handleError(res, e, "Bulk backfill diagnoses");
  }
});

// ── Bulk backfill medicines: shared state for progress tracking ───────────────
const medsBackfillStatus = { running: false, total: 0, done: 0, errors: 0, startedAt: null };

// GET /api/sync/backfill/medicines-all/status
router.get("/sync/backfill/medicines-all/status", (_req, res) => {
  const { running, total, done, errors, startedAt } = medsBackfillStatus;
  const elapsed = startedAt ? Math.round((Date.now() - startedAt) / 1000) : 0;
  const rate = elapsed > 0 ? (done / elapsed).toFixed(1) : 0;
  const remaining = rate > 0 ? Math.round((total - done) / rate) : null;
  res.json({
    running,
    total,
    done,
    errors,
    elapsed: `${elapsed}s`,
    rate: `${rate}/s`,
    remainingEst: remaining ? `${remaining}s` : null,
  });
});

// ── Bulk backfill medicines from existing JSONB data (no AI re-parse needed) ─
// POST /api/sync/backfill/medicines-all
// Reads appointments.healthray_medications JSONB and syncs to medications table
// Targets appointments whose medicines haven't been synced yet (by healthray_id in notes)
// Safe to re-run — syncMedications uses ON CONFLICT upsert
router.post("/sync/backfill/medicines-all", async (req, res) => {
  if (medsBackfillStatus.running) {
    return res.status(409).json({ error: "Backfill already running", status: medsBackfillStatus });
  }

  try {
    // Find appointments with medicines in JSONB not yet reflected in medications table
    const { rows: appts } = await pool.query(`
      SELECT a.id, a.patient_id, a.healthray_id, a.appointment_date, a.healthray_medications
      FROM appointments a
      WHERE a.patient_id IS NOT NULL
        AND a.healthray_id IS NOT NULL
        AND a.healthray_medications IS NOT NULL
        AND jsonb_typeof(a.healthray_medications) = 'array'
        AND jsonb_array_length(a.healthray_medications) > 0
        AND NOT EXISTS (
          SELECT 1 FROM medications m
          WHERE m.patient_id = a.patient_id
            AND m.notes LIKE '%' || a.healthray_id || '%'
        )
      ORDER BY a.appointment_date ASC
    `);

    if (appts.length === 0) {
      log("Medicines", "No appointments need backfill — already up to date");
      return res.json({ success: true, message: "No appointments need backfill", synced: 0 });
    }

    Object.assign(medsBackfillStatus, {
      running: true,
      total: appts.length,
      done: 0,
      errors: 0,
      startedAt: Date.now(),
    });
    log("Medicines", `Starting bulk backfill — ${appts.length} appointments to process`);

    // Respond immediately so the caller doesn't timeout
    res.json({
      success: true,
      started: true,
      total: appts.length,
      statusUrl: "/api/sync/backfill/medicines-all/status",
    });

    // Run in background
    (async () => {
      for (const appt of appts) {
        try {
          await syncMedications(
            appt.patient_id,
            appt.healthray_id,
            appt.appointment_date,
            appt.healthray_medications,
          );
          medsBackfillStatus.done++;

          if (medsBackfillStatus.done % 100 === 0 || medsBackfillStatus.done === appts.length) {
            const pct = Math.round((medsBackfillStatus.done / appts.length) * 100);
            log(
              "Medicines",
              `Progress: ${medsBackfillStatus.done}/${appts.length} (${pct}%) — errors: ${medsBackfillStatus.errors}`,
            );
          }
        } catch (e) {
          medsBackfillStatus.errors++;
          error("Medicines", `appt_id ${appt.id}: ${e.message}`);
        }
      }

      const elapsed = Math.round((Date.now() - medsBackfillStatus.startedAt) / 1000);
      log(
        "Medicines",
        `Bulk backfill complete — ${medsBackfillStatus.done} appointments synced, ${medsBackfillStatus.errors} errors, ${elapsed}s elapsed`,
      );
      medsBackfillStatus.running = false;
    })();
  } catch (e) {
    medsBackfillStatus.running = false;
    handleError(res, e, "Bulk backfill medicines");
  }
});

// ── Bulk extract medicines from all HealthRay prescription PDFs ──────────────
// POST /api/sync/healthray/extract-prescriptions
// Finds all healthray prescription docs without extracted_data, downloads each PDF,
// extracts medicines via Claude vision, syncs to medications table.
// Processes one at a time to avoid API rate limits.
const prescriptionExtractStatus = {
  running: false,
  total: 0,
  done: 0,
  extracted: 0,
  errors: 0,
  startedAt: null,
};

router.get("/sync/healthray/extract-prescriptions/status", (_req, res) => {
  const { running, total, done, extracted, errors, startedAt } = prescriptionExtractStatus;
  const elapsed = startedAt ? Math.round((Date.now() - startedAt) / 1000) : 0;
  res.json({ running, total, done, extracted, errors, elapsed: `${elapsed}s` });
});

router.post("/sync/healthray/extract-prescriptions", async (req, res) => {
  if (prescriptionExtractStatus.running) {
    return res
      .status(409)
      .json({ error: "Extraction already running", status: prescriptionExtractStatus });
  }

  try {
    const { rows: docs } = await pool.query(`
      SELECT d.id, d.patient_id, d.file_url, d.doc_date
      FROM documents d
      WHERE d.source = 'healthray'
        AND d.doc_type = 'prescription'
        AND d.file_url IS NOT NULL
        AND d.extracted_data IS NULL
        AND d.patient_id IS NOT NULL
      ORDER BY d.doc_date DESC
    `);

    if (docs.length === 0) {
      return res.json({
        success: true,
        message: "No unextracted prescription PDFs found",
        total: 0,
      });
    }

    Object.assign(prescriptionExtractStatus, {
      running: true,
      total: docs.length,
      done: 0,
      extracted: 0,
      errors: 0,
      startedAt: Date.now(),
    });

    res.json({
      success: true,
      started: true,
      total: docs.length,
      statusUrl: "/api/sync/healthray/extract-prescriptions/status",
    });

    (async () => {
      const CONCURRENCY = 10;

      async function processDoc(doc) {
        try {
          const extracted = await extractPrescription(doc.file_url);
          const meds = extracted.medications || [];

          await pool.query(`UPDATE documents SET extracted_data = $1::jsonb WHERE id = $2`, [
            JSON.stringify(extracted),
            doc.id,
          ]);

          if (meds.length > 0) {
            const rxDate =
              extracted.visit_date ||
              (doc.doc_date
                ? new Date(doc.doc_date).toISOString().split("T")[0]
                : new Date().toISOString().split("T")[0]);

            await pool.query(`DELETE FROM medications WHERE document_id = $1`, [doc.id]);
            for (const m of meds) {
              if (!m?.name) continue;
              await pool
                .query(
                  `INSERT INTO medications
                   (patient_id, document_id, name, dose, frequency, timing, route, is_new, is_active, source, started_date)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, false, true, 'report_extract', $8)
                 ON CONFLICT (patient_id, UPPER(COALESCE(pharmacy_match, name))) WHERE is_active = true
                 DO UPDATE SET document_id = EXCLUDED.document_id,
                   dose = COALESCE(EXCLUDED.dose, medications.dose),
                   frequency = COALESCE(EXCLUDED.frequency, medications.frequency),
                   timing = COALESCE(EXCLUDED.timing, medications.timing),
                   updated_at = NOW()`,
                  [
                    doc.patient_id,
                    doc.id,
                    (m.name || "").slice(0, 200),
                    (m.dose || "").slice(0, 100),
                    (m.frequency || "").slice(0, 100),
                    (m.timing || "").slice(0, 100),
                    (m.route || "Oral").slice(0, 50),
                    rxDate,
                  ],
                )
                .catch(() => {});
            }
            prescriptionExtractStatus.extracted += meds.length;
          }
          prescriptionExtractStatus.done++;
        } catch (e) {
          prescriptionExtractStatus.errors++;
          error("Prescriptions", `doc ${doc.id}: ${e.message}`);
          prescriptionExtractStatus.done++;
        }
      }

      // Process in batches of CONCURRENCY
      for (let i = 0; i < docs.length; i += CONCURRENCY) {
        await Promise.allSettled(docs.slice(i, i + CONCURRENCY).map(processDoc));
      }

      log(
        "Prescriptions",
        `Extraction complete — ${prescriptionExtractStatus.done}/${prescriptionExtractStatus.total} docs, ${prescriptionExtractStatus.extracted} medicines, ${prescriptionExtractStatus.errors} errors`,
      );
      prescriptionExtractStatus.running = false;
    })();
  } catch (e) {
    prescriptionExtractStatus.running = false;
    handleError(res, e, "Bulk prescription extraction");
  }
});

// ── Bulk backfill stopped/previous meds from healthray_previous_medications JSONB ─
// POST /api/sync/healthray/backfill-stopped-meds
// Reads every appointment that has healthray_previous_medications stored and syncs
// stopped medicines to the medications table. Safe to re-run.
const stoppedMedsBackfillStatus = { running: false, total: 0, done: 0, errors: 0, startedAt: null };

router.get("/sync/healthray/backfill-stopped-meds/status", (_req, res) => {
  const { running, total, done, errors, startedAt } = stoppedMedsBackfillStatus;
  const elapsed = startedAt ? Math.round((Date.now() - startedAt) / 1000) : 0;
  res.json({ running, total, done, errors, elapsed: `${elapsed}s` });
});

router.post("/sync/healthray/backfill-stopped-meds", async (req, res) => {
  if (stoppedMedsBackfillStatus.running) {
    return res
      .status(409)
      .json({ error: "Backfill already running", status: stoppedMedsBackfillStatus });
  }

  try {
    const { rows: appts } = await pool.query(`
      SELECT a.id, a.patient_id, a.healthray_id, a.healthray_previous_medications
      FROM appointments a
      WHERE a.patient_id IS NOT NULL
        AND a.healthray_id IS NOT NULL
        AND a.healthray_previous_medications IS NOT NULL
        AND jsonb_typeof(a.healthray_previous_medications) = 'array'
        AND jsonb_array_length(a.healthray_previous_medications) > 0
      ORDER BY a.appointment_date ASC
    `);

    if (appts.length === 0) {
      return res.json({
        success: true,
        message: "No appointments with previous medications data",
        synced: 0,
      });
    }

    Object.assign(stoppedMedsBackfillStatus, {
      running: true,
      total: appts.length,
      done: 0,
      errors: 0,
      startedAt: Date.now(),
    });

    res.json({
      success: true,
      started: true,
      total: appts.length,
      statusUrl: "/api/sync/healthray/backfill-stopped-meds/status",
    });

    (async () => {
      for (const appt of appts) {
        try {
          await syncStoppedMedications(
            appt.patient_id,
            appt.healthray_id,
            appt.healthray_previous_medications,
          );
          stoppedMedsBackfillStatus.done++;
        } catch (e) {
          stoppedMedsBackfillStatus.errors++;
        }
      }
      log(
        "Medicines",
        `Stopped meds backfill complete — ${stoppedMedsBackfillStatus.done} appointments, ${stoppedMedsBackfillStatus.errors} errors`,
      );
      stoppedMedsBackfillStatus.running = false;
    })();
  } catch (e) {
    stoppedMedsBackfillStatus.running = false;
    handleError(res, e, "Backfill stopped medicines");
  }
});

// POST /api/sync/backfill/fix-diagnosis-typos
// Deactivates known typo diagnosis_id rows where the correct canonical already exists.
router.post("/sync/backfill/fix-diagnosis-typos", async (req, res) => {
  try {
    const TYPO_MAP = {
      balanoprosthitis: "balanoposthitis",
      thallasemia_minor: "thalassemia_minor",
      thallasemia_major: "thalassemia_major",
      thallasemia: "thalassemia",
      sunclinical_hypothyrodism: "hypothyroidism",
      subclinical_hypothyrodism: "hypothyroidism",
      subclinical_hypothyroidism: "hypothyroidism",
      achillis_tendinitis: "achilles_tendinitis",
      seropositive_hashimoto_s_thyroiditis: "hashimoto_thyroiditis",
      seronegative_hashimoto_s_thyroiditis: "hashimoto_thyroiditis",
      type_2_pge: "pge_type_2",
      hypo: "hypothyroidism",
      osas: "obstructive_sleep_apnea",
    };

    let totalDeactivated = 0;
    const details = [];

    for (const [typoId, correctId] of Object.entries(TYPO_MAP)) {
      // Deactivate typo row only when the correct row also exists for the same patient
      const { rowCount } = await pool.query(
        `UPDATE diagnoses SET is_active = false, updated_at = NOW()
         WHERE diagnosis_id = $1
           AND is_active = true
           AND patient_id IN (
             SELECT patient_id FROM diagnoses WHERE diagnosis_id = $2 AND is_active = true
           )`,
        [typoId, correctId],
      );
      if (rowCount > 0) {
        details.push(`${typoId} → ${correctId}: deactivated ${rowCount} rows`);
        totalDeactivated += rowCount;
      }
    }

    res.json({ success: true, totalDeactivated, details });
  } catch (e) {
    handleError(res, e, "Fix diagnosis typos");
  }
});

// ── Dedup diagnoses: remove duplicates created by AI name variations ──────────
// POST /api/sync/backfill/dedup-diagnoses
// Deletes lower-priority duplicate diagnosis rows per patient.
// Priority: Active > Monitoring > Resolved. Within same status, keeps most recent.
router.post("/sync/backfill/dedup-diagnoses", async (req, res) => {
  try {
    // Step 1: Delete exact label duplicates (same patient, same label case-insensitive)
    const exactDup = await pool.query(`
      DELETE FROM diagnoses
      WHERE id IN (
        SELECT id FROM (
          SELECT id,
            ROW_NUMBER() OVER (
              PARTITION BY patient_id, LOWER(TRIM(label))
              ORDER BY
                CASE LOWER(status)
                  WHEN 'active' THEN 1
                  WHEN 'monitoring' THEN 2
                  WHEN 'resolved' THEN 3
                  ELSE 4
                END ASC,
                updated_at DESC,
                created_at DESC
            ) AS rn
          FROM diagnoses
        ) ranked
        WHERE rn > 1
      )
      RETURNING id
    `);

    // Step 2: Delete duplicates with same diagnosis_id (shouldn't exist but clean up)
    const idDup = await pool.query(`
      DELETE FROM diagnoses
      WHERE id IN (
        SELECT id FROM (
          SELECT id,
            ROW_NUMBER() OVER (
              PARTITION BY patient_id, diagnosis_id
              ORDER BY
                CASE LOWER(status)
                  WHEN 'active' THEN 1
                  WHEN 'monitoring' THEN 2
                  WHEN 'resolved' THEN 3
                  ELSE 4
                END ASC,
                updated_at DESC,
                created_at DESC
            ) AS rn
          FROM diagnoses
        ) ranked
        WHERE rn > 1
      )
      RETURNING id
    `);

    res.json({
      success: true,
      deletedExactLabelDuplicates: exactDup.rowCount,
      deletedSameIdDuplicates: idDup.rowCount,
      totalDeleted: exactDup.rowCount + idDup.rowCount,
    });
  } catch (e) {
    handleError(res, e, "Dedup diagnoses");
  }
});

// ── Backfill pharmacy_match on existing healthray meds (one-time fix) ─────────
// Sets pharmacy_match = normalized name (strips TAB/INJ/CAP prefix) so the
// ON CONFLICT dedup key works correctly on future syncs.
// POST /api/sync/backfill/pharmacy-match
router.post("/sync/backfill/pharmacy-match", async (req, res) => {
  const PREFIX_RE = `'^(TAB[.]?[[:space:]]+|TABLET[[:space:]]+|INJ[.]?[[:space:]]+|INJECTION[[:space:]]+|CAP[.]?[[:space:]]+|CAPSULE[[:space:]]+|SYP[.]?[[:space:]]+|SYRUP[[:space:]]+|DROPS?[[:space:]]+|OINT[.]?[[:space:]]+|OINTMENT[[:space:]]+|GEL[[:space:]]+|CREAM[[:space:]]+|SPRAY[[:space:]]+|SACHET[[:space:]]+|PWD[.]?[[:space:]]+|POWDER[[:space:]]+)'`;
  const NORM = (col) => `UPPER(TRIM(REGEXP_REPLACE(${col}, ${PREFIX_RE}, '', 'i')))`;

  try {
    await pool.query("BEGIN");

    // Step 1: DELETE duplicate active healthray rows — keep newest per (patient, normalized name)
    const dedupActive = await pool.query(`
      DELETE FROM medications WHERE id IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (
            PARTITION BY patient_id, ${NORM("name")}
            ORDER BY started_date DESC NULLS LAST, created_at DESC
          ) rn
          FROM medications WHERE is_active = true AND source = 'healthray'
        ) x WHERE rn > 1
      ) RETURNING id
    `);

    // Step 2: DELETE duplicate inactive healthray rows — keep newest per (patient, normalized name)
    const dedupInactive = await pool.query(`
      DELETE FROM medications WHERE id IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (
            PARTITION BY patient_id, ${NORM("name")}
            ORDER BY started_date DESC NULLS LAST, created_at DESC
          ) rn
          FROM medications WHERE is_active = false AND source = 'healthray'
        ) x WHERE rn > 1
      ) RETURNING id
    `);

    // Step 3: Set pharmacy_match, skipping any row that would still conflict
    const updated = await pool.query(`
      UPDATE medications m
      SET pharmacy_match = ${NORM("m.name")}
      WHERE m.pharmacy_match IS NULL
        AND m.source = 'healthray'
        AND NOT EXISTS (
          SELECT 1 FROM medications m2
          WHERE m2.patient_id = m.patient_id
            AND m2.id != m.id
            AND m2.is_active = m.is_active
            AND UPPER(COALESCE(m2.pharmacy_match, m2.name)) = ${NORM("m.name")}
        )
      RETURNING id
    `);

    await pool.query("COMMIT");
    res.json({
      success: true,
      dedupedActive: dedupActive.rowCount,
      dedupedInactive: dedupInactive.rowCount,
      updated: updated.rowCount,
    });
  } catch (e) {
    await pool.query("ROLLBACK");
    res.status(500).json({ error: e.message, detail: e.detail || null });
  }
});

// ── GET /api/sync/debug/audit-all — scan every patient for data quality issues ─
// Checks: duplicate diagnosis_ids, stale diagnosis_ids, duplicate active meds
router.get("/sync/debug/audit-all", async (req, res) => {
  try {
    // 1. Duplicate diagnosis_id per patient (both active)
    const dupDx = await pool.query(`
      SELECT p.file_no, p.name, d.patient_id,
             d.diagnosis_id,
             COUNT(*) AS cnt,
             array_agg(d.id ORDER BY d.id) AS ids,
             array_agg(d.label ORDER BY d.id) AS labels,
             array_agg(d.is_active::text ORDER BY d.id) AS actives
      FROM diagnoses d
      JOIN patients p ON p.id = d.patient_id
      GROUP BY p.file_no, p.name, d.patient_id, d.diagnosis_id
      HAVING COUNT(*) > 1
      ORDER BY p.file_no, d.diagnosis_id
    `);

    // 2. Stale/renamed diagnosis_ids still present
    const STALE_IDS = [
      "type_2_dm",
      "t2dm",
      "dm2",
      "asld",
      "nafld",
      "mafld",
      "nephropathy",
      "neuropathy",
      "aidp_post_ivig_transfusion",
      "htn",
      "essential_hypertension",
      "cad",
      "mng_with_retristernal_extension",
      "sunclinical_hypothyrodism",
      "subclinical_hypothyrodism",
      "subclinical_hypothyroidism",
      "thallasemia_minor",
      "thallasemia_major",
      "thallasemia",
      "hashimoto_s_thyroiditis",
      "mild_dr",
      "m_a_s_l_d",
      "achillis_tendinitis",
      "ca_colon_s_p_op_chemo",
      "gsd_s_p_op",
      "tkr_b_l_2024",
    ];
    const staleDx = await pool.query(
      `
      SELECT p.file_no, p.name, d.id, d.patient_id, d.diagnosis_id, d.label, d.is_active
      FROM diagnoses d
      JOIN patients p ON p.id = d.patient_id
      WHERE d.diagnosis_id = ANY($1::text[])
      ORDER BY p.file_no, d.diagnosis_id
    `,
      [STALE_IDS],
    );

    // 3. Duplicate active medications per patient (same name case-insensitive)
    const dupMeds = await pool.query(`
      SELECT p.file_no, p.name, m.patient_id,
             UPPER(TRIM(m.name)) AS norm_name,
             COUNT(*) AS cnt,
             array_agg(m.id ORDER BY m.id) AS ids,
             array_agg(m.name ORDER BY m.id) AS names,
             array_agg(m.dose ORDER BY m.id) AS dosages
      FROM medications m
      JOIN patients p ON p.id = m.patient_id
      WHERE m.is_active = true
      GROUP BY p.file_no, p.name, m.patient_id, UPPER(TRIM(m.name))
      HAVING COUNT(*) > 1
      ORDER BY p.file_no, norm_name
    `);

    // Build per-patient issue map
    const patientMap = {};
    const addIssue = (fileNo, patName, issue) => {
      if (!patientMap[fileNo]) patientMap[fileNo] = { fileNo, name: patName, issues: [] };
      patientMap[fileNo].issues.push(issue);
    };

    for (const r of dupDx.rows) {
      addIssue(r.file_no, r.name, {
        type: "duplicate_diagnosis",
        diagnosis_id: r.diagnosis_id,
        count: parseInt(r.cnt),
        ids: r.ids,
        labels: r.labels,
        is_active: r.actives,
      });
    }
    for (const r of staleDx.rows) {
      addIssue(r.file_no, r.name, {
        type: "stale_diagnosis_id",
        id: r.id,
        stale_id: r.diagnosis_id,
        label: r.label,
        is_active: r.is_active,
      });
    }
    for (const r of dupMeds.rows) {
      addIssue(r.file_no, r.name, {
        type: "duplicate_active_med",
        norm_name: r.norm_name,
        count: parseInt(r.cnt),
        ids: r.ids,
        names: r.names,
        dosages: r.dosages,
      });
    }

    const patients = Object.values(patientMap).sort((a, b) =>
      (a.fileNo || "").localeCompare(b.fileNo || ""),
    );
    const totalIssues = patients.reduce((s, p) => s + p.issues.length, 0);

    res.json({
      summary: {
        patientsWithIssues: patients.length,
        totalIssues,
        duplicateDiagnoses: dupDx.rowCount,
        staleDiagnoses: staleDx.rowCount,
        duplicateActiveMeds: dupMeds.rowCount,
      },
      patients,
    });
  } catch (e) {
    res.status(500).json({ error: e.message, detail: e.detail || null });
  }
});

// ── POST /api/sync/debug/fix-all — auto-fix all safe data quality issues ───────
// Safe fixes: dedup diagnoses (same id/label), deactivate stale ids, dedup active meds
router.post("/sync/debug/fix-all", async (req, res) => {
  const { dryRun = false } = req.body || {};
  try {
    await pool.query("BEGIN");

    // 1. Delete exact label duplicates — keep best (Active > Monitoring > Resolved, then newest)
    const exactDup = await pool.query(`
      DELETE FROM diagnoses
      WHERE id IN (
        SELECT id FROM (
          SELECT id,
            ROW_NUMBER() OVER (
              PARTITION BY patient_id, LOWER(TRIM(label))
              ORDER BY
                CASE LOWER(status) WHEN 'active' THEN 1 WHEN 'monitoring' THEN 2 WHEN 'resolved' THEN 3 ELSE 4 END,
                is_active DESC,
                updated_at DESC, created_at DESC
            ) rn
          FROM diagnoses
        ) x WHERE rn > 1
      )
      RETURNING id, patient_id, label, diagnosis_id
    `);

    // 2. Delete same diagnosis_id duplicates — keep best
    const idDup = await pool.query(`
      DELETE FROM diagnoses
      WHERE id IN (
        SELECT id FROM (
          SELECT id,
            ROW_NUMBER() OVER (
              PARTITION BY patient_id, diagnosis_id
              ORDER BY
                CASE LOWER(status) WHEN 'active' THEN 1 WHEN 'monitoring' THEN 2 WHEN 'resolved' THEN 3 ELSE 4 END,
                is_active DESC,
                updated_at DESC, created_at DESC
            ) rn
          FROM diagnoses
        ) x WHERE rn > 1
      )
      RETURNING id, patient_id, label, diagnosis_id
    `);

    // 3. Rename stale diagnosis_ids to their canonical equivalents
    // Strategy:
    //   a) Where the canonical row already exists for this patient → delete the stale row
    //   b) Where no canonical row exists → rename the stale row in place
    const RENAMES = {
      type_2_dm: "type_2_diabetes_mellitus",
      t2dm: "type_2_diabetes_mellitus",
      dm2: "type_2_diabetes_mellitus",
      asld: "masld",
      nafld: "masld",
      mafld: "masld",
      nephropathy: "diabetic_nephropathy",
      neuropathy: "diabetic_neuropathy",
      aidp_post_ivig_transfusion: "aidp",
      htn: "hypertension",
      essential_hypertension: "hypertension",
      cad: "coronary_artery_disease",
      mng_with_retristernal_extension: "mng_with_retrosternal_extension",
      sunclinical_hypothyrodism: "hypothyroidism",
      subclinical_hypothyrodism: "hypothyroidism",
      subclinical_hypothyroidism: "hypothyroidism",
      thallasemia_minor: "thalassemia_minor",
      thallasemia_major: "thalassemia_major",
      thallasemia: "thalassemia",
      hashimoto_s_thyroiditis: "hashimoto_thyroiditis",
      mild_dr: "diabetic_retinopathy",
      m_a_s_l_d: "masld",
      achillis_tendinitis: "achilles_tendinitis",
      ca_colon_s_p_op_chemo: "ca_colon",
      gsd_s_p_op: "gsd",
      tkr_b_l_2024: "tkr_b_l",
    };
    const STALE_IDS = Object.keys(RENAMES);
    let staleDeleted = 0,
      staleRenamed = 0;
    const staleDetails = [];
    for (const [staleId, canonicalId] of Object.entries(RENAMES)) {
      // a) Delete stale row where patient already has canonical
      const del = await pool.query(
        `
        DELETE FROM diagnoses d
        USING diagnoses canon
        WHERE d.diagnosis_id = $1
          AND canon.patient_id = d.patient_id
          AND canon.diagnosis_id = $2
        RETURNING d.id, d.patient_id, d.label
      `,
        [staleId, canonicalId],
      );
      staleDeleted += del.rowCount;
      for (const r of del.rows)
        staleDetails.push({ action: "deleted", staleId, canonicalId, ...r });

      // b) Rename stale row where no canonical exists yet
      const upd = await pool.query(
        `
        UPDATE diagnoses SET diagnosis_id = $2, updated_at = NOW()
        WHERE diagnosis_id = $1
          AND NOT EXISTS (
            SELECT 1 FROM diagnoses c
            WHERE c.patient_id = diagnoses.patient_id AND c.diagnosis_id = $2
          )
        RETURNING id, patient_id, label
      `,
        [staleId, canonicalId],
      );
      staleRenamed += upd.rowCount;
      for (const r of upd.rows)
        staleDetails.push({ action: "renamed", staleId, canonicalId, ...r });
    }

    // After renames, dedup again in case two stale ids renamed to same canonical
    const postRenameDup = await pool.query(`
      DELETE FROM diagnoses
      WHERE id IN (
        SELECT id FROM (
          SELECT id,
            ROW_NUMBER() OVER (
              PARTITION BY patient_id, diagnosis_id
              ORDER BY
                CASE LOWER(status) WHEN 'active' THEN 1 WHEN 'monitoring' THEN 2 WHEN 'resolved' THEN 3 ELSE 4 END,
                is_active DESC, updated_at DESC, created_at DESC
            ) rn
          FROM diagnoses
        ) x WHERE rn > 1
      )
      RETURNING id, patient_id, label, diagnosis_id
    `);

    // 4. Remove duplicate active medications — keep newest per (patient, normalised name)
    // Delete rather than deactivate to avoid unique constraint on inactive meds
    const PREFIX_RE = `'^(TAB[.]?[[:space:]]+|TABLET[[:space:]]+|INJ[.]?[[:space:]]+|INJECTION[[:space:]]+|CAP[.]?[[:space:]]+|CAPSULE[[:space:]]+|SYP[.]?[[:space:]]+|SYRUP[[:space:]]+|DROPS?[[:space:]]+|OINT[.]?[[:space:]]+|CREAM[[:space:]]+|SPRAY[[:space:]]+|SACHET[[:space:]]+)'`;
    const NORM = `UPPER(TRIM(REGEXP_REPLACE(name, ${PREFIX_RE}, '', 'i')))`;
    const dupMedsStopped = await pool.query(`
      DELETE FROM medications
      WHERE id IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (
            PARTITION BY patient_id, ${NORM}
            ORDER BY started_date DESC NULLS LAST, created_at DESC
          ) rn
          FROM medications WHERE is_active = true
        ) x WHERE rn > 1
      )
      RETURNING id, patient_id, name
    `);

    if (dryRun) {
      await pool.query("ROLLBACK");
    } else {
      await pool.query("COMMIT");
    }

    res.json({
      success: true,
      dryRun,
      fixes: {
        exactLabelDupsRemoved: exactDup.rowCount,
        sameIdDupsRemoved: idDup.rowCount,
        staleIdsDeleted: staleDeleted,
        staleIdsRenamed: staleRenamed,
        postRenameDupsRemoved: postRenameDup.rowCount,
        dupMedsStopped: dupMedsStopped.rowCount,
      },
      details: {
        exactLabelDups: exactDup.rows,
        sameIdDups: idDup.rows,
        staleChanges: staleDetails.slice(0, 200),
        postRenameDups: postRenameDup.rows.slice(0, 100),
        dupMeds: dupMedsStopped.rows,
      },
    });
  } catch (e) {
    await pool.query("ROLLBACK");
    res.status(500).json({ error: e.message, detail: e.detail || null });
  }
});

// ── Bulk medication dedup: keep newest row per canonical name, stop older dupes ─
// POST /api/sync/audit/dedup-meds
// Pure SQL — no AI calls, runs in seconds. Safe to re-run.
const dedupMedsStatus = { running: false, patients: 0, stopped: 0, startedAt: null };

router.get("/sync/audit/dedup-meds/status", (_req, res) => {
  const elapsed = dedupMedsStatus.startedAt
    ? Math.round((Date.now() - dedupMedsStatus.startedAt) / 1000)
    : 0;
  res.json({ ...dedupMedsStatus, elapsed: `${elapsed}s` });
});

router.post("/sync/audit/dedup-meds", async (req, res) => {
  if (dedupMedsStatus.running)
    return res.status(409).json({ error: "Already running", status: dedupMedsStatus });

  try {
    Object.assign(dedupMedsStatus, {
      running: true,
      patients: 0,
      stopped: 0,
      startedAt: Date.now(),
    });

    // JS mirror of normalizeMedName() in db.js
    const normalizeName = (name) =>
      (name || "")
        .replace(
          /^(tab\.?\s+|tablet\s+|inj\.?\s+|injection\s+|cap\.?\s+|capsule\s+|syp\.?\s+|syrup\s+|drops?\s+|oint\.?\s+|ointment\s+|gel\s+|cream\s+|spray\s+|sachet\s+|pwd\.?\s+|powder\s+)/i,
          "",
        )
        .replace(/\s*\([\d\s+./mg%KkUuIL]+\)\s*$/i, "")
        .trim()
        .toUpperCase();

    // Step 1: rows WITH pharmacy_match — DELETE older dupes, keep newest per UPPER(pharmacy_match).
    // DELETE (not mark inactive) to avoid unique constraint on inactive meds.
    const r1 = await pool.query(
      `DELETE FROM medications
       WHERE is_active = true AND pharmacy_match IS NOT NULL
         AND id NOT IN (
           SELECT DISTINCT ON (patient_id, UPPER(pharmacy_match)) id
           FROM medications
           WHERE is_active = true AND pharmacy_match IS NOT NULL
           ORDER BY patient_id, UPPER(pharmacy_match), started_date DESC NULLS LAST, created_at DESC
         )
       RETURNING patient_id`,
    );

    // Steps 2 & 3: fetch all active meds with null pharmacy_match, normalise in JS,
    // keep newest per (patient_id, canonicalName), collect IDs to delete.
    const { rows: nullMeds } = await pool.query(
      `SELECT id, patient_id, name, started_date, created_at
       FROM medications
       WHERE is_active = true AND pharmacy_match IS NULL
       ORDER BY patient_id, started_date DESC NULLS LAST, created_at DESC`,
    );

    // Also fetch active meds WITH pharmacy_match to detect old-null-match duplicates
    const { rows: canonicalMeds } = await pool.query(
      `SELECT patient_id, UPPER(pharmacy_match) AS canonical
       FROM medications
       WHERE is_active = true AND pharmacy_match IS NOT NULL`,
    );
    const canonicalSet = new Set(canonicalMeds.map((r) => `${r.patient_id}::${r.canonical}`));

    // For null-pm rows: group by (patient_id, normalised_name), keep first (newest)
    const seen = new Set();
    const toDelete = [];
    for (const m of nullMeds) {
      const canonical = normalizeName(m.name);
      if (!canonical) continue;
      const canonKey = `${m.patient_id}::${canonical}`;
      if (canonicalSet.has(canonKey) || seen.has(canonKey)) {
        toDelete.push(m.id);
      } else {
        seen.add(canonKey);
      }
    }

    let r2r3Count = 0;
    if (toDelete.length > 0) {
      for (let i = 0; i < toDelete.length; i += 500) {
        const chunk = toDelete.slice(i, i + 500);
        const placeholders = chunk.map((_, j) => `$${j + 1}`).join(",");
        const result = await pool.query(
          `DELETE FROM medications WHERE id IN (${placeholders})`,
          chunk,
        );
        r2r3Count += result.rowCount;
      }
    }

    const totalDeleted = r1.rowCount + r2r3Count;
    const affectedPatients = new Set([
      ...r1.rows.map((r) => r.patient_id),
      ...nullMeds.filter((m) => toDelete.includes(m.id)).map((m) => m.patient_id),
    ]).size;

    Object.assign(dedupMedsStatus, {
      running: false,
      patients: affectedPatients,
      stopped: totalDeleted,
    });

    res.json({
      success: true,
      patientsAffected: affectedPatients,
      medsDeleted: totalDeleted,
      breakdown: {
        withPharmacyMatch: r1.rowCount,
        nullMatchNormalised: r2r3Count,
      },
    });
  } catch (e) {
    dedupMedsStatus.running = false;
    handleError(res, e, "Bulk med dedup");
  }
});

// ── Patient data audit: find missing diagnoses, missing meds, duplicates ──────
// GET /api/sync/audit/patients
// Returns per-patient report of data quality issues across the whole DB.
// Safe read-only — makes no changes.
router.get("/sync/audit/patients", async (_req, res) => {
  try {
    // 1. Patients with 0 active diagnoses
    const { rows: noDx } = await pool.query(
      `SELECT p.id, p.name, p.file_no, p.phone,
              COUNT(d.id) AS active_dx
       FROM patients p
       LEFT JOIN diagnoses d ON d.patient_id = p.id AND d.is_active = true
       GROUP BY p.id, p.name, p.file_no, p.phone
       HAVING COUNT(d.id) = 0
       ORDER BY p.name`,
    );

    // 2. Appointments with clinical notes but empty diagnoses JSONB
    //    (root cause: fast-path skip or AI parse failure)
    const { rows: emptyDxAppts } = await pool.query(
      `SELECT a.id AS appt_id, a.patient_id, p.name, p.file_no,
              a.appointment_date,
              LENGTH(a.healthray_clinical_notes) AS notes_len,
              jsonb_array_length(COALESCE(a.healthray_diagnoses, '[]'::jsonb)) AS dx_count,
              jsonb_array_length(COALESCE(a.healthray_medications, '[]'::jsonb)) AS meds_count
       FROM appointments a
       JOIN patients p ON p.id = a.patient_id
       WHERE a.healthray_clinical_notes IS NOT NULL
         AND LENGTH(a.healthray_clinical_notes) > 50
         AND (
           a.healthray_diagnoses IS NULL
           OR jsonb_array_length(a.healthray_diagnoses) = 0
         )
       ORDER BY a.appointment_date DESC`,
    );

    // 3. Appointments with clinical notes but empty medications JSONB
    const { rows: emptyMedAppts } = await pool.query(
      `SELECT a.id AS appt_id, a.patient_id, p.name, p.file_no,
              a.appointment_date,
              LENGTH(a.healthray_clinical_notes) AS notes_len,
              jsonb_array_length(COALESCE(a.healthray_medications, '[]'::jsonb)) AS meds_count
       FROM appointments a
       JOIN patients p ON p.id = a.patient_id
       WHERE a.healthray_clinical_notes IS NOT NULL
         AND LENGTH(a.healthray_clinical_notes) > 50
         AND (
           a.healthray_medications IS NULL
           OR jsonb_array_length(a.healthray_medications) = 0
         )
       ORDER BY a.appointment_date DESC`,
    );

    // 4. Patients with duplicate active meds (same pharmacy_match, multiple rows)
    const { rows: dupMeds } = await pool.query(
      `SELECT p.id AS patient_id, p.name, p.file_no,
              UPPER(COALESCE(m.pharmacy_match, m.name)) AS canonical_name,
              COUNT(*) AS active_count,
              STRING_AGG(m.name || ' (id=' || m.id || ')', ', ' ORDER BY m.id) AS rows
       FROM medications m
       JOIN patients p ON p.id = m.patient_id
       WHERE m.is_active = true
       GROUP BY p.id, p.name, p.file_no, UPPER(COALESCE(m.pharmacy_match, m.name))
       HAVING COUNT(*) > 1
       ORDER BY p.name, canonical_name`,
    );

    // 5. Patients with suspiciously many active meds (>12, likely duplicates)
    const { rows: manyMeds } = await pool.query(
      `SELECT p.id, p.name, p.file_no, COUNT(m.id) AS active_med_count
       FROM patients p
       JOIN medications m ON m.patient_id = p.id AND m.is_active = true
       GROUP BY p.id, p.name, p.file_no
       HAVING COUNT(m.id) > 12
       ORDER BY active_med_count DESC`,
    );

    // 6. Patients whose latest appointment JSONB meds don't match active meds count
    const { rows: mismatch } = await pool.query(
      `WITH latest_appt AS (
         SELECT DISTINCT ON (patient_id) patient_id, id AS appt_id, appointment_date,
                jsonb_array_length(COALESCE(healthray_medications, '[]'::jsonb)) AS jsonb_med_count
         FROM appointments
         WHERE healthray_clinical_notes IS NOT NULL
           AND healthray_medications IS NOT NULL
           AND jsonb_array_length(COALESCE(healthray_medications, '[]'::jsonb)) > 0
         ORDER BY patient_id, appointment_date DESC
       ),
       active_count AS (
         SELECT patient_id, COUNT(*) AS db_med_count
         FROM medications WHERE is_active = true
         GROUP BY patient_id
       )
       SELECT p.name, p.file_no, la.appt_id, la.appointment_date,
              la.jsonb_med_count, ac.db_med_count,
              ABS(la.jsonb_med_count::int - ac.db_med_count::int) AS diff
       FROM latest_appt la
       JOIN active_count ac ON ac.patient_id = la.patient_id
       JOIN patients p ON p.id = la.patient_id
       WHERE ABS(la.jsonb_med_count::int - ac.db_med_count::int) > 2
       ORDER BY diff DESC`,
    );

    res.json({
      generatedAt: new Date().toISOString(),
      summary: {
        patientsWithNoDiagnoses: noDx.length,
        appointmentsWithEmptyDxJsonb: emptyDxAppts.length,
        appointmentsWithEmptyMedJsonb: emptyMedAppts.length,
        patientsWithDuplicateMeds: [...new Set(dupMeds.map((r) => r.patient_id))].length,
        patientsWithTooManyMeds: manyMeds.length,
        patientsWithMedMismatch: mismatch.length,
      },
      issues: {
        noDiagnoses: noDx,
        emptyDxAppointments: emptyDxAppts,
        emptyMedAppointments: emptyMedAppts,
        duplicateMeds: dupMeds,
        tooManyMeds: manyMeds,
        medCountMismatch: mismatch,
      },
    });
  } catch (e) {
    handleError(res, e, "Patient audit");
  }
});

// ── Bulk fix: re-parse all appointments with notes but empty diagnoses/meds JSONB ──
// POST /api/sync/audit/fix-empty-jsonb
// Finds every appointment with clinical notes but empty healthray_diagnoses or
// healthray_medications JSONB and re-runs AI parsing + sync for each one.
// Runs in background — poll /api/sync/audit/fix-empty-jsonb/status for progress.
const fixEmptyJsonbStatus = {
  running: false,
  total: 0,
  done: 0,
  errors: 0,
  fixed: [],
  startedAt: null,
};

router.get("/sync/audit/fix-empty-jsonb/status", (_req, res) => {
  const elapsed = fixEmptyJsonbStatus.startedAt
    ? Math.round((Date.now() - fixEmptyJsonbStatus.startedAt) / 1000)
    : 0;
  res.json({ ...fixEmptyJsonbStatus, elapsed: `${elapsed}s` });
});

router.post("/sync/audit/fix-empty-jsonb", async (req, res) => {
  if (fixEmptyJsonbStatus.running)
    return res.status(409).json({ error: "Already running", status: fixEmptyJsonbStatus });

  // Which mode: "diagnoses" | "medications" | "both" (default)
  const mode = req.body?.mode || "both";

  const dxCondition =
    mode === "medications"
      ? "false"
      : `(a.healthray_diagnoses IS NULL OR jsonb_array_length(a.healthray_diagnoses) = 0)`;
  const medCondition =
    mode === "diagnoses"
      ? "false"
      : `(a.healthray_medications IS NULL OR jsonb_array_length(a.healthray_medications) = 0)`;

  try {
    const { rows: appts } = await pool.query(
      `SELECT a.id, a.patient_id, a.healthray_id, a.appointment_date, a.healthray_clinical_notes,
              jsonb_array_length(COALESCE(a.healthray_diagnoses,'[]'::jsonb)) AS dx_count,
              jsonb_array_length(COALESCE(a.healthray_medications,'[]'::jsonb)) AS med_count
       FROM appointments a
       WHERE a.healthray_clinical_notes IS NOT NULL
         AND LENGTH(a.healthray_clinical_notes) > 50
         AND (${dxCondition} OR ${medCondition})
       ORDER BY a.appointment_date DESC`,
    );

    Object.assign(fixEmptyJsonbStatus, {
      running: true,
      total: appts.length,
      done: 0,
      errors: 0,
      fixed: [],
      startedAt: Date.now(),
    });

    res.json({
      success: true,
      message: `Started background fix for ${appts.length} appointments`,
      statusUrl: "/api/sync/audit/fix-empty-jsonb/status",
    });

    // Run in background
    (async () => {
      for (const appt of appts) {
        try {
          const parsed = await parseClinicalWithAI(appt.healthray_clinical_notes);
          if (!parsed) {
            fixEmptyJsonbStatus.errors++;
            fixEmptyJsonbStatus.done++;
            continue;
          }

          const diagnoses = parsed.diagnoses || [];
          const medications = parsed.medications || [];
          const previousMeds = parsed.previous_medications || [];

          // Update JSONB
          await pool.query(
            `UPDATE appointments SET
               healthray_diagnoses  = COALESCE($2::jsonb, healthray_diagnoses),
               healthray_medications = COALESCE($3::jsonb, healthray_medications),
               updated_at = NOW()
             WHERE id = $1`,
            [
              appt.id,
              diagnoses.length ? JSON.stringify(diagnoses) : null,
              medications.length ? JSON.stringify(medications) : null,
            ],
          );

          // Sync to tables
          if (appt.patient_id) {
            if ((mode === "both" || mode === "diagnoses") && diagnoses.length)
              await syncDiagnoses(appt.patient_id, appt.healthray_id, diagnoses);
            if ((mode === "both" || mode === "medications") && medications.length) {
              await syncMedications(
                appt.patient_id,
                appt.healthray_id,
                appt.appointment_date,
                medications,
              );
              if (previousMeds.length)
                await syncStoppedMedications(
                  appt.patient_id,
                  appt.healthray_id,
                  previousMeds,
                  medications,
                );
            }
          }

          fixEmptyJsonbStatus.fixed.push({
            apptId: appt.id,
            patientId: appt.patient_id,
            date: appt.appointment_date,
            dxFound: diagnoses.length,
            medsFound: medications.length,
          });
        } catch (e) {
          fixEmptyJsonbStatus.errors++;
        }
        fixEmptyJsonbStatus.done++;
        // Small delay to avoid overloading AI API
        await new Promise((r) => setTimeout(r, 300));
      }
      fixEmptyJsonbStatus.running = false;
    })();
  } catch (e) {
    fixEmptyJsonbStatus.running = false;
    handleError(res, e, "Fix empty JSONB");
  }
});

export default router;
