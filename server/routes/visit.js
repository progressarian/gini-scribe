import { Router } from "express";
import { createRequire } from "module";
import pool from "../config/db.js";
import { handleError } from "../utils/errorHandler.js";
import { n, num, t } from "../utils/helpers.js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY, STORAGE_BUCKET } from "../config/storage.js";
import { sanitizeForStorageKey } from "./documents.js";
import { getCanonical } from "../utils/labCanonical.js";
import { computeCarePhase, deriveBiomarkerPriorityStatus } from "../utils/carePhase.js";
import { LAB_MAP } from "./opd.js";
import { parseClinicalWithAI } from "../services/healthray/parser.js";
import { buildPrescriptionPdf } from "../services/prescriptionPdf.js";
import {
  generatePrescriptionPdf,
  buildPrescriptionFileName,
} from "../services/prescriptionHtmlPdf.js";
import { savePrescriptionForVisit } from "../services/prescriptionAutoSave.js";
import { generateVisitSummary } from "../services/visitSummaryAI.js";
import { generatePatientSummary } from "../services/patientSummaryAI.js";
import {
  syncBiomarkersFromLatestLabs,
  syncVitalsFromExtraction,
} from "../services/healthray/db.js";
import { sortDiagnoses } from "../utils/diagnosisSort.js";
import { invalidatePatientSummaries } from "../services/summaryCache.js";
import {
  sortMedications,
  groupMedications,
  detectMedGroup,
  detectDrugClass,
} from "../utils/medicationSort.js";
import {
  stripFormPrefix,
  canonicalMedKey,
  routeForForm,
} from "../services/medication/normalize.js";
import { markMedicationVisitStatus } from "../services/medication/visitStatus.js";
import { backfillCommonSideEffectsForMed } from "../services/medication/commonSideEffectsAI.js";

const require = createRequire(import.meta.url);
// Outbound Genie sync removed 2026-05-01 — dual-DB routing replaces it.
// Stubs preserve the call sites below as harmless no-ops; remove the calls
// next time we touch each handler.
const noop = () => Promise.resolve();
const noopOk = () => Promise.resolve({ ok: true });
const syncPatientLogsFromGenie = noop;
const syncPatientLogsFromGenieThrottled = noop;
const syncDiagnosesToGenie = noop;
const syncMedicationsToGenie = noop;
const syncLabsToGenie = noop;
const syncDocumentsToGenie = noop;
const syncAppointmentToGenie = noop;
const syncCareTeamToGenie = noop;
const syncVitalsRowToGenie = noop;
const updateGenieVitalsByGenieId = noopOk;
const updateGenieLabByGenieId = noopOk;

const router = Router();

// Invalidate cached pre/post-visit summaries on any successful mutation under
// /visit/:patientId/*. Read-only and pure-helper endpoints are skipped — these
// don't change the data the summary derives from.
const SUMMARY_INVALIDATE_SKIP = [
  "/biomarkers/refresh",
  "/parse-text",
  "/doctor-summary/generate",
  "/patient-summary/generate",
  "/patient-summary", // saving the rendered summary doesn't change clinical data
  "/scribe-prescription",
  "/medications/reconcile", // self-invalidates only when rowCount > 0
];
router.use("/visit/:patientId", (req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD") return next();
  if (SUMMARY_INVALIDATE_SKIP.some((s) => req.path === s || req.path.endsWith(s))) {
    return next();
  }
  res.on("finish", () => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      invalidatePatientSummaries(req.params.patientId).catch(() => {});
    }
  });
  next();
});

// Ensure visit_symptoms table exists
pool
  .query(
    `CREATE TABLE IF NOT EXISTS visit_symptoms (
  id SERIAL PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  symptom_id TEXT NOT NULL,
  label TEXT NOT NULL,
  since_date DATE,
  severity TEXT DEFAULT 'Mild',
  related_to TEXT,
  status TEXT DEFAULT 'Active',
  appointment_id INTEGER,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(patient_id, symptom_id)
)`,
  )
  .catch(() => {});

// Ensure referrals table exists (with appointment_id)
pool
  .query(
    `CREATE TABLE IF NOT EXISTS referrals (
  id SERIAL PRIMARY KEY, patient_id INTEGER NOT NULL,
  doctor_name TEXT, speciality TEXT, reason TEXT,
  appointment_id INTEGER,
  status TEXT DEFAULT 'pending', created_at TIMESTAMPTZ DEFAULT NOW()
)`,
  )
  .catch(() => {});
// Add appointment_id column if table already exists without it
pool.query(`ALTER TABLE referrals ADD COLUMN IF NOT EXISTS appointment_id INTEGER`).catch(() => {});

// Ensure medications.history column exists (timeline of edits)
pool
  .query(`ALTER TABLE medications ADD COLUMN IF NOT EXISTS history JSONB DEFAULT '[]'::jsonb`)
  .catch(() => {});

// Genie master medications mirror — populated by syncPatientLogsFromGenie so the
// scribe visit page can show medicines the patient has added in the Genie app
// even before any dose has been logged (see genie-sync.cjs).
pool
  .query(
    `CREATE TABLE IF NOT EXISTS patient_medications_genie (
  id SERIAL PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  genie_id TEXT UNIQUE,
  name TEXT,
  dose TEXT,
  frequency TEXT,
  timing TEXT,
  instructions TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  for_conditions TEXT[],
  source TEXT DEFAULT 'genie',
  synced_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ
)`,
  )
  .catch(() => {});

// Genie conditions mirror — conditions the patient or scribe has added on the
// Genie side so doctors can see them without waiting for the next consultation.
pool
  .query(
    `CREATE TABLE IF NOT EXISTS patient_conditions_genie (
  id SERIAL PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  genie_id TEXT UNIQUE,
  name TEXT,
  status TEXT,
  diagnosed_date DATE,
  notes TEXT,
  synced_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ
)`,
  )
  .catch(() => {});

