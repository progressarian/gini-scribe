import { Router } from "express";
import { handleError } from "../utils/errorHandler.js";
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

export default router;
