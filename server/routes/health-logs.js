import express from "express";
import { createRequire } from "module";
import pool from "../config/db.js";

const require = createRequire(import.meta.url);

// Outbound Genie sync removed 2026-05-01 — dual-DB routing replaces it.
// Stub the previously-imported sync helpers so the existing call sites (kept
// to minimise blast radius) become harmless no-ops.
const noop = () => Promise.resolve({ pulled: 0 });
const syncPatientLogsFromGenie = noop;
const syncPatientLogsFromGenieThrottled = noop;
const syncDiagnosesToGenie = noop;
const syncMedicationsToGenie = noop;
const syncLabsToGenie = noop;
const syncDocumentsToGenie = noop;

const router = express.Router();

/**
 * POST /patients/:id/sync-health-logs
 * Trigger on-demand sync — pulls Genie→scribe logs + pushes scribe diagnoses
 * back to Genie so the "Sync Now" button is a true bidirectional kick.
 */
router.post("/patients/:id/sync-health-logs", async (req, res) => {
  try {
    const patientId = req.params.id;

    const [pullResult, pushResult, medsPush, labsPush, docsPush] = await Promise.all([
      syncPatientLogsFromGenie(patientId, pool),
      syncDiagnosesToGenie(patientId, pool),
      syncMedicationsToGenie(patientId, pool),
      syncLabsToGenie(patientId, pool),
      syncDocumentsToGenie(patientId, pool),
    ]);

    return res.json({
      success: true,
      ...pullResult,
      diagnosesPush: pushResult,
      medicationsPush: medsPush,
      labsPush,
      documentsPush: docsPush,
    });
  } catch (error) {
    console.error("Sync Health Logs Error:", error);

    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /patients/:id/health-logs
 * Query Local PostgreSQL logs
 * Optional:
 *  ?type=vitals|activities|symptoms|meds|meals
 *  ?since=YYYY-MM-DD
 */
router.get("/patients/:id/health-logs", async (req, res) => {
  try {
    const patientId = req.params.id;
    const { type, since } = req.query;

    // Pull latest Genie → scribe before reading the local mirror, so patient
    // app logs show up without the doctor having to open the visit page or
    // click "Sync Now". Throttled (30s) so a rapid UI refresh burst collapses.
    await syncPatientLogsFromGenieThrottled(patientId, pool).catch((e) =>
      console.warn("[health-logs] Pre-read sync skipped:", e.message),
    );

    const filters = [];
    const values = [patientId];

    if (since) {
      values.push(since);
    }

    const queries = {
      vitals: `
        SELECT * FROM patient_vitals_log
        WHERE patient_id = $1
        ${since ? "AND recorded_date >= $2" : ""}
        ORDER BY recorded_date DESC, created_at DESC NULLS LAST, id DESC
        LIMIT 500
      `,

      activities: `
        SELECT * FROM patient_activity_log
        WHERE patient_id = $1
        ${since ? "AND log_date >= $2" : ""}
        ORDER BY log_date DESC
        LIMIT 500
      `,

      symptoms: `
        SELECT * FROM patient_symptom_log
        WHERE patient_id = $1
        ${since ? "AND log_date >= $2" : ""}
        ORDER BY log_date DESC
        LIMIT 500
      `,

      meds: `
        SELECT * FROM patient_med_log
        WHERE patient_id = $1
        ${since ? "AND log_date >= $2" : ""}
        ORDER BY log_date DESC
        LIMIT 500
      `,

      meals: `
        SELECT * FROM patient_meal_log
        WHERE patient_id = $1
        ${since ? "AND log_date >= $2" : ""}
        ORDER BY log_date DESC
        LIMIT 500
      `,
    };

    const result = {
      vitals: [],
      activities: [],
      symptoms: [],
      medLogs: [],
      meals: [],
    };

    // Fetch based on type
    if (!type || type === "vitals") {
      const { rows } = await pool.query(queries.vitals, values);
      result.vitals = rows;
    }

    if (!type || type === "activities") {
      const { rows } = await pool.query(queries.activities, values);
      result.activities = rows;
    }

    if (!type || type === "symptoms") {
      const { rows } = await pool.query(queries.symptoms, values);
      result.symptoms = rows;
    }

    if (!type || type === "meds") {
      const { rows } = await pool.query(queries.meds, values);
      result.medLogs = rows;
    }

    if (!type || type === "meals") {
      const { rows } = await pool.query(queries.meals, values);
      result.meals = rows;
    }

    res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    console.error("Health Logs Fetch Error:", error);

    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

export default router;