// GET /api/visit/:patientId — comprehensive visit-page data
router.get("/visit/:patientId", async (req, res) => {
  const pid = Number(req.params.patientId);
  if (!pid) return res.status(400).json({ error: "Invalid patient ID" });
  // Optional ?appointment_id=<id> tells us exactly which OPD appointment
  // row this visit page is for, so the status pill matches the OPD list
  // 1:1 even when a patient has multiple appointments on the same day.
  const apptIdParam = Number(req.query.appointment_id) || Number(req.query.appt) || null;

  // Pull the patient's fresh Track logs from Genie before we SELECT. The
  // throttled variant coalesces concurrent requests and skips entirely if
  // a sync ran for this patient in the last 30s — so rapid refetches
  // (React Query focus, lab-count poll, client retries) don't fan out into
  // multiple Genie round-trips.
  try {
    await syncPatientLogsFromGenieThrottled(pid, pool);
  } catch (e) {
    console.warn("[Visit] Genie log sync skipped:", e.message);
  }

  try {
    const [
      patientR,
      vitalsR,
      diagnosesR,
      activeMedsR,
      stoppedMedsR,
      labsR,
      consultationsR,
      docsR,
      goalsR,
      vitalsLogR,
      activityLogR,
      symptomLogR,
      medLogR,
      mealLogR,
      referralsR,
      symptomsR,
      latestApptR,
      labOrdersR,
      healthrayDxApptR,
      healthraySyncR,
      labSyncR,
      _patientMedsGenieRetired,
      patientCondsGenieR,
      latestAnyApptR,
      latestFollowupApptR,
      labStatusR,
    ] = await Promise.all([
      // 1. Patient
      pool.query("SELECT * FROM patients WHERE id=$1", [pid]),

      // 2. Vitals (for history/trends) — cap at the most recent 500 to bound memory;
      //    frontend charts down-sample anyway.
      pool.query("SELECT * FROM vitals WHERE patient_id=$1 ORDER BY recorded_at DESC LIMIT 500", [
        pid,
      ]),

      // 3. Diagnoses (deduplicated — one per diagnosis_id, active rows preferred, then latest)
      pool.query(
        `SELECT DISTINCT ON (diagnosis_id) * FROM diagnoses
         WHERE patient_id=$1
         ORDER BY diagnosis_id, is_active DESC, updated_at DESC`,
        [pid],
      ),

      // 4. Active medications — all active meds; frontend picks the latest prescription date
      pool.query(
        `SELECT m.*, c.con_name AS prescriber,
                COALESCE(c.visit_date, m.started_date) AS prescribed_date,
                COALESCE(m.last_prescribed_date, c.visit_date, m.started_date) AS last_prescribed_date
         FROM medications m LEFT JOIN consultations c ON c.id = m.consultation_id
         WHERE m.patient_id=$1 AND m.is_active = true
         ORDER BY COALESCE(c.visit_date, m.started_date) DESC, m.created_at DESC`,
        [pid],
      ),

      // 5. Stopped medications (deduplicated — one per drug name, latest wins)
      //    Exclude stopped rows that have an active counterpart with the same normalised name
      //    (handles old pharmacy_match=null duplicates from before normalisation was added)
      pool.query(
        `SELECT DISTINCT ON (UPPER(COALESCE(m.pharmacy_match, m.name)))
           m.*, c.con_name AS prescriber, COALESCE(c.visit_date, m.started_date) AS prescribed_date
         FROM medications m LEFT JOIN consultations c ON c.id = m.consultation_id
         WHERE m.patient_id=$1 AND m.is_active = false
           AND NOT EXISTS (
             SELECT 1 FROM medications am
             WHERE am.patient_id = m.patient_id
               AND am.is_active = true
               AND UPPER(COALESCE(am.pharmacy_match, am.name)) = UPPER(COALESCE(m.pharmacy_match, m.name))
           )
         ORDER BY UPPER(COALESCE(m.pharmacy_match, m.name)), m.stopped_date DESC NULLS LAST`,
        [pid],
      ),

      // 6. All lab results — every reading is returned, even when the same
      // test appears multiple times on the same date across different uploads.
      // Display layer is responsible for any grouping/collapsing it wants.
      // When a row is linked to an appointment, prefer the appointment_date for display
      // so labs line up with the clinical visit date instead of the lab-case (received) date.
      pool.query(
        `SELECT
           lr.id, lr.patient_id, lr.appointment_id,
           COALESCE(lr.test_date, a.appointment_date::date) AS test_date,
           lr.test_date AS lab_test_date,
           lr.test_name, lr.canonical_name, lr.result, lr.result_text, lr.unit,
           lr.ref_range, lr.flag, lr.is_critical, lr.source, lr.panel_name, lr.created_at
         FROM lab_results lr
         LEFT JOIN appointments a ON a.id = lr.appointment_id
         WHERE lr.patient_id = $1
           AND lr.test_date >= NOW() - INTERVAL '5 years'
         ORDER BY test_date DESC, lr.created_at DESC`,
        [pid],
      ),

      // 7. Visit history — merge consultations (Gini native) + appointments (HealthRay)
      // Consultations take priority when both exist for the same date.
      pool.query(
        `WITH cons AS (
           SELECT id, visit_date, visit_type, mo_name, con_name, status, created_at,
                  con_data, exam_data,
                  NULL::jsonb  AS healthray_diagnoses,
                  NULL::jsonb  AS healthray_medications,
                  NULL::text   AS healthray_advice,
                  'consultation' AS source_type
           FROM consultations
           WHERE patient_id = $1
         ),
         appts AS (
           SELECT id, appointment_date AS visit_date, visit_type,
                  NULL AS mo_name, doctor_name AS con_name, status, created_at,
                  NULL::jsonb  AS con_data,
                  NULL::jsonb  AS exam_data,
                  healthray_diagnoses,
                  healthray_medications,
                  healthray_advice,
                  'appointment' AS source_type
           FROM appointments
           WHERE patient_id = $1
             AND healthray_id IS NOT NULL
             AND appointment_date IS NOT NULL
         ),
         -- Prefer consultation when a consultation exists for the same date
         deduped AS (
           SELECT * FROM cons
           UNION ALL
           SELECT a.* FROM appts a
           WHERE NOT EXISTS (
             SELECT 1 FROM cons c
             WHERE c.visit_date::date = a.visit_date::date
           )
         )
         SELECT * FROM deduped
         ORDER BY visit_date DESC, created_at DESC
         LIMIT 200`,
        [pid],
      ),

      // 8. Documents
      pool.query(
        `SELECT id, doc_type, title, file_name, doc_date, source, notes, extracted_data, storage_path, file_url, reviewed, created_at
         FROM documents WHERE patient_id=$1 ORDER BY doc_date DESC NULLS LAST, created_at DESC
         LIMIT 200`,
        [pid],
      ),

      // 9. Goals
      pool.query("SELECT * FROM goals WHERE patient_id=$1 ORDER BY status, created_at DESC", [pid]),

      // 10. Genie vitals log — newest 500 rows, no interval filter so older
      //     history still surfaces when the doctor asks for it.
      pool.query(
        `SELECT * FROM patient_vitals_log
         WHERE patient_id=$1
         ORDER BY recorded_date DESC, created_at DESC NULLS LAST, id DESC
         LIMIT 500`,
        [pid],
      ),

      // 11. Genie activity log
      pool.query(
        `SELECT * FROM patient_activity_log
         WHERE patient_id=$1
         ORDER BY log_date DESC
         LIMIT 500`,
        [pid],
      ),

      // 12. Genie symptom log
      pool.query(
        `SELECT * FROM patient_symptom_log
         WHERE patient_id=$1
         ORDER BY log_date DESC
         LIMIT 500`,
        [pid],
      ),

      // 13. Genie med log — removed 30-day filter so Test Med and other older
      //     intake events stay visible after sync.
      pool.query(
        `SELECT * FROM patient_med_log
         WHERE patient_id=$1
         ORDER BY log_date DESC
         LIMIT 500`,
        [pid],
      ),

      // 14. Genie meal log
      pool.query(
        `SELECT * FROM patient_meal_log
         WHERE patient_id=$1
         ORDER BY log_date DESC
         LIMIT 500`,
        [pid],
      ),

      // 15. Referrals
      pool.query(`SELECT * FROM referrals WHERE patient_id=$1 ORDER BY created_at DESC`, [pid]),

      // 16. Visit symptoms
      pool.query(
        `SELECT * FROM visit_symptoms WHERE patient_id=$1 AND is_active=true ORDER BY created_at ASC`,
        [pid],
      ),

      // 17. Latest appointment plan data (from HealthRay sync)
      pool.query(
        `SELECT healthray_investigations, healthray_follow_up, compliance, biomarkers
         FROM appointments WHERE patient_id=$1 AND healthray_clinical_notes IS NOT NULL
         ORDER BY appointment_date DESC LIMIT 1`,
        [pid],
      ),

      // 18. Lab orders (Reports/Tests classification per case date)
      pool.query(
        `SELECT case_no, patient_case_no, case_date, investigation_summary
         FROM lab_cases
         WHERE patient_id = $1
           AND results_synced = TRUE
           AND investigation_summary IS NOT NULL
         ORDER BY case_date DESC
         LIMIT 20`,
        [pid],
      ),

      // 19. Latest appointment healthray_diagnoses JSONB (includes absent findings like CAD/CVA/PVD)
      pool.query(
        `SELECT healthray_diagnoses, appointment_date FROM appointments
         WHERE patient_id=$1
           AND healthray_diagnoses IS NOT NULL
           AND jsonb_array_length(healthray_diagnoses) > 0
         ORDER BY appointment_date DESC LIMIT 1`,
        [pid],
      ),

      // 20. HealthRay sync status (latest synced appointment)
      pool.query(
        `SELECT id, appointment_date, healthray_id, updated_at
         FROM appointments WHERE patient_id=$1 AND healthray_clinical_notes IS NOT NULL
         ORDER BY appointment_date DESC LIMIT 1`,
        [pid],
      ),

      // 21. Lab sync status (synced lab cases)
      pool.query(
        `SELECT case_no, patient_case_no, case_date, synced_at
         FROM lab_cases WHERE patient_id=$1 AND results_synced = TRUE
         ORDER BY case_date DESC LIMIT 5`,
        [pid],
      ),

      // 22. Genie master medications mirror — retired 2026-05-06.
      //     Genie sync is disabled (dual-DB routing replaces it) and the mirror
      //     was producing duplicate "genie:<id>" rows that shadowed real
      //     medications. Return an empty result set in the same shape so the
      //     destructure below stays valid.
      Promise.resolve({ rows: [] }),

      // 23. Genie conditions mirror — what the patient is seeing on their app.
      pool.query(
        `SELECT * FROM patient_conditions_genie
         WHERE patient_id=$1
         ORDER BY synced_at DESC
         LIMIT 100`,
        [pid],
      ),

      // 24. Latest appointment of any kind — used by the client to stamp
      //     summary requests so cache rows are always keyed.
      //     Also returns status / prep_steps / checked_in_at so the visit
      //     topbar can render the same status pill OPD shows.
      //     Selection priority (so this matches the OPD list row exactly):
      //       1. The exact appointment id when ?appt=<id> is passed.
      //       2. Today's appointment (OPD list is keyed on today).
      //       3. Most recent appointment overall (fallback).
      pool.query(
        `SELECT id, status, prep_steps, checked_in_at, appointment_date
           FROM appointments
          WHERE patient_id=$1
          ORDER BY
            CASE WHEN id = $2 THEN 0 ELSE 1 END,
            CASE WHEN appointment_date = CURRENT_DATE THEN 0 ELSE 1 END,
            appointment_date DESC NULLS LAST,
            id DESC
          LIMIT 1`,
        [pid, apptIdParam],
      ),

      // 25. Latest appointment that carries a biomarkers.followup value.
      //     Mirrors the OPD page, which reads appt.biomarkers.followup per row,
      //     so the visit page surfaces the same scheduled date even when the
      //     latest clinical-notes appointment lags behind.
      pool.query(
        `SELECT biomarkers, healthray_follow_up FROM appointments
          WHERE patient_id=$1 AND biomarkers ? 'followup'
          ORDER BY appointment_date DESC NULLS LAST, id DESC
          LIMIT 1`,
        [pid],
      ),

      // 26. Lab status — mirrors the OPD lab tags (Gini Lab Processing /
      //     Received / Lab Uploaded). Pulls from lab_cases (Gini lab pipeline)
      //     and lab_results / documents (manually-uploaded reports).
      pool.query(
        `SELECT
           (SELECT COUNT(*)::int FROM lab_cases lc
              WHERE (lc.patient_id = $1
                  OR (lc.patient_id IS NULL
                      AND lc.raw_list_json->'patient'->>'healthray_uid' = (
                        SELECT file_no FROM patients WHERE id = $1
                      )))
                AND lc.results_synced = FALSE
                AND COALESCE(lc.retry_abandoned, FALSE) = FALSE) AS pending_labs,
           (SELECT COUNT(*)::int FROM lab_cases lc
              WHERE (lc.patient_id = $1
                  OR (lc.patient_id IS NULL
                      AND lc.raw_list_json->'patient'->>'healthray_uid' = (
                        SELECT file_no FROM patients WHERE id = $1
                      )))
                AND lc.results_synced = TRUE
                AND lc.case_date >= CURRENT_DATE - INTERVAL '7 days'
                AND lc.raw_detail_json->>'reported_on' IS NOT NULL) AS recent_labs,
           (SELECT MAX(lc.case_date) FROM lab_cases lc
              WHERE (lc.patient_id = $1
                  OR (lc.patient_id IS NULL
                      AND lc.raw_list_json->'patient'->>'healthray_uid' = (
                        SELECT file_no FROM patients WHERE id = $1
                      )))
                AND lc.results_synced = TRUE
                AND lc.case_date >= CURRENT_DATE - INTERVAL '7 days'
                AND lc.raw_detail_json->>'reported_on' IS NOT NULL) AS recent_labs_date,
           (SELECT COUNT(*)::int FROM lab_cases lc
              WHERE (lc.patient_id = $1
                  OR (lc.patient_id IS NULL
                      AND lc.raw_list_json->'patient'->>'healthray_uid' = (
                        SELECT file_no FROM patients WHERE id = $1
                      )))
                AND lc.results_synced = TRUE
                AND lc.case_date >= CURRENT_DATE - INTERVAL '7 days'
                AND lc.raw_detail_json->>'reported_on' IS NULL
                AND NOT EXISTS (
                  SELECT 1 FROM lab_cases lc2
                   WHERE (lc2.patient_id = $1
                          OR (lc2.patient_id IS NULL
                              AND lc2.raw_list_json->'patient'->>'healthray_uid' = (
                                SELECT file_no FROM patients WHERE id = $1
                              )))
                     AND lc2.results_synced = TRUE
                     AND lc2.raw_detail_json->>'reported_on' IS NOT NULL
                     AND lc2.case_date > lc.case_date
                )) AS partial_labs,
           (SELECT MAX(lc.case_date) FROM lab_cases lc
              WHERE (lc.patient_id = $1
                  OR (lc.patient_id IS NULL
                      AND lc.raw_list_json->'patient'->>'healthray_uid' = (
                        SELECT file_no FROM patients WHERE id = $1
                      )))
                AND lc.results_synced = TRUE
                AND lc.case_date >= CURRENT_DATE - INTERVAL '7 days'
                AND lc.raw_detail_json->>'reported_on' IS NULL
                AND NOT EXISTS (
                  SELECT 1 FROM lab_cases lc2
                   WHERE (lc2.patient_id = $1
                          OR (lc2.patient_id IS NULL
                              AND lc2.raw_list_json->'patient'->>'healthray_uid' = (
                                SELECT file_no FROM patients WHERE id = $1
                              )))
                     AND lc2.results_synced = TRUE
                     AND lc2.raw_detail_json->>'reported_on' IS NOT NULL
                     AND lc2.case_date > lc.case_date
                )) AS partial_labs_date,
           GREATEST(
             (SELECT COUNT(DISTINCT lr.canonical_name)::int FROM lab_results lr
                WHERE lr.patient_id = $1
                  AND lr.source = 'report_extract'
                  AND lr.test_date >= CURRENT_DATE - INTERVAL '7 days'),
             (SELECT COUNT(*)::int FROM documents d
                WHERE d.patient_id = $1
                  AND d.doc_type IN ('lab_report', 'blood_test')
                  AND d.source NOT IN ('healthray', 'lab_healthray')
                  AND COALESCE(d.doc_date, d.created_at::date) >= CURRENT_DATE - INTERVAL '7 days')
           ) AS uploaded_labs,
           (SELECT MAX(dt) FROM (
              SELECT MAX(lr.test_date) AS dt FROM lab_results lr
               WHERE lr.patient_id = $1
                 AND lr.source = 'report_extract'
                 AND lr.test_date >= CURRENT_DATE - INTERVAL '7 days'
              UNION ALL
              SELECT MAX(COALESCE(d.doc_date, d.created_at::date)) AS dt FROM documents d
               WHERE d.patient_id = $1
                 AND d.doc_type IN ('lab_report', 'blood_test')
                 AND d.source NOT IN ('healthray', 'lab_healthray')
                 AND COALESCE(d.doc_date, d.created_at::date) >= CURRENT_DATE - INTERVAL '7 days'
           ) x) AS uploaded_labs_date`,
        [pid],
      ),
    ]);

    const patient = patientR.rows[0];
    if (!patient) return res.status(404).json({ error: "Patient not found" });

    // Deduplicate consultations by visit_date + status
    const seen = new Set();
    const consultations = consultationsR.rows.filter((c) => {
      const key = `${c.visit_date}|${c.status}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Build lab history grouped by test name
    const labHistory = {};
    const labLatest = {};
    const _latestRaw = {}; // track raw lab_test_date per key for comparison
    for (const r of labsR.rows) {
      // Fall back to on-the-fly canonicalisation so legacy rows whose
      // canonical_name was NULL (e.g. "S. Ferritin" before the prefix-strip
      // fix) still collapse onto the same key as "Ferritin".
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
      // Use raw lab_test_date for "latest" comparison — the outer ORDER BY
      // uses COALESCE(appointment_date, test_date) which can push old results
      // ahead of genuinely newer ones when linked to a recent appointment.
      const rawDate = r.lab_test_date || r.test_date;
      const prevRaw = _latestRaw[key];
      if (
        !labLatest[key] ||
        rawDate > prevRaw ||
        (rawDate === prevRaw && r.created_at > labLatest[key]._ca)
      ) {
        labLatest[key] = {
          test_name: r.test_name,
          result: r.result,
          result_text: r.result_text,
          unit: r.unit,
          flag: r.flag,
          date: r.test_date,
          ref_range: r.ref_range,
          is_critical: r.is_critical,
          source: r.source,
          panel_name: r.panel_name,
          _ca: r.created_at,
        };
        _latestRaw[key] = rawDate;
      }
    }
    // Strip internal tracking field before sending to client
    for (const v of Object.values(labLatest)) delete v._ca;

    // Compute summary
    const totalVisits = consultations.length;
    const firstVisit = consultations.length ? consultations[consultations.length - 1] : null;
    const firstVisitDate = firstVisit?.visit_date || null;

    // Compute months with Gini
    let monthsWithGini = 0;
    if (firstVisitDate) {
      const diff = Date.now() - new Date(firstVisitDate).getTime();
      monthsWithGini = Math.floor(diff / (1000 * 60 * 60 * 24 * 30));
    }

    // Care phase derived from HbA1c trajectory (falls back to visit count when
    // no HbA1c data exists). Computed below — after labHistory is fully
    // enriched from appointment biomarkers — so the placeholders here let the
    // existing references resolve until the real values are filled in.
    let carePhase = "Phase 1 · Uncontrolled";
    let carePhaseBasis = "visits";
    let carePhaseDrivers = [];
    let carePhaseParameters = [];
    let carePhasePriority = null;

    // Load doctor note + compliance + assigned doctor from active OPD appointment if present
    let apptDoctorNote = null;
    let opdCompliance = null;
    let apptDoctorName = null;
    if (req.query.appointment_id) {
      const opdR = await pool.query(
        `SELECT opd_vitals->>'doctor_note' AS doctor_note, compliance, doctor_name
         FROM appointments WHERE id=$1`,
        [Number(req.query.appointment_id)],
      );
      apptDoctorNote = opdR.rows[0]?.doctor_note || null;
      opdCompliance = opdR.rows[0]?.compliance || null;
      apptDoctorName = opdR.rows[0]?.doctor_name || null;
    }

    const apptPlan = latestApptR.rows[0] || null;
    // Prefer compliance from today's OPD appointment; fall back to last HealthRay-synced one
    const apptCompliance = opdCompliance || apptPlan?.compliance || {};
    const apptBiomarkers = apptPlan?.biomarkers || {};

    // Seed labLatest + labHistory from appointments.biomarkers across all
    // appointments. Mirrors the OPD enrichment so values that live only in
    // HealthRay clinical-note biomarkers (e.g. HbA1c on the latest appt, or
    // a prior FBS reading like 170 → 319.6) surface on /visit too. lab_results
    // stays authoritative when a row already covers that canonical+date.
    {
      const { rows: bioRows } = await pool.query(
        `SELECT appointment_date, biomarkers FROM appointments
          WHERE patient_id = $1 AND biomarkers IS NOT NULL
            AND appointment_date IS NOT NULL
          ORDER BY appointment_date DESC, created_at DESC`,
        [pid],
      );
      const dayOf = (d) => (d ? String(d).slice(0, 10) : null);
      // HealthRay copies the last-known biomarker value forward into every
      // subsequent appointment. To avoid phantom trend points we sort
      // oldest→newest and only honour the FIRST appearance of each
      // (canonical, value) carry-forward. When `_lab_dates[bioKey]` is set,
      // we trust it as the real lab draw date.
      const sortedBioRows = [...bioRows].sort((a, b) =>
        String(a.appointment_date || "").localeCompare(String(b.appointment_date || "")),
      );
      const firstSeenCarry = new Map();
      for (const row of sortedBioRows) {
        const bio = row.biomarkers || {};
        const bioLabDates = bio._lab_dates || {};
        for (const [bioKey, meta] of Object.entries(LAB_MAP)) {
          const raw = bio[bioKey];
          if (raw == null) continue;
          const v = parseFloat(raw);
          if (!isFinite(v)) continue;
          const canonical = meta.canonical;
          const labDate = bioLabDates[bioKey];
          let date;
          if (labDate) {
            date = labDate;
          } else {
            const dedupKey = `${canonical}|${v}`;
            if (firstSeenCarry.has(dedupKey)) continue;
            firstSeenCarry.set(dedupKey, true);
            date = row.appointment_date;
          }
          const dayKey = dayOf(date);
          if (!labHistory[canonical]) labHistory[canonical] = [];
          const dup = labHistory[canonical].some((h) => dayOf(h.date) === dayKey);
          if (!dup) {
            labHistory[canonical].push({
              result: v,
              result_text: null,
              unit: meta.unit || null,
              flag: null,
              date,
              ref_range: null,
              panel_name: meta.panel || null,
            });
          }
          if (!labLatest[canonical]) {
            labLatest[canonical] = {
              test_name: meta.test_name,
              result: v,
              result_text: null,
              unit: meta.unit || null,
              flag: null,
              date,
              ref_range: null,
              is_critical: false,
              source: "biomarkers",
              panel_name: meta.panel || null,
            };
          }
        }
      }
      // Re-sort each affected labHistory bucket by date DESC.
      for (const arr of Object.values(labHistory)) {
        arr.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
      }
    }

    // Now that labHistory is fully enriched (lab_results + appointment
    // biomarkers), derive carePhase/trend from HbA1c trajectory.
    // mergedVitals is built later, but vitalsR.rows is already available and
    // carries every doctor-side reading (bp_sys/bp_dia/bmi). That's enough for
    // phase scoring — patient-app-logged vitals only refine, not redefine.
    ({ carePhase, carePhaseBasis, carePhaseDrivers, carePhaseParameters } = computeCarePhase({
      labHistory,
      vitals: vitalsR.rows,
      totalVisits,
      diagnoses: diagnosesR.rows,
    }));
    // Override `carePhase` with the single-marker priority read used by the
    // visit pill, the post-visit narrative and every other downstream
    // consumer so they can't disagree about Controlled vs. Uncontrolled.
    // Keep the multi-parameter `carePhaseParameters` list intact — the pill
    // tooltip still surfaces every tracked parameter for context.
    carePhasePriority = deriveBiomarkerPriorityStatus({
      labHistory,
      vitals: vitalsR.rows,
      diagnoses: diagnosesR.rows,
    });
    if (carePhasePriority) {
      carePhase = carePhasePriority.phase;
      carePhaseDrivers = [carePhasePriority.marker];
    }

    const prep = {
      medPct: apptCompliance.medPct ?? null,
      missed: apptCompliance.missed || null,
      symptoms: apptCompliance.symptoms || [],
    };
    const followupApptRow = latestFollowupApptR.rows[0] || null;
    const followupApptBio = followupApptRow?.biomarkers || {};
    // healthray_follow_up may be `{date:null, notes:..., timing:null}` even when
    // biomarkers.followup carries the real date — only honour it when it has a
    // date, otherwise fall through to the biomarkers fallback.
    const withDate = (fu) => (fu && fu.date ? fu : null);
    const followUpDate =
      withDate(apptPlan?.healthray_follow_up) ||
      (apptBiomarkers.followup
        ? {
            date: apptBiomarkers.followup,
            notes: apptPlan?.healthray_follow_up?.notes || null,
            timing: apptPlan?.healthray_follow_up?.timing || null,
          }
        : null) ||
      withDate(followupApptRow?.healthray_follow_up) ||
      (followupApptBio.followup
        ? {
            date: followupApptBio.followup,
            notes: followupApptRow?.healthray_follow_up?.notes || null,
            timing: followupApptRow?.healthray_follow_up?.timing || null,
          }
        : null);

    const healthrayDxAppt = healthrayDxApptR.rows[0] || null;

    // Apply clinical sorting to diagnoses and medications
    const sortedDiagnoses = sortDiagnoses(diagnosesR.rows);
    // Active meds come solely from the `medications` table now. The genie
    // mirror used to be merged here with `genie:<id>` prefixed ids — that
    // duplicated drugs against real medications rows and broke PATCH/DELETE.
    const sortedActiveMeds = sortMedications(activeMedsR.rows || []);

    // Merge app-logged vitals (patient_vitals_log) into the doctor-side
    // `vitals` array so the visit response surfaces both streams in one
    // chronological list. Column names are normalised to the doctor-side
    // shape (bp_sys/bp_dia/weight) and the original Genie row is tagged
    // with source='patient_app' so the UI can still tell them apart.
    const appVitals = (vitalsLogR.rows || []).map((r) => {
      const recordedAt =
        r.created_at || (r.recorded_date ? new Date(r.recorded_date).toISOString() : null);
      return {
        id: `app:${r.id}`,
        patient_id: r.patient_id,
        consultation_id: null,
        recorded_at: recordedAt,
        bp_sys: r.bp_systolic != null ? String(r.bp_systolic) : null,
        bp_dia: r.bp_diastolic != null ? String(r.bp_diastolic) : null,
        pulse: r.pulse != null ? String(r.pulse) : null,
        temp: null,
        spo2: r.spo2 != null ? String(r.spo2) : null,
        weight: r.weight_kg != null ? String(r.weight_kg) : null,
        height: null,
        bmi: r.bmi != null ? String(r.bmi) : null,
        rbs: r.rbs != null ? String(r.rbs) : null,
        waist: r.waist != null ? String(r.waist) : null,
        body_fat: r.body_fat != null ? String(r.body_fat) : null,
        muscle_mass: r.muscle_mass != null ? String(r.muscle_mass) : null,
        notes: null,
        appointment_id: null,
        bp_standing_sys: null,
        bp_standing_dia: null,
        source: "patient_app",
        meal_type: r.meal_type || null,
        reading_time: r.reading_time || null,
        recorded_date: r.recorded_date || null,
      };
    });
    const mergedVitals = [...vitalsR.rows, ...appVitals].sort((a, b) => {
      const ta = a.recorded_at ? new Date(a.recorded_at).getTime() : 0;
      const tb = b.recorded_at ? new Date(b.recorded_at).getTime() : 0;
      return tb - ta;
    });

    res.json({
      patient,
      vitals: mergedVitals,
      diagnoses: sortedDiagnoses,
      healthrayDiagnoses: healthrayDxAppt?.healthray_diagnoses || null,
      activeMeds: sortedActiveMeds,
      stoppedMeds: stoppedMedsR.rows,
      labResults: labsR.rows,
      labHistory,
      labLatest,
      labStatus: labStatusR.rows[0] || {
        pending_labs: 0,
        recent_labs: 0,
        recent_labs_date: null,
        partial_labs: 0,
        partial_labs_date: null,
        uploaded_labs: 0,
        uploaded_labs_date: null,
      },
      labOrders: labOrdersR.rows.map((r) => ({
        caseNo: r.case_no,
        patientCaseNo: r.patient_case_no,
        date: r.case_date,
        reports: r.investigation_summary?.reports || [],
        tests: r.investigation_summary?.tests || [],
      })),
      consultations,
      documents: docsR.rows,
      referrals: referralsR.rows,
      symptoms: symptomsR.rows,
      goals: goalsR.rows,
      prep,
      appt_doctor_note: apptDoctorNote,
      appt_doctor_name: apptDoctorName,
      appt_plan:
        apptPlan || followUpDate
          ? {
              investigations_to_order: (apptPlan?.healthray_investigations || []).map((t) =>
                typeof t === "string" ? { name: t, urgency: "routine" } : t,
              ),
              follow_up: followUpDate,
              diet_lifestyle: [
                apptCompliance.diet,
                apptCompliance.exercise,
                apptCompliance.stress,
              ].filter(Boolean),
            }
          : null,
      loggedData: {
        vitals: vitalsLogR.rows,
        activity: activityLogR.rows,
        symptoms: symptomLogR.rows,
        meds: medLogR.rows,
        meals: mealLogR.rows,
        patientMedications: [],
        patientConditions: patientCondsGenieR.rows,
      },
      summary: {
        totalVisits,
        firstVisitDate,
        monthsWithGini,
        carePhase,
        carePhaseBasis,
        carePhaseDrivers,
        carePhaseParameters,
        carePhasePriority: carePhasePriority
          ? {
              marker: carePhasePriority.marker,
              value: carePhasePriority.value,
              target: carePhasePriority.target,
              status: carePhasePriority.status,
              label: carePhasePriority.label,
              date: carePhasePriority.date,
            }
          : null,
      },
      latestAppointmentId: latestAnyApptR.rows[0]?.id || null,
      latestAppointment: latestAnyApptR.rows[0]
        ? {
            id: latestAnyApptR.rows[0].id,
            status: latestAnyApptR.rows[0].status || null,
            prep_steps: latestAnyApptR.rows[0].prep_steps || null,
            checked_in_at: latestAnyApptR.rows[0].checked_in_at || null,
            appointment_date: latestAnyApptR.rows[0].appointment_date || null,
          }
        : null,
      syncStatus: {
        healthray: healthraySyncR.rows[0] || null,
        labs: labSyncR.rows || [],
      },
    });
  } catch (err) {
    handleError(res, err, "Failed to load visit data");
  }
});

// ── GET /visit/:patientId/lab-count — Lightweight change-detection for polling ──
router.get("/visit/:patientId/lab-count", async (req, res) => {
  const pid = Number(req.params.patientId);
  if (!pid) return res.status(400).json({ error: "Invalid patient ID" });
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::INTEGER AS total, MAX(created_at) AS latest_at
       FROM lab_results WHERE patient_id = $1`,
      [pid],
    );
    res.json(rows[0]);
  } catch (e) {
    handleError(res, e, "Lab count");
  }
});

// ── POST /visit/:patientId/biomarkers/refresh — Recompute appointment biomarkers
// from the latest lab_results rows and update the OPD chip JSONB. Called by the
// paste-biomarkers flow after saving a batch of labs so OPD + Outcomes reflect the
// new values immediately without a full HealthRay sync.
router.post("/visit/:patientId/biomarkers/refresh", async (req, res) => {
  const pid = Number(req.params.patientId);
  if (!pid) return res.status(400).json({ error: "Invalid patient ID" });
  try {
    const { rows } = await pool.query(
      `SELECT id FROM appointments WHERE patient_id = $1 ORDER BY appointment_date DESC LIMIT 1`,
      [pid],
    );
    if (!rows[0]) return res.json({ ok: true, reason: "no_appointments" });
    await syncBiomarkersFromLatestLabs(pid, rows[0].id);
    res.json({ ok: true, appointment_id: rows[0].id });
  } catch (e) {
    handleError(res, e, "Biomarker refresh");
  }
});

// ── POST /visit/:patientId/lab — Add a lab value ──
router.post("/visit/:patientId/lab", async (req, res) => {
  const pid = Number(req.params.patientId);
  if (!pid) return res.status(400).json({ error: "Invalid patient ID" });
  try {
    const { test_name, result, unit, test_date, appointment_id } = req.body;
    if (!test_name) return res.status(400).json({ error: "test_name is required" });
    const canonical = getCanonical(test_name);
    const numResult = num(result);
    const finalDate = n(test_date) || new Date().toISOString().split("T")[0];

    // Same-day same-test = update existing row instead of inserting a new
    // one. Keeps a single row per (patient, canonical, date) so the lab
    // trend has one point per day per biomarker. Prefer rows that already
    // have a genie_id (patient-origin) so we update through the pull key.
    const existing = await pool.query(
      `SELECT id, genie_id, ref_range, flag FROM lab_results
       WHERE patient_id = $1 AND canonical_name = $2 AND test_date::date = $3::date
       ORDER BY (genie_id IS NOT NULL) DESC, created_at DESC NULLS LAST, id DESC
       LIMIT 1`,
      [pid, canonical, finalDate],
    );

    let r;
    if (existing.rows[0]) {
      r = await pool.query(
        `UPDATE lab_results
            SET test_name      = $1,
                result         = $2,
                unit           = $3,
                appointment_id = COALESCE($4, appointment_id)
          WHERE id = $5
          RETURNING *`,
        [t(test_name, 200), numResult, t(unit, 50), appointment_id || null, existing.rows[0].id],
      );
    } else {
      r = await pool.query(
        `INSERT INTO lab_results (patient_id, test_name, canonical_name, result, unit, test_date, source, appointment_id)
         VALUES ($1,$2,$3,$4,$5,$6::date,'manual',$7) RETURNING *`,
        [
          pid,
          t(test_name, 200),
          canonical,
          numResult,
          t(unit, 50),
          finalDate,
          appointment_id || null,
        ],
      );
    }
    const row = r.rows[0];
    if (row.genie_id) {
      // Patient-origin row: update Genie row directly so the app sees it.
      const flag = row.flag === "HIGH" ? "high" : row.flag === "LOW" ? "low" : "normal";
      updateGenieLabByGenieId(row.genie_id, {
        test_name: row.test_name,
        value: row.result,
        unit: row.unit,
        reference_range: row.ref_range,
        status: flag,
        test_date: row.test_date,
      }).catch((e) => console.warn("[Visit] Genie lab update skipped:", e.message));
    } else {
      syncLabsToGenie(pid, pool).catch((e) =>
        console.warn("[Visit] Labs push skipped:", e.message),
      );
    }
    res.json(row);
  } catch (e) {
    handleError(res, e, "Add lab value");
  }
});

// ── PATCH /visit/:patientId/lab/:id — Edit an existing lab value ──
// Used when the doctor corrects the latest lab reading (any source). After
// the local update we re-push labs so the Genie app sees the new value.
router.patch("/visit/:patientId/lab/:id", async (req, res) => {
  const pid = Number(req.params.patientId);
  const lid = Number(req.params.id);
  if (!pid || !lid) return res.status(400).json({ error: "Invalid IDs" });
  try {
    const { test_name, result, unit, test_date } = req.body;
    const sets = [];
    const vals = [];
    if (test_name !== undefined) {
      vals.push(t(test_name, 200));
      sets.push(`test_name = $${vals.length}`);
      vals.push(getCanonical(test_name));
      sets.push(`canonical_name = $${vals.length}`);
    }
    if (result !== undefined) {
      vals.push(num(result));
      sets.push(`result = $${vals.length}`);
    }
    if (unit !== undefined) {
      vals.push(t(unit, 50));
      sets.push(`unit = $${vals.length}`);
    }
    if (test_date !== undefined) {
      vals.push(n(test_date));
      sets.push(`test_date = $${vals.length}::date`);
    }
    if (!sets.length) return res.json({ ok: true });
    vals.push(lid, pid);
    const r = await pool.query(
      `UPDATE lab_results SET ${sets.join(", ")}
       WHERE id = $${vals.length - 1} AND patient_id = $${vals.length}
       RETURNING *`,
      vals,
    );
    if (!r.rows[0]) return res.status(404).json({ error: "lab_results row not found" });
    // If this lab originated from the patient app (genie_id is set), update
    // the Genie row directly by id so the patient app sees the edit instead
    // of getting a duplicate insert. The gini_sync_lab RPC is keyed by
    // source_id which is NULL on patient-app rows, so it would INSERT.
    const updated = r.rows[0];
    if (updated.genie_id) {
      const flag = updated.flag === "HIGH" ? "high" : updated.flag === "LOW" ? "low" : "normal";
      updateGenieLabByGenieId(updated.genie_id, {
        test_name: updated.test_name,
        value: updated.result,
        unit: updated.unit,
        reference_range: updated.ref_range,
        status: flag,
        test_date: updated.test_date,
      }).catch((e) => console.warn("[Visit] Genie lab update skipped:", e.message));
    } else {
      syncLabsToGenie(pid, pool).catch((e) =>
        console.warn("[Visit] Labs push skipped:", e.message),
      );
    }
    res.json(updated);
  } catch (e) {
    handleError(res, e, "Update lab value");
  }
});

// ── POST /visit/:patientId/diagnosis — Add / upsert diagnosis ──
router.post("/visit/:patientId/diagnosis", async (req, res) => {
  const pid = Number(req.params.patientId);
  if (!pid) return res.status(400).json({ error: "Invalid patient ID" });
  try {
    const {
      name,
      icd_code,
      status,
      category,
      complication_type,
      external_doctor,
      key_value,
      trend,
      notes,
    } = req.body;
    if (!name) return res.status(400).json({ error: "name is required" });
    const diagId = (icd_code || name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .slice(0, 100);
    const r = await pool.query(
      `INSERT INTO diagnoses (patient_id, diagnosis_id, label, status, category, complication_type, external_doctor, key_value, trend, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (patient_id, diagnosis_id) DO UPDATE SET
         label = EXCLUDED.label, status = COALESCE(EXCLUDED.status, diagnoses.status),
         category = COALESCE(EXCLUDED.category, diagnoses.category),
         complication_type = COALESCE(EXCLUDED.complication_type, diagnoses.complication_type),
         external_doctor = COALESCE(EXCLUDED.external_doctor, diagnoses.external_doctor),
         key_value = COALESCE(EXCLUDED.key_value, diagnoses.key_value),
         trend = COALESCE(EXCLUDED.trend, diagnoses.trend),
         notes = COALESCE(EXCLUDED.notes, diagnoses.notes), updated_at = NOW()
       RETURNING *`,
      [
        pid,
        diagId,
        t(name, 500),
        t(status, 100) || "Newly Diagnosed",
        t(category, 50),
        t(complication_type, 50),
        t(external_doctor, 200),
        t(key_value, 200),
        t(trend, 200),
        t(notes, 1000),
      ],
    );
    // Fire-and-forget push to Genie so the patient app's Conditions section
    // updates without waiting for the next consultation save.
    syncDiagnosesToGenie(pid, pool).catch((e) =>
      console.warn("[Visit] Diagnosis push skipped:", e.message),
    );
    res.json(r.rows[0]);
  } catch (e) {
    handleError(res, e, "Add diagnosis");
  }
});

// ── PATCH /visit/:patientId/diagnosis/:id — Update diagnosis status/notes ──
router.patch("/visit/:patientId/diagnosis/:id", async (req, res) => {
  const pid = Number(req.params.patientId);
  const did = Number(req.params.id);
  if (!pid || !did) return res.status(400).json({ error: "Invalid IDs" });
  try {
    const { status, notes } = req.body;
    const r = await pool.query(
      `UPDATE diagnoses SET status = COALESCE($1, status), notes = COALESCE($2, notes), updated_at = NOW()
       WHERE id = $3 AND patient_id = $4 RETURNING *`,
      [t(status, 100), t(notes, 1000), did, pid],
    );
    if (!r.rows[0]) return res.status(404).json({ error: "Diagnosis not found" });
    syncDiagnosesToGenie(pid, pool).catch((e) =>
      console.warn("[Visit] Diagnosis push skipped:", e.message),
    );
    res.json(r.rows[0]);
  } catch (e) {
    handleError(res, e, "Update diagnosis");
  }
});

// ── POST /visit/:patientId/medication — Add medication (upsert) ──
router.post("/visit/:patientId/medication", async (req, res) => {
  const pid = Number(req.params.patientId);
  if (!pid) return res.status(400).json({ error: "Invalid patient ID" });
  try {
    const {
      name,
      dose,
      frequency,
      timing,
      route,
      for_diagnosis,
      started_date,
      appointment_id,
      composition,
      med_group,
      drug_class,
      external_doctor,
      clinical_note,
      notes,
      parent_medication_id,
      support_condition,
      days_of_week,
    } = req.body;
    if (!name) return res.status(400).json({ error: "name is required" });

    // Normalise days_of_week to a clean int[] (0=Sun … 6=Sat) or null.
    // Anything else (strings, out-of-range, dupes) is filtered out.
    const cleanDays = Array.isArray(days_of_week)
      ? Array.from(
          new Set(
            days_of_week
              .map((d) => Number(d))
              .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6),
          ),
        ).sort((a, b) => a - b)
      : null;
    const finalDays = cleanDays && cleanDays.length ? cleanDays : null;

    // If this is a support medicine, the parent must belong to the same patient
    // and currently be active. Reject otherwise so we never create dangling FKs.
    let parentId = null;
    if (parent_medication_id != null && parent_medication_id !== "") {
      const pidNum = Number(parent_medication_id);
      if (!Number.isFinite(pidNum)) {
        return res.status(400).json({ error: "Invalid parent_medication_id" });
      }
      const parentRow = await pool.query(
        `SELECT id FROM medications WHERE id = $1 AND patient_id = $2 AND is_active = true`,
        [pidNum, pid],
      );
      if (!parentRow.rows[0]) {
        return res
          .status(400)
          .json({ error: "Parent medication not found or not active for this patient" });
      }
      parentId = pidNum;
    }
    const forDx = Array.isArray(for_diagnosis)
      ? for_diagnosis
      : for_diagnosis
        ? [for_diagnosis]
        : null;

    // Strip any dosage-form prefix the doctor may have typed ("TAB Concor",
    // "INJ Wegovy") so the stored brand name is canonical. The prefix becomes
    // the route fallback — an explicit route in the payload still wins.
    const { name: cleanName, form: detectedForm } = stripFormPrefix(name);
    const storedName = cleanName || name;
    const storedRoute = t(route, 50) || routeForForm(detectedForm) || "Oral";
    const pharmacyMatch = canonicalMedKey(storedName);

    // Auto-detect group and class if not provided
    const detectedGroup = med_group || detectMedGroup({ name: storedName, composition });
    const detectedClass = drug_class || detectDrugClass({ name: storedName, composition });

    // Pin the new row's last_prescribed_date to the current visit anchor
    // (= max last_prescribed_date across the patient's active meds). This
    // keeps the new med in the same "Last visit" bucket as the rest without
    // pushing earlier meds into "Previous visits". If the patient has no
    // active meds yet, fall back to today.
    const anchorRes = await pool.query(
      `SELECT MAX(last_prescribed_date)::text AS anchor
         FROM medications
        WHERE patient_id = $1 AND is_active = true AND last_prescribed_date IS NOT NULL`,
      [pid],
    );
    const visitAnchor = anchorRes.rows[0]?.anchor || null;

    const r = await pool.query(
      `INSERT INTO medications (patient_id, name, pharmacy_match, composition, dose, frequency, timing, route, for_diagnosis, is_active, started_date, appointment_id, source, med_group, drug_class, external_doctor, clinical_note, notes, parent_medication_id, support_condition, last_prescribed_date, days_of_week, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,COALESCE($10::date, CURRENT_DATE),$11,'visit',$12,$13,$14,$15,$16,$17,$18,COALESCE($19::date, CURRENT_DATE),$20::int[],NOW())
       ON CONFLICT (patient_id, UPPER(COALESCE(pharmacy_match, name))) WHERE is_active = true
       DO UPDATE SET
         pharmacy_match = COALESCE(EXCLUDED.pharmacy_match, medications.pharmacy_match),
         composition = COALESCE(EXCLUDED.composition, medications.composition),
         dose = COALESCE(EXCLUDED.dose, medications.dose),
         frequency = COALESCE(EXCLUDED.frequency, medications.frequency),
         timing = COALESCE(EXCLUDED.timing, medications.timing),
         route = COALESCE(EXCLUDED.route, medications.route),
         for_diagnosis = COALESCE(EXCLUDED.for_diagnosis, medications.for_diagnosis),
         appointment_id = COALESCE(EXCLUDED.appointment_id, medications.appointment_id),
         med_group = COALESCE(EXCLUDED.med_group, medications.med_group),
         drug_class = COALESCE(EXCLUDED.drug_class, medications.drug_class),
         external_doctor = COALESCE(EXCLUDED.external_doctor, medications.external_doctor),
         clinical_note = COALESCE(EXCLUDED.clinical_note, medications.clinical_note),
         notes = COALESCE(EXCLUDED.notes, medications.notes),
         parent_medication_id = COALESCE(EXCLUDED.parent_medication_id, medications.parent_medication_id),
         support_condition = COALESCE(EXCLUDED.support_condition, medications.support_condition),
         last_prescribed_date = GREATEST(medications.last_prescribed_date, EXCLUDED.last_prescribed_date),
         days_of_week = COALESCE(EXCLUDED.days_of_week, medications.days_of_week),
         updated_at = NOW()
       RETURNING *`,
      [
        pid,
        t(storedName, 200),
        t(pharmacyMatch, 200),
        t(composition, 200),
        t(dose, 100),
        t(frequency, 100),
        t(timing, 200),
        storedRoute,
        forDx,
        n(started_date),
        appointment_id || null,
        t(detectedGroup, 50),
        t(detectedClass, 50),
        t(external_doctor, 200),
        t(clinical_note, 500),
        t(notes, 1000),
        parentId,
        parentId ? t(support_condition, 200) : null,
        visitAnchor,
        finalDays,
      ],
    );
    await markMedicationVisitStatus(pid).catch((e) =>
      console.warn("[Visit] markMedicationVisitStatus failed:", e.message),
    );
    syncMedicationsToGenie(pid, pool).catch((e) =>
      console.warn("[Visit] Medications push skipped:", e.message),
    );
    // Background fill of patient-facing common side effects via Claude.
    // Fire-and-forget so the add-medicine response is not delayed; the
    // service no-ops if the row already has side effects (extractor wrote
    // them) or if the medicine is unrecognised.
    const newMedId = r.rows[0]?.id;
    if (newMedId) {
      backfillCommonSideEffectsForMed(newMedId)
        .then(() => syncMedicationsToGenie(pid, pool))
        .catch((e) => console.warn("[Visit] common side effects fill skipped:", e.message));
    }
    res.json(r.rows[0]);
  } catch (e) {
    handleError(res, e, "Add medication");
  }
});

// ── PATCH /visit/:patientId/medication/:id — Edit medication ──
router.patch("/visit/:patientId/medication/:id", async (req, res) => {
  const pid = Number(req.params.patientId);
  const rawId = String(req.params.id || "");
  if (!pid) return res.status(400).json({ error: "Invalid IDs" });

  const mid = Number(rawId);
  if (!mid) return res.status(400).json({ error: "Invalid IDs" });
  try {
    const {
      dose,
      frequency,
      timing,
      reason,
      last_prescribed_date,
      parent_medication_id,
      support_condition,
      // Extended-edit fields — let doctors update richer metadata on an
      // active medicine without going through stop+re-add.
      med_group,
      drug_class,
      external_doctor,
      route,
      clinical_note,
      notes,
      for_diagnosis,
      started_date,
      side_effects,
      days_of_week,
    } = req.body;

    // Load existing row so we can snapshot the pre-edit state into history
    const existing = await pool.query(
      "SELECT dose, frequency, timing FROM medications WHERE id=$1 AND patient_id=$2 AND is_active=true",
      [mid, pid],
    );
    if (!existing.rows[0]) return res.status(404).json({ error: "Medication not found" });
    const prev = existing.rows[0];

    const nextDose = dose !== undefined ? t(dose, 100) : prev.dose;
    const nextFreq = frequency !== undefined ? t(frequency, 100) : prev.frequency;
    const nextTiming = timing !== undefined ? t(timing, 200) : prev.timing;

    const changed =
      (prev.dose || "") !== (nextDose || "") ||
      (prev.frequency || "") !== (nextFreq || "") ||
      (prev.timing || "") !== (nextTiming || "");

    const historyEntry = changed
      ? JSON.stringify([
          {
            at: new Date().toISOString(),
            reason: t(reason, 500) || null,
            from: { dose: prev.dose, frequency: prev.frequency, timing: prev.timing },
            to: { dose: nextDose, frequency: nextFreq, timing: nextTiming },
          },
        ])
      : null;

    // Optional: explicit last_prescribed_date bump (used by "Move to Active"
    // on previous-visit rows). Only accept ISO date strings; null is allowed
    // to reset.
    const setLastPrescribed = last_prescribed_date !== undefined;
    const nextLastPrescribed = setLastPrescribed ? n(last_prescribed_date) : null;

    // Optional: change parent_medication_id / support_condition. `null`
    // explicitly demotes a sub-med to standalone. A new parent must belong
    // to the same patient and be currently active.
    const setParent = parent_medication_id !== undefined;
    let nextParentId = null;
    if (setParent && parent_medication_id != null && parent_medication_id !== "") {
      const pidNum = Number(parent_medication_id);
      if (!Number.isFinite(pidNum) || pidNum === mid) {
        return res.status(400).json({ error: "Invalid parent_medication_id" });
      }
      const parentRow = await pool.query(
        `SELECT id FROM medications WHERE id = $1 AND patient_id = $2 AND is_active = true`,
        [pidNum, pid],
      );
      if (!parentRow.rows[0]) {
        return res
          .status(400)
          .json({ error: "Parent medication not found or not active for this patient" });
      }
      nextParentId = pidNum;
    }
    const setSupportCondition = support_condition !== undefined;
    const nextSupportCondition = setSupportCondition ? t(support_condition, 200) : null;

    // Optional extended-edit fields. Each uses an explicit "set" boolean so
    // we can distinguish "not provided" (keep existing) from "set to null"
    // (clear). for_diagnosis is normalised to text[] (array) or null.
    const setMedGroup = med_group !== undefined;
    const setDrugClass = drug_class !== undefined;
    const setExternalDoctor = external_doctor !== undefined;
    const setRoute = route !== undefined;
    const setClinicalNote = clinical_note !== undefined;
    const setNotesField = notes !== undefined;
    const setForDx = for_diagnosis !== undefined;
    const setStartedDate = started_date !== undefined;
    const setSideEffects = side_effects !== undefined;
    const setDaysOfWeek = days_of_week !== undefined;
    // Normalise to int[] (0=Sun … 6=Sat) or null. Anything outside that
    // range is dropped so we don't poison the column with bad values.
    const nextDaysOfWeek = setDaysOfWeek
      ? Array.isArray(days_of_week)
        ? (() => {
            const cleaned = Array.from(
              new Set(
                days_of_week
                  .map((d) => Number(d))
                  .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6),
              ),
            ).sort((a, b) => a - b);
            return cleaned.length ? cleaned : null;
          })()
        : null
      : null;
    const nextForDx = setForDx
      ? Array.isArray(for_diagnosis)
        ? for_diagnosis
        : for_diagnosis
          ? [for_diagnosis]
          : null
      : null;

    const r = await pool.query(
      `UPDATE medications SET
         dose = $1, frequency = $2, timing = $3,
         notes = CASE WHEN $20::boolean THEN $21 ELSE COALESCE($4, notes) END,
         history = CASE WHEN $5::jsonb IS NULL THEN COALESCE(history, '[]'::jsonb)
                        ELSE COALESCE(history, '[]'::jsonb) || $5::jsonb END,
         last_prescribed_date = CASE WHEN $8::boolean THEN $9::date ELSE last_prescribed_date END,
         parent_medication_id = CASE WHEN $10::boolean THEN $11::int ELSE parent_medication_id END,
         support_condition = CASE WHEN $12::boolean THEN $13 ELSE support_condition END,
         med_group       = CASE WHEN $14::boolean THEN $15 ELSE med_group END,
         drug_class      = CASE WHEN $16::boolean THEN $17 ELSE drug_class END,
         external_doctor = CASE WHEN $18::boolean THEN $19 ELSE external_doctor END,
         route           = CASE WHEN $22::boolean THEN $23 ELSE route END,
         clinical_note   = CASE WHEN $24::boolean THEN $25 ELSE clinical_note END,
         for_diagnosis   = CASE WHEN $26::boolean THEN $27::text[] ELSE for_diagnosis END,
         started_date    = CASE WHEN $28::boolean THEN $29::date ELSE started_date END,
         side_effects    = CASE WHEN $30::boolean THEN $31 ELSE side_effects END,
         days_of_week    = CASE WHEN $32::boolean THEN $33::int[] ELSE days_of_week END,
         updated_at = NOW()
       WHERE id = $6 AND patient_id = $7 AND is_active = true RETURNING *`,
      [
        nextDose,
        nextFreq,
        nextTiming,
        t(reason, 500),
        historyEntry,
        mid,
        pid,
        setLastPrescribed,
        nextLastPrescribed,
        setParent,
        nextParentId,
        setSupportCondition,
        nextSupportCondition,
        setMedGroup,
        t(med_group, 50),
        setDrugClass,
        t(drug_class, 50),
        setExternalDoctor,
        t(external_doctor, 200),
        setNotesField,
        t(notes, 1000),
        setRoute,
        t(route, 50),
        setClinicalNote,
        t(clinical_note, 500),
        setForDx,
        nextForDx,
        setStartedDate,
        setStartedDate ? n(started_date) : null,
        setSideEffects,
        t(side_effects, 500),
        setDaysOfWeek,
        nextDaysOfWeek,
      ],
    );
    if (!r.rows[0]) return res.status(404).json({ error: "Medication not found" });

    // If this medicine just became a sub-medicine of another, re-point any of
    // its own existing children to the new parent so we don't end up with
    // nested parent → child → grandchild chains.
    if (setParent && nextParentId != null) {
      await pool.query(
        `UPDATE medications
            SET parent_medication_id = $1, updated_at = NOW()
          WHERE patient_id = $2
            AND parent_medication_id = $3
            AND is_active = true`,
        [nextParentId, pid, mid],
      );
    }

    await markMedicationVisitStatus(pid).catch((e) =>
      console.warn("[Visit] markMedicationVisitStatus failed:", e.message),
    );
    syncMedicationsToGenie(pid, pool).catch((e) =>
      console.warn("[Visit] Medications push skipped:", e.message),
    );
    res.json(r.rows[0]);
  } catch (e) {
    handleError(res, e, "Edit medication");
  }
});

