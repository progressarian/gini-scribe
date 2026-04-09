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
} from "../services/healthray/db.js";
import { extractPrescription } from "../services/healthray/prescriptionExtractor.js";

const router = Router();

// Manual trigger: full sync
router.post("/sync/healthray/full", async (req, res) => {
  try {
    const result = await syncWalkingAppointments();
    res.json({ success: true, ...result });
  } catch (e) {
    handleError(res, e, "HealthRay full sync");
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

// ── Debug: delete specific diagnosis rows by ID ──────────────────────────────
// POST /api/sync/debug/delete-diagnoses  body: { ids: [1,2,3] }
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
      await syncStoppedMedications(appt.patient_id, appt.healthray_id, previousMeds);
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
            await syncStoppedMedications(patient_id, appt.healthray_id, previousMeds);
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
            await syncStoppedMedications(appt.patient_id, appt.healthray_id, previousMeds);
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

export default router;