// ── PATCH /visit/:patientId/medication/:id/stop — Stop medication ──
router.patch("/visit/:patientId/medication/:id/stop", async (req, res) => {
  const pid = Number(req.params.patientId);
  const rawId = String(req.params.id || "");
  if (!pid) return res.status(400).json({ error: "Invalid IDs" });

  const mid = Number(rawId);
  if (!mid) return res.status(400).json({ error: "Invalid IDs" });
  const client = await pool.connect();
  try {
    const { reason, notes, cascade } = req.body;
    if (!reason) {
      client.release();
      return res.status(400).json({ error: "reason is required" });
    }

    await client.query("BEGIN");

    const med = await client.query(
      "SELECT pharmacy_match, name FROM medications WHERE id = $1 AND patient_id = $2",
      [mid, pid],
    );
    if (!med.rows[0]) {
      await client.query("ROLLBACK");
      client.release();
      return res.status(404).json({ error: "Medication not found" });
    }

    const matchKey = med.rows[0].pharmacy_match || med.rows[0].name;
    await client.query(
      `DELETE FROM medications
       WHERE patient_id = $1 AND id != $2 AND is_active = false
         AND UPPER(COALESCE(pharmacy_match, name)) = UPPER($3)`,
      [pid, mid, matchKey],
    );

    const r = await client.query(
      `UPDATE medications SET is_active = false, stopped_date = CURRENT_DATE,
         stop_reason = $1, notes = COALESCE($2, notes), updated_at = NOW()
       WHERE id = $3 AND patient_id = $4 AND is_active = true RETURNING *`,
      [t(reason, 200), t(notes, 500), mid, pid],
    );
    if (!r.rows[0]) {
      await client.query("ROLLBACK");
      client.release();
      return res.status(404).json({ error: "Medication not found or already stopped" });
    }

    let cascadedCount = 0;
    let promotedCount = 0;
    if (cascade === true) {
      const childRes = await client.query(
        `UPDATE medications
            SET is_active = false,
                stopped_date = CURRENT_DATE,
                stop_reason = COALESCE(stop_reason, $3),
                updated_at = NOW()
          WHERE patient_id = $1
            AND parent_medication_id = $2
            AND is_active = true
          RETURNING id`,
        [pid, mid, `Stopped with parent (${med.rows[0].name})`],
      );
      cascadedCount = childRes.rowCount;
    } else {
      // Doctor chose to keep the support meds active. Without their parent
      // they'd render as orphan sub-meds; promote them to standalone so they
      // appear as ordinary entries in the current-visit list.
      const promoteRes = await client.query(
        `UPDATE medications
            SET parent_medication_id = NULL,
                support_condition = NULL,
                updated_at = NOW()
          WHERE patient_id = $1
            AND parent_medication_id = $2
            AND is_active = true
          RETURNING id`,
        [pid, mid],
      );
      promotedCount = promoteRes.rowCount;
    }

    await client.query("COMMIT");
    client.release();

    await markMedicationVisitStatus(pid).catch((e) =>
      console.warn("[Visit] markMedicationVisitStatus failed:", e.message),
    );
    syncMedicationsToGenie(pid, pool).catch((e) =>
      console.warn("[Visit] Medications push skipped:", e.message),
    );
    res.json({ ...r.rows[0], cascadedCount, promotedCount });
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    client.release();
    handleError(res, e, "Stop medication");
  }
});

// ── PATCH /visit/:patientId/medication/:id/restart — Restart a stopped med ──
// Flips is_active back to true and clears stopped_date / stop_reason. If an
// active row with the same normalised name already exists, returns 409 so
// the doctor can decide whether to merge — otherwise the partial unique
// index on (patient_id, UPPER(COALESCE(pharmacy_match, name))) WHERE is_active
// would reject the UPDATE.
router.patch("/visit/:patientId/medication/:id/restart", async (req, res) => {
  const pid = Number(req.params.patientId);
  const mid = Number(req.params.id);
  if (!pid || !mid) return res.status(400).json({ error: "Invalid IDs" });
  const { cascade, asStandalone } = req.body || {};
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const med = await client.query(
      "SELECT pharmacy_match, name, is_active, parent_medication_id FROM medications WHERE id = $1 AND patient_id = $2",
      [mid, pid],
    );
    if (!med.rows[0]) {
      await client.query("ROLLBACK");
      client.release();
      return res.status(404).json({ error: "Medication not found" });
    }
    if (med.rows[0].is_active) {
      await client.query("ROLLBACK");
      client.release();
      return res.json({ ok: true, alreadyActive: true });
    }

    const matchKey = med.rows[0].pharmacy_match || med.rows[0].name;
    const dup = await client.query(
      `SELECT id, name FROM medications
        WHERE patient_id = $1 AND id != $2 AND is_active = true
          AND UPPER(COALESCE(pharmacy_match, name)) = UPPER($3)
        LIMIT 1`,
      [pid, mid, matchKey],
    );
    if (dup.rows[0]) {
      await client.query("ROLLBACK");
      client.release();
      return res.status(409).json({
        error: "An active medication with this name already exists",
        existingId: dup.rows[0].id,
        existingName: dup.rows[0].name,
      });
    }

    // Restart only flips status — every other field (started_date,
    // last_prescribed_date, consultation_id, parent link, dose, etc.) is
    // preserved exactly as it was before the med was stopped.
    // If asStandalone is set on a child row, also clear the parent link so
    // the restarted med is no longer rendered as a support medicine.
    const promote = asStandalone === true && med.rows[0].parent_medication_id != null;
    const r = await client.query(
      `UPDATE medications
          SET is_active = true,
              stopped_date = NULL,
              stop_reason = NULL,
              parent_medication_id = CASE WHEN $3::boolean THEN NULL ELSE parent_medication_id END,
              support_condition = CASE WHEN $3::boolean THEN NULL ELSE support_condition END,
              visit_status = 'current',
              updated_at = NOW()
        WHERE id = $1 AND patient_id = $2 AND is_active = false
        RETURNING *`,
      [mid, pid, promote],
    );
    if (!r.rows[0]) {
      await client.query("ROLLBACK");
      client.release();
      return res.status(404).json({ error: "Medication not found or already active" });
    }

    // Cascade-restart any inactive sub-meds that were attached to this parent.
    // Skip any whose name collides with a currently-active row so the partial
    // unique index doesn't blow up — return their ids so the UI can warn.
    const cascadeRestarted = [];
    const cascadeSkipped = [];
    if (cascade === true) {
      const children = await client.query(
        `SELECT id, name, pharmacy_match FROM medications
          WHERE patient_id = $1 AND parent_medication_id = $2 AND is_active = false`,
        [pid, mid],
      );
      for (const ch of children.rows) {
        const ckey = ch.pharmacy_match || ch.name;
        const cdup = await client.query(
          `SELECT id FROM medications
            WHERE patient_id = $1 AND id != $2 AND is_active = true
              AND UPPER(COALESCE(pharmacy_match, name)) = UPPER($3)
            LIMIT 1`,
          [pid, ch.id, ckey],
        );
        if (cdup.rows[0]) {
          cascadeSkipped.push({ id: ch.id, name: ch.name, existingId: cdup.rows[0].id });
          continue;
        }
        await client.query(
          `UPDATE medications
              SET is_active = true,
                  stopped_date = NULL,
                  stop_reason = NULL,
                  visit_status = 'current',
                  updated_at = NOW()
            WHERE id = $1 AND patient_id = $2 AND is_active = false`,
          [ch.id, pid],
        );
        cascadeRestarted.push(ch.id);
      }
    }

    await client.query("COMMIT");
    client.release();

    // Restart only stamps `visit_status='current'` on the restarted row(s)
    // (and any cascade-restarted children). Other active meds keep their
    // existing visit_status — a previous-visit med stays in the "Prev Visit"
    // bucket instead of getting promoted back to current.
    syncMedicationsToGenie(pid, pool).catch((e) =>
      console.warn("[Visit] Medications push skipped:", e.message),
    );
    res.json({ ...r.rows[0], cascadeRestarted, cascadeSkipped });
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    client.release();
    handleError(res, e, "Restart medication");
  }
});

// ── DELETE /visit/:patientId/medication/:id — Delete medication permanently ──
router.delete("/visit/:patientId/medication/:id", async (req, res) => {
  const pid = Number(req.params.patientId);
  const rawId = String(req.params.id || "");
  if (!pid) return res.status(400).json({ error: "Invalid IDs" });

  const mid = Number(rawId);
  if (!mid) return res.status(400).json({ error: "Invalid IDs" });
  try {
    const med = await pool.query(
      "SELECT pharmacy_match, name FROM medications WHERE id = $1 AND patient_id = $2",
      [mid, pid],
    );
    if (!med.rows[0]) return res.status(404).json({ error: "Medication not found" });
    const matchKey = med.rows[0].pharmacy_match || med.rows[0].name;

    // Delete the target row plus every same-canonical-name twin (active or
    // inactive). Without this, a previously hidden inactive twin resurfaces
    // in "Stopped Medications" on the next refetch (see stoppedMeds NOT
    // EXISTS filter) and duplicate active rows from earlier consultations
    // leave a stale card on the UI.
    const r = await pool.query(
      `DELETE FROM medications
       WHERE patient_id = $1
         AND (id = $2 OR UPPER(COALESCE(pharmacy_match, name)) = UPPER($3))
       RETURNING id`,
      [pid, mid, matchKey],
    );
    if (!r.rows.length) return res.status(404).json({ error: "Medication not found" });

    await markMedicationVisitStatus(pid).catch((e) =>
      console.warn("[Visit] markMedicationVisitStatus failed:", e.message),
    );
    syncMedicationsToGenie(pid, pool).catch((e) =>
      console.warn("[Visit] Medications push skipped:", e.message),
    );
    res.json({ success: true, deleted: r.rows.length });
  } catch (e) {
    handleError(res, e, "Delete medication");
  }
});

// ── POST /visit/:patientId/referral — Add referral ──
router.post("/visit/:patientId/referral", async (req, res) => {
  const pid = Number(req.params.patientId);
  if (!pid) return res.status(400).json({ error: "Invalid patient ID" });
  try {
    const { doctor_name, speciality, reason, appointment_id } = req.body;
    if (!doctor_name || !speciality)
      return res.status(400).json({ error: "doctor_name and speciality required" });
    const r = await pool.query(
      `INSERT INTO referrals (patient_id, doctor_name, speciality, reason, appointment_id) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [pid, t(doctor_name, 200), t(speciality, 100), t(reason, 1000), appointment_id || null],
    );
    res.json(r.rows[0]);
  } catch (e) {
    handleError(res, e, "Add referral");
  }
});

// ── Lab report auto-extraction (fire-and-forget after upload) ──
const LAB_PROMPT = `Extract ALL test results from this lab report image. Return ONLY valid JSON, no backticks.
{"lab_name":"name of laboratory/hospital that performed tests","report_date":"YYYY-MM-DD","collection_date":"YYYY-MM-DD or null","patient_on_report":{"name":"","age":"","sex":""},"panels":[{"panel_name":"Panel","tests":[{"test_name":"","result":0.0,"result_text":null,"unit":"","flag":null,"ref_range":""}]}]}
CRITICAL RULES:
- Extract EVERY test result on the report without exception, even if there are more than 50 tests. Do not skip or truncate.
- report_date: MUST extract the date tests were performed/collected/reported. Look for "Date:", "Report Date:", "Sample Date:", "Collection Date:" in the header. Format as YYYY-MM-DD.
- lab_name: Extract the laboratory/hospital name from the report header.
- test_name: Use SHORT STANDARD names. Map to these canonical names when applicable:
  HbA1c, FBS, PPBS, Fasting Insulin, C-Peptide, Mean Plasma Glucose, RBS, Fructosamine,
  Total Cholesterol, LDL, HDL, Triglycerides, VLDL, Non-HDL,
  Creatinine, BUN, Uric Acid, eGFR, UACR, Sodium, Potassium, Calcium, Phosphorus,
  TSH, T3, T4, Free T3, Free T4,
  SGPT (ALT), SGOT (AST), ALP, GGT, Total Bilirubin, Direct Bilirubin, Indirect Bilirubin, Albumin, Total Protein,
  Hemoglobin, WBC, RBC, Platelets, MCV, MCH, MCHC, PCV, ESR, CRP, hs-CRP,
  Vitamin D, Vitamin B12, Ferritin, Iron, TIBC, Folate,
  Total Testosterone, Free Testosterone, Cortisol, LH, FSH, Prolactin, AMH, Estradiol, Progesterone, DHEAS, IGF-1,
  Homocysteine, Lipoprotein(a), D-Dimer, Procalcitonin,
  PSA, Urine Routine, Microalbumin
  Example: "Glycated Hemoglobin" → "HbA1c", "Fasting Blood Sugar" → "FBS", "Fasting Plasma Glucose" → "FBS", "Post Prandial Blood Sugar" → "PPBS"
- flag: "H" high, "L" low, null normal.
- ref_range: extract reference range as shown (e.g. "4.0-6.5").
- result: numeric value. result_text: only if result is non-numeric (e.g. "Positive", "Reactive").`;

async function autoExtractLab(docId, patientId, base64, mediaType, docDate) {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return;
  try {
    const block =
      mediaType === "application/pdf"
        ? {
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: base64 },
          }
        : { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } };

    const headers = {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    };
    if (mediaType === "application/pdf") headers["anthropic-beta"] = "pdfs-2024-09-25";

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 8000,
        messages: [{ role: "user", content: [block, { type: "text", text: LAB_PROMPT }] }],
      }),
    });
    if (!resp.ok) return;
    const data = await resp.json();
    const text = (data.content || []).map((c) => c.text || "").join("");
    if (!text) return;

    // Parse JSON from AI response
    let clean = text
      .replace(/```json\s*/g, "")
      .replace(/```\s*/g, "")
      .trim();
    let extracted;
    try {
      extracted = JSON.parse(clean);
    } catch {
      clean = clean.replace(/,\s*([}\]])/g, "$1");
      const ob = (clean.match(/{/g) || []).length;
      const cb = (clean.match(/}/g) || []).length;
      for (let i = 0; i < ob - cb; i++) clean += "}";
      try {
        extracted = JSON.parse(clean);
      } catch {
        return;
      }
    }
    if (!extracted?.panels) return;

    // Save extracted_data to document
    await pool.query(`UPDATE documents SET extracted_data = $1::jsonb WHERE id = $2`, [
      JSON.stringify(extracted),
      docId,
    ]);

    // Remove previous entries synced from this document (avoid duplicates)
    await pool.query(`DELETE FROM lab_results WHERE document_id = $1`, [docId]);

    // Save lab results
    const testDate =
      extracted.report_date ||
      extracted.collection_date ||
      (docDate
        ? new Date(docDate).toISOString().split("T")[0]
        : new Date().toISOString().split("T")[0]);

    for (const panel of extracted.panels) {
      for (const test of panel.tests || []) {
        if (test.result == null && !test.result_text) continue;
        const numResult = typeof test.result === "number" ? test.result : parseFloat(test.result);
        await pool.query(
          `INSERT INTO lab_results
             (patient_id, document_id, test_date, panel_name, test_name, canonical_name, result, result_text, unit, flag, ref_range, source)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'report_extract')`,
          [
            patientId,
            docId,
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
    await syncVitalsFromExtraction(patientId, extracted, docDate);

    // Sync biomarkers to latest appointment so OPD page reflects new values
    try {
      const { rows: apptRows } = await pool.query(
        `SELECT id FROM appointments WHERE patient_id = $1 ORDER BY appointment_date DESC LIMIT 1`,
        [patientId],
      );
      if (apptRows[0]) {
        await syncBiomarkersFromLatestLabs(patientId, apptRows[0].id);
      }
    } catch (syncErr) {
      console.error(
        `[AutoExtract] Biomarker sync failed for patient ${patientId}:`,
        syncErr.message,
      );
    }

    console.log(
      `[AutoExtract] Doc ${docId}: extracted ${extracted.panels.length} panels for patient ${patientId}`,
    );
  } catch (err) {
    console.error(`[AutoExtract] Doc ${docId} failed:`, err.message);
  }
}

// ── POST /visit/:patientId/document — Upload document ──
router.post("/visit/:patientId/document", async (req, res) => {
  const pid = Number(req.params.patientId);
  if (!pid) return res.status(400).json({ error: "Invalid patient ID" });
  try {
    const { doc_type, doc_date, source, notes, base64, fileName } = req.body;
    if (!doc_type) return res.status(400).json({ error: "doc_type is required" });
    // Insert document metadata
    const r = await pool.query(
      `INSERT INTO documents (patient_id, doc_type, title, doc_date, source, notes)
       VALUES ($1,$2,$3,COALESCE($4::date, CURRENT_DATE),$5,$6) RETURNING *`,
      [
        pid,
        t(doc_type, 50),
        t(fileName || doc_type, 200),
        n(doc_date),
        t(source, 200),
        t(notes, 1000),
      ],
    );
    const doc = r.rows[0];
    let mediaType = "application/octet-stream";
    // Upload file to Supabase if provided
    if (base64 && fileName && SUPABASE_URL && SUPABASE_SERVICE_KEY) {
      mediaType = fileName.match(/\.pdf$/i)
        ? "application/pdf"
        : fileName.match(/\.png$/i)
          ? "image/png"
          : fileName.match(/\.jpe?g$/i)
            ? "image/jpeg"
            : "application/octet-stream";
      const safeName = sanitizeForStorageKey(fileName);
      const storagePath = `patients/${pid}/${doc_type}/${Date.now()}_${safeName}`;
      const fileBuffer = Buffer.from(base64, "base64");
      const uploadResp = await fetch(
        `${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${storagePath}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
            "Content-Type": mediaType,
            "x-upsert": "true",
          },
          body: fileBuffer,
        },
      );
      if (uploadResp.ok) {
        await pool.query(
          "UPDATE documents SET storage_path=$1, mime_type=$2, file_name=COALESCE(NULLIF($3,''),file_name) WHERE id=$4",
          [storagePath, mediaType, fileName || null, doc.id],
        );
        doc.storage_path = storagePath;
        doc.mime_type = mediaType;
        doc.file_name = fileName || doc.file_name;
      } else {
        const errBody = await uploadResp.text().catch(() => "");
        console.error(
          `[visit/document] Supabase upload failed for doc ${doc.id} (${fileName}): ${uploadResp.status} ${errBody}`,
        );
      }
    }
    // Fire-and-forget: auto-extract lab results from uploaded lab reports
    if (doc_type === "lab_report" && base64) {
      autoExtractLab(doc.id, pid, base64, mediaType, doc_date).catch(() => {});
    }
    res.json(doc);
  } catch (e) {
    handleError(res, e, "Upload document");
  }
});

// ── PATCH /visit/:patientId/investigations — Append investigations_to_order on latest consultation ──
// Accepts { items: [{name, urgency}] }. Merges into con_data.investigations_to_order of the
// latest consultation, deduping by lowercase-trimmed name so repeated pastes don't stack duplicates.
router.patch("/visit/:patientId/investigations", async (req, res) => {
  const pid = Number(req.params.patientId);
  if (!pid) return res.status(400).json({ error: "Invalid patient ID" });
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const clean = items
      .map((it) => ({
        name: t(it?.name, 200),
        urgency: t(it?.urgency, 50) || "routine",
      }))
      .filter((it) => it.name);
    if (!clean.length) return res.status(400).json({ error: "items array is required" });

    const existingRow = await pool.query(
      `SELECT id, con_data FROM consultations
       WHERE patient_id = $1
       ORDER BY visit_date DESC, created_at DESC LIMIT 1`,
      [pid],
    );
    if (!existingRow.rows[0]) return res.status(404).json({ error: "No consultation found" });

    const existing = Array.isArray(existingRow.rows[0].con_data?.investigations_to_order)
      ? existingRow.rows[0].con_data.investigations_to_order
      : [];
    const seen = new Set(
      existing.map((e) =>
        String(e?.name || "")
          .toLowerCase()
          .trim(),
      ),
    );
    const merged = [...existing];
    for (const it of clean) {
      const key = it.name.toLowerCase().trim();
      if (!seen.has(key)) {
        merged.push(it);
        seen.add(key);
      }
    }

    await pool.query(
      `UPDATE consultations
       SET con_data = jsonb_set(COALESCE(con_data, '{}'::jsonb), '{investigations_to_order}', $1::jsonb),
           updated_at = NOW()
       WHERE id = $2`,
      [JSON.stringify(merged), existingRow.rows[0].id],
    );
    res.json({
      success: true,
      investigations_to_order: merged,
      added: merged.length - existing.length,
    });
  } catch (e) {
    handleError(res, e, "Patch investigations");
  }
});

// ── POST /visit/:patientId/scribe-prescription ───────────────────────────────
// Generates a sectioned PDF from the AI-extracted clinical payload and saves it
// as a "prescription" document tagged source='scribe'. Called from the paste-
// notes review modal AFTER the doctor confirms which items to apply, so the PDF
// reflects what was actually accepted (not the raw AI guess).
router.post("/visit/:patientId/scribe-prescription", async (req, res) => {
  const pid = Number(req.params.patientId);
  if (!pid) return res.status(400).json({ error: "Invalid patient ID" });
  try {
    const { patient, doctor, parsed, raw_text, doc_date } = req.body || {};
    if (!parsed || typeof parsed !== "object") {
      return res.status(400).json({ error: "parsed payload is required" });
    }

    // PDF generation disabled for now — only raw text + parsed analysis are saved.
    // Re-enable when the prescription PDF output is needed again.
    // const pdfBuffer = await buildPrescriptionPdf({
    //   patient: patient || {},
    //   doctor: doctor || {},
    //   parsed,
    //   doc_date,
    // });

    // Resolve the latest consultation so the doc can hang off it (mirrors the
    // existing prescription→consultation linkage at documents.js:593).
    const latestCon = await pool.query(
      `SELECT id FROM consultations WHERE patient_id = $1
       ORDER BY visit_date DESC, created_at DESC LIMIT 1`,
      [pid],
    );
    const consultationId = latestCon.rows[0]?.id || null;

    const dateLabel = (() => {
      const d = doc_date ? new Date(doc_date) : new Date();
      return Number.isNaN(d.getTime())
        ? new Date().toISOString().slice(0, 10)
        : d.toISOString().slice(0, 10);
    })();
    const title = `Prescription — Scribe — ${dateLabel}`;
    const fileName = `scribe-prescription-${Date.now()}.pdf`;

    // Insert the documents row first so we have an id for the storage path.
    const ins = await pool.query(
      `INSERT INTO documents
         (patient_id, consultation_id, doc_type, title, file_name, doc_date,
          source, notes, extracted_text, extracted_data)
       VALUES ($1,$2,'prescription',$3,$4,COALESCE($5::date, CURRENT_DATE),
               'scribe','Created by Scribe',$6,$7::jsonb)
       RETURNING *`,
      [
        pid,
        consultationId,
        t(title, 200),
        t(fileName, 200),
        n(doc_date),
        raw_text ? String(raw_text).slice(0, 50000) : null,
        JSON.stringify(parsed),
      ],
    );
    const docRow = ins.rows[0];

    // Push to Genie so the patient app's Story screen renders this saved
    // prescription immediately. syncDocumentsToGenie will fold extracted_text
    // (the raw pasted note) into the JSONB payload it sends to Supabase, so
    // when the user taps the prescription card in the app they see the
    // original note alongside the extracted meds/diagnoses.
    syncDocumentsToGenie(pid, pool).catch((e) =>
      console.warn("[Visit] Documents push skipped:", e.message),
    );

    // PDF upload disabled for now — document row is saved with raw_text +
    // parsed payload only; no binary file is produced. Re-enable alongside
    // buildPrescriptionPdf() above when prescription output is needed.
    // if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
    //   const storagePath = `patients/${pid}/prescription/${Date.now()}_${fileName}`;
    //   try {
    //     const uploadResp = await fetch(
    //       `${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${storagePath}`,
    //       {
    //         method: "POST",
    //         headers: {
    //           Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    //           "Content-Type": "application/pdf",
    //           "x-upsert": "true",
    //         },
    //         body: pdfBuffer,
    //       },
    //     );
    //     if (uploadResp.ok) {
    //       await pool.query(
    //         "UPDATE documents SET storage_path=$1, mime_type='application/pdf' WHERE id=$2",
    //         [storagePath, docRow.id],
    //       );
    //       docRow.storage_path = storagePath;
    //       docRow.mime_type = "application/pdf";
    //     } else {
    //       const errText = await uploadResp.text().catch(() => "");
    //       console.warn("Scribe PDF upload failed:", uploadResp.status, errText.slice(0, 200));
    //     }
    //   } catch (uploadErr) {
    //     console.warn("Scribe PDF upload error:", uploadErr.message);
    //   }
    // }

    res.json(docRow);
  } catch (e) {
    handleError(res, e, "Save scribe prescription");
  }
});

// ── PATCH /visit/:patientId/followup — Update follow-up date on latest consultation ──
router.patch("/visit/:patientId/followup", async (req, res) => {
  const pid = Number(req.params.patientId);
  if (!pid) return res.status(400).json({ error: "Invalid patient ID" });
  try {
    const { date, notes } = req.body;
    if (!date) return res.status(400).json({ error: "date is required" });
    const followUp = { date, notes: notes || null };
    const r = await pool.query(
      `UPDATE consultations
       SET con_data = jsonb_set(COALESCE(con_data, '{}'::jsonb), '{follow_up}', $1::jsonb),
           updated_at = NOW()
       WHERE id = (
         SELECT id FROM consultations WHERE patient_id = $2
         ORDER BY visit_date DESC, created_at DESC LIMIT 1
       ) RETURNING *`,
      [JSON.stringify(followUp), pid],
    );
    if (!r.rows[0]) return res.status(404).json({ error: "No consultation found" });
    syncAppointmentToGenie(pid, pool).catch((e) =>
      console.warn("[Visit] Appointment push skipped:", e.message),
    );
    res.json(r.rows[0]);
  } catch (e) {
    handleError(res, e, "Update follow-up");
  }
});

// ── PATCH /visit/:patientId/follow-up-with — set/clear FOLLOW UP WITH text ──
// Free-text patient instructions for the next visit (fasting / tests to bring
// / preparations). Lives on consultations.con_data.follow_up_with so the
// /visit page can show + edit + print it, and the patient's Genie Care tab
// can mirror it on the upcoming appointment.
router.patch("/visit/:patientId/follow-up-with", async (req, res) => {
  const pid = Number(req.params.patientId);
  if (!pid) return res.status(400).json({ error: "Invalid patient ID" });
  try {
    const raw = req.body?.text;
    const text = typeof raw === "string" ? raw.trim() : null;
    // Empty / null / whitespace = delete (strip key)
    const r = text
      ? await pool.query(
          `UPDATE consultations
             SET con_data = jsonb_set(COALESCE(con_data, '{}'::jsonb), '{follow_up_with}', $1::jsonb),
                 updated_at = NOW()
             WHERE id = (
               SELECT id FROM consultations WHERE patient_id = $2
               ORDER BY visit_date DESC, created_at DESC LIMIT 1
             ) RETURNING *`,
          [JSON.stringify(text), pid],
        )
      : await pool.query(
          `UPDATE consultations
             SET con_data = COALESCE(con_data, '{}'::jsonb) - 'follow_up_with',
                 updated_at = NOW()
             WHERE id = (
               SELECT id FROM consultations WHERE patient_id = $1
               ORDER BY visit_date DESC, created_at DESC LIMIT 1
             ) RETURNING *`,
          [pid],
        );
    if (!r.rows[0]) return res.status(404).json({ error: "No consultation found" });
    // Denormalise onto the patient's upcoming appointment row so the patient
    // app (giniSupabase → vuukipgdegewpwucdgxa) can render it without a JSONB
    // join. Falls back to the most recent past appointment if no upcoming row
    // exists yet (doctor may not have booked the next visit at write time).
    try {
      await pool.query(
        `UPDATE appointments SET follow_up_with = $1, updated_at = NOW()
          WHERE id = (
            SELECT id FROM appointments
             WHERE patient_id = $2
             ORDER BY
               CASE WHEN appointment_date::date >= CURRENT_DATE THEN 0 ELSE 1 END,
               appointment_date ASC,
               id DESC
             LIMIT 1
          )`,
        [text, pid],
      );
    } catch (propErr) {
      // Column may not exist yet on environments that haven't applied the
      // 2026-05-14 migration — non-fatal, the consultation copy is canonical.
      console.warn("[Visit] follow_up_with appt propagation skipped:", propErr.message);
    }
    // Push to Genie too (genie-DB-routed patients) — no-op on missing column.
    syncAppointmentToGenie(pid, pool).catch((e) =>
      console.warn("[Visit] Appointment push skipped:", e.message),
    );
    res.json({ id: r.rows[0].id, follow_up_with: text });
  } catch (e) {
    handleError(res, e, "Update follow_up_with");
  }
});

// ── POST /visit/:patientId/symptom — Add / upsert symptom ──
router.post("/visit/:patientId/symptom", async (req, res) => {
  const pid = Number(req.params.patientId);
  if (!pid) return res.status(400).json({ error: "Invalid patient ID" });
  try {
    const { name, since, severity, related_to, appointment_id } = req.body;
    if (!name) return res.status(400).json({ error: "name is required" });
    const symptomId = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .slice(0, 100);
    const r = await pool.query(
      `INSERT INTO visit_symptoms (patient_id, symptom_id, label, since_date, severity, related_to, appointment_id)
       VALUES ($1,$2,$3,$4::date,$5,$6,$7)
       ON CONFLICT (patient_id, symptom_id) DO UPDATE SET
         label = EXCLUDED.label,
         since_date = COALESCE(EXCLUDED.since_date, visit_symptoms.since_date),
         severity = COALESCE(EXCLUDED.severity, visit_symptoms.severity),
         related_to = COALESCE(EXCLUDED.related_to, visit_symptoms.related_to),
         status = 'Active',
         is_active = true,
         updated_at = NOW()
       RETURNING *`,
      [
        pid,
        symptomId,
        t(name, 500),
        n(since),
        t(severity, 50) || "Mild",
        t(related_to, 200),
        appointment_id || null,
      ],
    );
    res.json(r.rows[0]);
  } catch (e) {
    handleError(res, e, "Add symptom");
  }
});

// ── PATCH /visit/:patientId/symptom/:id — Update symptom status ──
router.patch("/visit/:patientId/symptom/:id", async (req, res) => {
  const pid = Number(req.params.patientId);
  const sid = Number(req.params.id);
  if (!pid || !sid) return res.status(400).json({ error: "Invalid IDs" });
  try {
    const { status } = req.body;
    const r = await pool.query(
      `UPDATE visit_symptoms SET status = COALESCE($1, status), updated_at = NOW()
       WHERE id=$2 AND patient_id=$3 RETURNING *`,
      [t(status, 100), sid, pid],
    );
    if (!r.rows[0]) return res.status(404).json({ error: "Symptom not found" });
    res.json(r.rows[0]);
  } catch (e) {
    handleError(res, e, "Update symptom status");
  }
});

// ── doctor_summaries: per-version doctor narrative for a patient ─────────────
// Each row = one immutable version. Editing creates a new row pointing at
// the prior one via prev_version_id. Latest row per patient is the current.
pool
  .query(
    `CREATE TABLE IF NOT EXISTS doctor_summaries (
       id SERIAL PRIMARY KEY,
       patient_id INTEGER NOT NULL,
       appointment_id INTEGER,
       version INTEGER NOT NULL,
       content TEXT NOT NULL,
       change_note TEXT,
       prev_version_id INTEGER,
       author_name TEXT,
       author_id TEXT,
       created_at TIMESTAMPTZ DEFAULT NOW()
     )`,
  )
  .catch(() => {});
pool
  .query(
    `CREATE INDEX IF NOT EXISTS idx_doctor_summaries_patient
       ON doctor_summaries (patient_id, version DESC)`,
  )
  .catch(() => {});

// GET /visit/:patientId/doctor-summary — return all versions (latest first)
router.get("/visit/:patientId/doctor-summary", async (req, res) => {
  const pid = Number(req.params.patientId);
  if (!pid) return res.status(400).json({ error: "Invalid patient ID" });
  try {
    const { rows } = await pool.query(
      `SELECT id, patient_id, appointment_id, version, content, change_note,
              prev_version_id, author_name, author_id, created_at
         FROM doctor_summaries
        WHERE patient_id = $1
        ORDER BY version DESC, id DESC`,
      [pid],
    );
    res.json({ versions: rows, current: rows[0] || null });
  } catch (e) {
    handleError(res, e, "Load doctor summary");
  }
});

// POST /visit/:patientId/doctor-summary/generate — AI-generate a summary and
// store it as a new version. Body is the same visit data shape used by the
// prescription PDF endpoint. Returns { version, generated: true }.
router.post("/visit/:patientId/doctor-summary/generate", async (req, res) => {
  const pid = Number(req.params.patientId);
  if (!pid) return res.status(400).json({ error: "Invalid patient ID" });
  try {
    const text = await generateVisitSummary(req.body || {});
    const prev = await pool.query(
      `SELECT id, version FROM doctor_summaries
        WHERE patient_id=$1 ORDER BY version DESC LIMIT 1`,
      [pid],
    );
    const nextVersion = (prev.rows[0]?.version || 0) + 1;
    const prevId = prev.rows[0]?.id || null;
    const ins = await pool.query(
      `INSERT INTO doctor_summaries
         (patient_id, appointment_id, version, content, change_note,
          prev_version_id, author_name, author_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, patient_id, appointment_id, version, content, change_note,
                 prev_version_id, author_name, author_id, created_at`,
      [
        pid,
        req.body?.appointment_id || null,
        nextVersion,
        text,
        prev.rows[0] ? "AI regenerated" : "AI generated",
        prevId,
        "AI",
        null,
      ],
    );
    res.json({ success: true, generated: true, version: ins.rows[0] });
  } catch (e) {
    handleError(res, e, "Generate visit summary");
  }
});

// POST /visit/:patientId/doctor-summary — append a new version
router.post("/visit/:patientId/doctor-summary", async (req, res) => {
  const pid = Number(req.params.patientId);
  if (!pid) return res.status(400).json({ error: "Invalid patient ID" });
  const { content, change_note, appointment_id, author_name, author_id } = req.body || {};
  if (typeof content !== "string" || !content.trim()) {
    return res.status(400).json({ error: "content is required" });
  }
  try {
    const prev = await pool.query(
      `SELECT id, version FROM doctor_summaries
        WHERE patient_id = $1 ORDER BY version DESC LIMIT 1`,
      [pid],
    );
    const nextVersion = (prev.rows[0]?.version || 0) + 1;
    const prevId = prev.rows[0]?.id || null;
    const ins = await pool.query(
      `INSERT INTO doctor_summaries
         (patient_id, appointment_id, version, content, change_note,
          prev_version_id, author_name, author_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, patient_id, appointment_id, version, content, change_note,
                 prev_version_id, author_name, author_id, created_at`,
      [
        pid,
        appointment_id || null,
        nextVersion,
        content,
        change_note || null,
        prevId,
        author_name || null,
        author_id || null,
      ],
    );
    res.json({ success: true, version: ins.rows[0] });
  } catch (e) {
    handleError(res, e, "Save doctor summary");
  }
});

// ── patient_summaries: per-version PATIENT-FACING visit narrative ────────────
// Plain-language summary (written for the patient to read). This is the text
// that prints on the prescription PDF "Visit summary" block. Internal doctor
// notes live in doctor_summaries — keep these tables separate.
pool
  .query(
    `CREATE TABLE IF NOT EXISTS patient_summaries (
       id SERIAL PRIMARY KEY,
       patient_id INTEGER NOT NULL,
       appointment_id INTEGER,
       version INTEGER NOT NULL,
       content TEXT NOT NULL,
       change_note TEXT,
       prev_version_id INTEGER,
       author_name TEXT,
       author_id TEXT,
       source TEXT,
       created_at TIMESTAMPTZ DEFAULT NOW()
     )`,
  )
  .catch(() => {});
pool
  .query(
    `CREATE INDEX IF NOT EXISTS idx_patient_summaries_patient
       ON patient_summaries (patient_id, version DESC)`,
  )
  .catch(() => {});
// Tone-aware Hinglish heading the AI returns alongside the body. greeting is
// the leading phrase ("Bahut khoob, Test ji,"); accent is the italic-yellow
// ending phrase ("kuch dekhna hai"). Both null for legacy / manual rows.
pool
  .query(
    `ALTER TABLE patient_summaries
       ADD COLUMN IF NOT EXISTS heading_greeting TEXT,
       ADD COLUMN IF NOT EXISTS heading_accent  TEXT`,
  )
  .catch(() => {});

// GET /visit/:patientId/patient-summary — return all versions (latest first)
router.get("/visit/:patientId/patient-summary", async (req, res) => {
  const pid = Number(req.params.patientId);
  if (!pid) return res.status(400).json({ error: "Invalid patient ID" });
  try {
    const { rows } = await pool.query(
      `SELECT ps.id, ps.patient_id, ps.appointment_id, ps.version, ps.content,
              ps.change_note, ps.prev_version_id, ps.author_name, ps.author_id,
              ps.source, ps.heading_greeting, ps.heading_accent, ps.created_at,
              a.appointment_date
         FROM patient_summaries ps
         LEFT JOIN appointments a ON a.id = ps.appointment_id
        WHERE ps.patient_id = $1
        ORDER BY ps.version DESC, ps.id DESC`,
      [pid],
    );
    res.json({ versions: rows, current: rows[0] || null });
  } catch (e) {
    handleError(res, e, "Load patient summary");
  }
});

// POST /visit/:patientId/patient-summary/generate — AI-generate a patient-facing
// summary and store it as a new version. Body is the same visit data shape used
// by the prescription PDF endpoint.
router.post("/visit/:patientId/patient-summary/generate", async (req, res) => {
  const pid = Number(req.params.patientId);
  if (!pid) return res.status(400).json({ error: "Invalid patient ID" });
  try {
    const { body, heading_greeting, heading_accent } = await generatePatientSummary(req.body || {});
    const prev = await pool.query(
      `SELECT id, version FROM patient_summaries
        WHERE patient_id=$1 ORDER BY version DESC LIMIT 1`,
      [pid],
    );
    const nextVersion = (prev.rows[0]?.version || 0) + 1;
    const prevId = prev.rows[0]?.id || null;
    const ins = await pool.query(
      `INSERT INTO patient_summaries
         (patient_id, appointment_id, version, content, change_note,
          prev_version_id, author_name, author_id, source,
          heading_greeting, heading_accent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ai', $9, $10)
       RETURNING id, patient_id, appointment_id, version, content, change_note,
                 prev_version_id, author_name, author_id, source,
                 heading_greeting, heading_accent, created_at`,
      [
        pid,
        req.body?.appointment_id || null,
        nextVersion,
        body,
        prev.rows[0] ? "AI regenerated" : "AI generated",
        prevId,
        "AI",
        null,
        heading_greeting,
        heading_accent,
      ],
    );
    res.json({ success: true, generated: true, version: ins.rows[0] });
  } catch (e) {
    handleError(res, e, "Generate patient summary");
  }
});

// POST /visit/:patientId/patient-summary — append a new (manually edited) version
router.post("/visit/:patientId/patient-summary", async (req, res) => {
  const pid = Number(req.params.patientId);
  if (!pid) return res.status(400).json({ error: "Invalid patient ID" });
  const { content, change_note, appointment_id, author_name, author_id } = req.body || {};
  if (typeof content !== "string" || !content.trim()) {
    return res.status(400).json({ error: "content is required" });
  }
  try {
    const prev = await pool.query(
      `SELECT id, version FROM patient_summaries
        WHERE patient_id = $1 ORDER BY version DESC LIMIT 1`,
      [pid],
    );
    const nextVersion = (prev.rows[0]?.version || 0) + 1;
    const prevId = prev.rows[0]?.id || null;
    // Carry the heading forward from the previous version so a manual edit of
    // the body doesn't blank the AI-generated greeting/accent.
    const prevHeadingRow = prev.rows[0]
      ? await pool.query(
          `SELECT heading_greeting, heading_accent
             FROM patient_summaries WHERE id = $1`,
          [prev.rows[0].id],
        )
      : null;
    const carriedGreeting = prevHeadingRow?.rows[0]?.heading_greeting ?? null;
    const carriedAccent = prevHeadingRow?.rows[0]?.heading_accent ?? null;
    const ins = await pool.query(
      `INSERT INTO patient_summaries
         (patient_id, appointment_id, version, content, change_note,
          prev_version_id, author_name, author_id, source,
          heading_greeting, heading_accent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'manual', $9, $10)
       RETURNING id, patient_id, appointment_id, version, content, change_note,
                 prev_version_id, author_name, author_id, source,
                 heading_greeting, heading_accent, created_at`,
      [
        pid,
        appointment_id || null,
        nextVersion,
        content,
        change_note || null,
        prevId,
        author_name || null,
        author_id || null,
        carriedGreeting,
        carriedAccent,
      ],
    );
    res.json({ success: true, version: ins.rows[0] });
  } catch (e) {
    handleError(res, e, "Save patient summary");
  }
});

// PATCH /visit/:patientId/doctor-note — save doctor's note
router.patch("/visit/:patientId/doctor-note", async (req, res) => {
  const pid = Number(req.params.patientId);
  if (!pid) return res.status(400).json({ error: "Invalid patient ID" });
  const { note, appointment_id } = req.body;
  if (note === undefined) return res.status(400).json({ error: "note is required" });

  try {
    if (appointment_id) {
      // Active visit — save on appointment
      await pool.query(
        `UPDATE appointments SET opd_vitals = opd_vitals || jsonb_build_object('doctor_note', $1::text), updated_at = NOW() WHERE id = $2`,
        [note, appointment_id],
      );
    } else {
      // No active visit — save on latest consultation
      await pool.query(
        `UPDATE consultations
         SET con_data = COALESCE(con_data, '{}'::jsonb) || jsonb_build_object('assessment_summary', $1::text),
             updated_at = NOW()
         WHERE id = (
           SELECT id FROM consultations WHERE patient_id = $2
           ORDER BY visit_date DESC, created_at DESC LIMIT 1
         )`,
        [note, pid],
      );
    }
    res.json({ success: true });
  } catch (e) {
    handleError(res, e, "Save doctor note");
  }
});

// ── POST /visit/:patientId/parse-text — AI extract biomarkers from pasted text ──
router.post("/visit/:patientId/parse-text", async (req, res) => {
  const pid = Number(req.params.patientId);
  if (!pid) return res.status(400).json({ error: "Invalid patient ID" });
  const { text } = req.body;
  if (!text?.trim() || text.trim().length < 20)
    return res.status(400).json({ error: "Text is too short to parse" });
  try {
    const parsed = await parseClinicalWithAI(text);
    res.json(parsed || {});
  } catch (e) {
    handleError(res, e, "Parse clinical text");
  }
});

// ── PATCH /visit/:patientId/medications/reconcile — Stop meds from older visits ──
router.patch("/visit/:patientId/medications/reconcile", async (req, res) => {
  const pid = Number(req.params.patientId);
  if (!pid) return res.status(400).json({ error: "Invalid patient ID" });
  try {
    // Guard: only run the sweep when the latest consultation actually has a
    // prescription — i.e. meds attached OR clinical notes (con_data). An
    // empty/just-opened visit must not deactivate prior meds.
    // Bug seen on P_54890 where a fresh empty consultation wiped 19 active meds.
    const guard = await pool.query(
      `WITH latest AS (
         SELECT id, con_data FROM consultations
          WHERE patient_id = $1
          ORDER BY visit_date DESC NULLS LAST, id DESC
          LIMIT 1
       )
       SELECT
         EXISTS (SELECT 1 FROM medications m, latest l
                  WHERE m.patient_id = $1 AND m.consultation_id = l.id) AS has_meds,
         (SELECT con_data IS NOT NULL AND con_data::text <> '{}'
            FROM latest) AS has_notes`,
      [pid],
    );
    const g = guard.rows[0] || {};
    if (!g.has_meds && !g.has_notes) {
      return res.json({ stopped: 0, skipped: "latest-visit-empty" });
    }

    // Stop medications from older consultations AND old document medicines
    const r = await pool.query(
      `UPDATE medications
       SET is_active = false, stopped_date = CURRENT_DATE, stop_reason = 'Previous visit'
       WHERE patient_id = $1
         AND is_active = true
         AND (
           -- Case 1: Medicines from older consultations (original logic)
           (consultation_id IS NOT NULL AND consultation_id IN (
             SELECT id FROM consultations
             WHERE patient_id = $1
               AND visit_date < (SELECT MAX(visit_date) FROM consultations WHERE patient_id = $1)
           ))
           -- Case 2: Document/uploaded prescription medicines from past dates only.
           -- Excludes HealthRay medicines (source = 'healthray') and re-extracted
           -- prescription medicines (source = 'report_extract') — those stay
           -- active until the doctor explicitly stops them OR the prescription
           -- re-extraction's own stale-sweep deactivates them (see
           -- runPrescriptionExtraction in routes/documents.js). Without this
           -- exclusion, the newest prescription's meds get nuked here because
           -- their started_date (= doc_date) is naturally in the past.
           OR (consultation_id IS NULL
               AND COALESCE(source, '') NOT IN ('healthray', 'report_extract')
               AND (COALESCE(started_date, created_at::DATE) < CURRENT_DATE))
         )
       RETURNING id`,
      [pid],
    );
    // Only invalidate cached summaries when the reconcile actually changed
    // anything. The default no-op case (page load, nothing to stop) must not
    // wipe the cache or every reload regenerates fresh.
    if (r.rowCount > 0) {
      invalidatePatientSummaries(pid).catch(() => {});
    }
    res.json({ stopped: r.rowCount });
  } catch (e) {
    handleError(res, e, "Reconcile medications");
  }
});

// ── POST /visit/:patientId/vitals — Create new vitals record ──
// Accepts optional recorded_at (ISO date or timestamptz) for historical backfill
// from pasted-text extractions. When omitted, inserts with default NOW().
router.post("/visit/:patientId/vitals", async (req, res) => {
  const pid = Number(req.params.patientId);
  if (!pid) return res.status(400).json({ error: "Invalid patient ID" });
  try {
    const {
      bp_sys,
      bp_dia,
      pulse,
      temp,
      spo2,
      weight,
      height,
      bmi,
      body_fat,
      muscle_mass,
      waist,
      rbs,
      meal_type,
      recorded_at,
    } = req.body;
    const recordedAt = n(recorded_at) || null;
    // Prevent duplicate if same vitals already recorded for this date (today when
    // recorded_at not given, else the supplied date)
    const existing = await pool.query(
      `SELECT id FROM vitals
       WHERE patient_id = $1
         AND recorded_at::date = COALESCE($2::date, CURRENT_DATE)
         AND COALESCE(bp_sys, -1) = COALESCE($3::real, -1)
         AND COALESCE(weight, -1) = COALESCE($4::real, -1)
         AND COALESCE(bmi, -1) = COALESCE($5::real, -1)
       LIMIT 1`,
      [pid, recordedAt, num(bp_sys), num(weight), num(bmi)],
    );
    if (existing.rows.length > 0) {
      return res.json({ ok: true, id: existing.rows[0].id, deduplicated: true });
    }
    const { rows } = await pool.query(
      `INSERT INTO vitals (patient_id, recorded_at, bp_sys, bp_dia, pulse, temp, spo2, weight, height, bmi, body_fat, muscle_mass, waist, rbs, meal_type)
       VALUES ($1, COALESCE($2::timestamptz, NOW()), $3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING id, recorded_at, bp_sys, bp_dia, pulse, temp, spo2, weight, height, rbs, meal_type`,
      [
        pid,
        recordedAt,
        num(bp_sys),
        num(bp_dia),
        num(pulse),
        num(temp),
        num(spo2),
        num(weight),
        num(height),
        num(bmi),
        num(body_fat),
        num(muscle_mass),
        num(waist),
        num(rbs),
        t(meal_type, 50),
      ],
    );
    // Fire-and-forget push so the patient sees doctor-entered BP/weight on
    // the Genie app without waiting for the next full consultation save.
    syncVitalsRowToGenie(pid, rows[0]).catch((e) =>
      console.warn("[Visit] Vitals push skipped:", e.message),
    );
    res.json({ ok: true, id: rows[0].id });
  } catch (e) {
    handleError(res, e, "Create vitals");
  }
});

// ── PATCH /visit/:patientId/vitals/:id — Update existing vitals record ──
router.patch("/visit/:patientId/vitals/:id", async (req, res) => {
  const pid = Number(req.params.patientId);
  const vid = Number(req.params.id);
  if (!pid || !vid) return res.status(400).json({ error: "Invalid IDs" });
  try {
    const allowed = [
      "bp_sys",
      "bp_dia",
      "pulse",
      "temp",
      "spo2",
      "weight",
      "height",
      "bmi",
      "body_fat",
      "muscle_mass",
      "waist",
      "rbs",
      "meal_type",
    ];
    const keys = allowed.filter((f) => req.body[f] !== undefined);
    if (!keys.length) return res.json({ ok: true });
    const sets = keys.map((f, i) => `${f} = $${i + 1}`).join(", ");
    const vals = keys.map((f) => (f === "meal_type" ? t(req.body[f], 50) : num(req.body[f])));
    const upd = await pool.query(
      `UPDATE vitals SET ${sets} WHERE id = $${vals.length + 1} AND patient_id = $${vals.length + 2}
       RETURNING id, recorded_at, bp_sys, bp_dia, pulse, temp, spo2, weight, height, rbs, meal_type`,
      [...vals, vid, pid],
    );
    if (upd.rows[0]) {
      syncVitalsRowToGenie(pid, upd.rows[0]).catch((e) =>
        console.warn("[Visit] Vitals push skipped:", e.message),
      );
    }
    res.json({ ok: true });
  } catch (e) {
    handleError(res, e, "Update vitals");
  }
});

// ── PATCH /visit/:patientId/app-vitals/:logId — edit a patient-app row ──
// Doctor edits a vital that was originally logged from the Genie app. The
// canonical row lives in patient_vitals_log (mirror of Genie `vitals`); we
// update it locally and push the same value change back to Genie via
// genie_id so the patient's app shows the corrected reading.
router.patch("/visit/:patientId/app-vitals/:logId", async (req, res) => {
  const pid = Number(req.params.patientId);
  const logId = Number(req.params.logId);
  if (!pid || !logId) return res.status(400).json({ error: "Invalid IDs" });
  // Map UI field names → patient_vitals_log column names. Inverse of the
  // mapping used when merging app rows into the visit response.
  const FIELD_MAP = {
    bp_sys: "bp_systolic",
    bp_dia: "bp_diastolic",
    pulse: "pulse",
    spo2: "spo2",
    weight: "weight_kg",
    bmi: "bmi",
    body_fat: "body_fat",
    muscle_mass: "muscle_mass",
    waist: "waist",
    rbs: "rbs",
    meal_type: "meal_type",
  };
  try {
    const sets = [];
    const vals = [];
    const genieFields = {};
    for (const [uiKey, col] of Object.entries(FIELD_MAP)) {
      if (req.body[uiKey] === undefined) continue;
      const raw = req.body[uiKey];
      const v = col === "meal_type" ? t(raw, 50) : num(raw);
      vals.push(v);
      sets.push(`${col} = $${vals.length}`);
      genieFields[col] = v;
    }
    if (!sets.length) return res.json({ ok: true });
    vals.push(logId, pid);
    const upd = await pool.query(
      `UPDATE patient_vitals_log SET ${sets.join(", ")}
       WHERE id = $${vals.length - 1} AND patient_id = $${vals.length}
       RETURNING id, genie_id`,
      vals,
    );
    if (!upd.rows[0]) {
      return res.status(404).json({ error: "patient_vitals_log row not found" });
    }
    const genieId = upd.rows[0].genie_id;
    if (genieId) {
      updateGenieVitalsByGenieId(genieId, genieFields).catch((e) =>
        console.warn("[Visit] App-vitals push skipped:", e.message),
      );
    }
    res.json({ ok: true });
  } catch (e) {
    handleError(res, e, "Update app vitals");
  }
});

// ── POST /visit/:patientId/goal — Create / upsert a goal ──
router.post("/visit/:patientId/goal", async (req, res) => {
  try {
    const pid = Number(req.params.patientId);
    if (!pid) return res.status(400).json({ error: "Invalid patient ID" });
    const { marker, current_value, target_value, timeline, priority, notes } = req.body || {};
    if (!marker?.trim()) return res.status(400).json({ error: "marker is required" });
    const m = marker.trim();
    const tv = target_value || null;
    const tl = timeline || null;
    const existing = await pool.query(
      `SELECT id FROM goals
        WHERE patient_id=$1 AND marker=$2
          AND COALESCE(target_value,'')=COALESCE($3,'')
          AND COALESCE(timeline,'')=COALESCE($4,'')
        LIMIT 1`,
      [pid, m, tv, tl],
    );
    let row;
    if (existing.rows.length) {
      const upd = await pool.query(
        `UPDATE goals SET current_value=$2, priority=$3, notes=$4, status='active', updated_at=NOW()
          WHERE id=$1 RETURNING *`,
        [existing.rows[0].id, current_value || null, priority || null, notes || null],
      );
      row = upd.rows[0];
    } else {
      const ins = await pool.query(
        `INSERT INTO goals (patient_id, marker, current_value, target_value, timeline, priority, notes, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'active')
         RETURNING *`,
        [pid, m, current_value || null, tv, tl, priority || null, notes || null],
      );
      row = ins.rows[0];
    }
    res.json(row);
  } catch (e) {
    handleError(res, e, "Create goal");
  }
});

// ── PATCH /visit/:patientId/goal/:id — Edit a goal ──
router.patch("/visit/:patientId/goal/:id", async (req, res) => {
  try {
    const pid = Number(req.params.patientId);
    const id = Number(req.params.id);
    if (!pid || !id) return res.status(400).json({ error: "Invalid IDs" });
    const fields = [
      "marker",
      "current_value",
      "target_value",
      "timeline",
      "priority",
      "status",
      "notes",
    ];
    const sets = [];
    const vals = [];
    let i = 1;
    for (const f of fields) {
      if (req.body[f] !== undefined) {
        sets.push(`${f}=$${i++}`);
        vals.push(req.body[f]);
      }
    }
    if (sets.length === 0) return res.status(400).json({ error: "No fields to update" });
    sets.push(`updated_at=NOW()`);
    vals.push(pid, id);
    const upd = await pool.query(
      `UPDATE goals SET ${sets.join(", ")} WHERE patient_id=$${i++} AND id=$${i} RETURNING *`,
      vals,
    );
    if (!upd.rowCount) return res.status(404).json({ error: "Goal not found" });
    res.json(upd.rows[0]);
  } catch (e) {
    handleError(res, e, "Update goal");
  }
});

// ── DELETE /visit/:patientId/goal/:id ──
router.delete("/visit/:patientId/goal/:id", async (req, res) => {
  try {
    const pid = Number(req.params.patientId);
    const id = Number(req.params.id);
    if (!pid || !id) return res.status(400).json({ error: "Invalid IDs" });
    const del = await pool.query("DELETE FROM goals WHERE patient_id=$1 AND id=$2", [pid, id]);
    if (!del.rowCount) return res.status(404).json({ error: "Goal not found" });
    res.json({ ok: true });
  } catch (e) {
    handleError(res, e, "Delete goal");
  }
});

// ── POST /visit/:patientId/complete ─────────────────────────────────────────
// Called when the doctor ends a visit. Generates the prescription PDF from the
// same visitPayload the client uses for the Rx preview, uploads it to Supabase
// storage, and saves a `documents` row tagged source='visit' so the patient
// record (and Genie app) shows the finalised prescription.
router.post("/visit/:patientId/complete", async (req, res) => {
  const pid = Number(req.params.patientId);
  if (!pid) return res.status(400).json({ error: "Invalid patient ID" });
  try {
    const payload = req.body || {};
    if (!payload.doctor?.name && req.doctor?.name) {
      payload.doctor = { ...(payload.doctor || {}), name: req.doctor.name };
    }
    const result = await savePrescriptionForVisit(pid, payload, {
      source: "visit",
      clientInitiated: true,
    });
    res.json({
      document: result.document,
      file_name: result.file_name,
      storage_path: result.storage_path,
    });
  } catch (e) {
    handleError(res, e, "Complete visit");
  }
});

// ── POST /visit/:patientId/prescription.pdf — render Rx PDF from client data ──
// Frontend already loads all needed visit data (patient, doctor, dx, meds, labs,
// goals, consultations) via GET /visit/:patientId. To avoid duplicating that
// loader, the client posts the data shape it already has and we render the
// HTML template through Puppeteer.
router.post("/visit/:patientId/prescription.pdf", async (req, res) => {
  try {
    const pdf = await generatePrescriptionPdf(req.body || {});
    const filename = `Rx-${req.params.patientId}-${new Date().toISOString().split("T")[0]}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
    res.setHeader("Content-Length", pdf.length);
    res.end(pdf);
  } catch (e) {
    handleError(res, e, "Generate prescription PDF");
  }
});

export default router;
