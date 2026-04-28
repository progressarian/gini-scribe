import { Router } from "express";
import { createRequire } from "module";
import pool from "../config/db.js";
import { handleError } from "../utils/errorHandler.js";
import { n, num, t } from "../utils/helpers.js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY, STORAGE_BUCKET } from "../config/storage.js";
import { sanitizeForStorageKey } from "./documents.js";
import { getCanonical } from "../utils/labCanonical.js";
import { parseClinicalWithAI } from "../services/healthray/parser.js";
import { buildPrescriptionPdf } from "../services/prescriptionPdf.js";
import {
  syncBiomarkersFromLatestLabs,
  syncVitalsFromExtraction,
} from "../services/healthray/db.js";
import { sortDiagnoses } from "../utils/diagnosisSort.js";
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

const require = createRequire(import.meta.url);
const {
  syncPatientLogsFromGenie,
  syncPatientLogsFromGenieThrottled,
  syncDiagnosesToGenie,
  syncMedicationsToGenie,
  deleteGenieMedication,
  updateGenieMedication,
  syncLabsToGenie,
  syncDocumentsToGenie,
  syncAppointmentToGenie,
  syncCareTeamToGenie,
  syncVitalsRowToGenie,
  updateGenieVitalsByGenieId,
} = require("../genie-sync.cjs");

const router = Router();

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
      patientMedsGenieR,
      patientCondsGenieR,
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
           COALESCE(a.appointment_date::date, lr.test_date) AS test_date,
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

      // 22. Genie master medications mirror — medicines the patient has added
      //     in the Genie app (populated by syncPatientLogsFromGenie).
      pool.query(
        `SELECT * FROM patient_medications_genie
         WHERE patient_id=$1
         ORDER BY is_active DESC, synced_at DESC
         LIMIT 200`,
        [pid],
      ),

      // 23. Genie conditions mirror — what the patient is seeing on their app.
      pool.query(
        `SELECT * FROM patient_conditions_genie
         WHERE patient_id=$1
         ORDER BY synced_at DESC
         LIMIT 100`,
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

    // Care phase based on visit count
    let carePhase = "Phase 1 — Initial Assessment";
    if (totalVisits >= 10) carePhase = "Phase 3 — Continuous Care";
    else if (totalVisits >= 4) carePhase = "Phase 2 — Active Management";

    // Load doctor note + compliance from active OPD appointment if present
    let apptDoctorNote = null;
    let opdCompliance = null;
    if (req.query.appointment_id) {
      const opdR = await pool.query(
        `SELECT opd_vitals->>'doctor_note' AS doctor_note, compliance
         FROM appointments WHERE id=$1`,
        [Number(req.query.appointment_id)],
      );
      apptDoctorNote = opdR.rows[0]?.doctor_note || null;
      opdCompliance = opdR.rows[0]?.compliance || null;
    }

    const apptPlan = latestApptR.rows[0] || null;
    // Prefer compliance from today's OPD appointment; fall back to last HealthRay-synced one
    const apptCompliance = opdCompliance || apptPlan?.compliance || {};
    const apptBiomarkers = apptPlan?.biomarkers || {};
    const prep = {
      medPct: apptCompliance.medPct ?? null,
      missed: apptCompliance.missed || null,
      symptoms: apptCompliance.symptoms || [],
    };
    const followUpDate =
      apptPlan?.healthray_follow_up ||
      (apptBiomarkers.followup
        ? { date: apptBiomarkers.followup, notes: null, timing: null }
        : null);

    const healthrayDxAppt = healthrayDxApptR.rows[0] || null;

    // Apply clinical sorting to diagnoses and medications
    const sortedDiagnoses = sortDiagnoses(diagnosesR.rows);
    // Merge patient-added Genie meds (e.g. "Test Med (Track Sync)" added from
    // the app) into the active medications list so the scribe web count
    // matches what the patient sees in the app. Dedupe by normalised name
    // against the doctor-prescribed rows; a doctor entry always wins on
    // collision since it carries fuller metadata (prescriber, consultation
    // link, started_date, etc.).
    const doctorNamesSet = new Set(
      (activeMedsR.rows || []).map((m) =>
        String(m.pharmacy_match || m.name || "")
          .trim()
          .toUpperCase(),
      ),
    );
    const patientOnlyMeds = (patientMedsGenieR.rows || [])
      .filter((m) => m.is_active !== false)
      .filter(
        (m) =>
          !doctorNamesSet.has(
            String(m.name || "")
              .trim()
              .toUpperCase(),
          ),
      )
      .map((m) => {
        // Normalise to YYYY-MM-DD so the frontend's string-equality split of
        // lastVisit vs prevVisit (in VisitMedications.jsx) compares apples
        // to apples. The SQL side returns prescribed_date as a DATE; if we
        // hand back a TIMESTAMPTZ for patient-added rows, every doctor-
        // prescribed med written on the same day fails the latestDate match
        // and gets shoved into the collapsed "Prev Visit" bucket — leaving
        // only the patient-added row visible in the active table.
        // NOTE: pg returns TIMESTAMPTZ columns as JS Date objects. Plain
        // String(date) calls .toString() ("Sat Apr 25 2026 ...") — we need
        // .toISOString() to get the YYYY-MM-DD prefix.
        const ts = m.created_at || m.synced_at || null;
        const toIso = (v) => {
          if (!v) return null;
          if (v instanceof Date) return v.toISOString();
          return String(v);
        };
        const dayOnly = ts ? toIso(ts).slice(0, 10) : null;
        return {
          id: `genie:${m.genie_id || m.id}`,
          name: m.name,
          dose: m.dose,
          frequency: m.frequency,
          timing: m.timing,
          instructions: m.instructions,
          is_active: m.is_active !== false,
          started_date: dayOnly,
          prescribed_date: dayOnly,
          last_prescribed_date: dayOnly,
          prescriber: null,
          source: m.source || "patient_app",
          for_conditions: m.for_conditions || null,
        };
      });
    const combinedActive = [...activeMedsR.rows, ...patientOnlyMeds];
    const sortedActiveMeds = sortMedications(combinedActive);

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
      appt_plan: apptPlan
        ? {
            investigations_to_order: (apptPlan.healthray_investigations || []).map((t) =>
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
        patientMedications: patientMedsGenieR.rows,
        patientConditions: patientCondsGenieR.rows,
      },
      summary: {
        totalVisits,
        firstVisitDate,
        monthsWithGini,
        carePhase,
      },
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

    // Skip if exact same data already exists (same test + value + date)
    if (numResult !== null) {
      const dup = await pool.query(
        `SELECT * FROM lab_results
         WHERE patient_id = $1 AND canonical_name = $2
           AND result::numeric = $3::numeric AND test_date::date = $4::date
         LIMIT 1`,
        [pid, canonical, numResult, finalDate],
      );
      if (dup.rows[0]) return res.json(dup.rows[0]);
    }

    const r = await pool.query(
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
    syncLabsToGenie(pid, pool).catch((e) => console.warn("[Visit] Labs push skipped:", e.message));
    res.json(r.rows[0]);
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
    syncLabsToGenie(pid, pool).catch((e) => console.warn("[Visit] Labs push skipped:", e.message));
    res.json(r.rows[0]);
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
    } = req.body;
    if (!name) return res.status(400).json({ error: "name is required" });
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

    const r = await pool.query(
      `INSERT INTO medications (patient_id, name, pharmacy_match, composition, dose, frequency, timing, route, for_diagnosis, is_active, started_date, appointment_id, source, med_group, drug_class, external_doctor, clinical_note, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,COALESCE($10::date, CURRENT_DATE),$11,'visit',$12,$13,$14,$15,$16)
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
      ],
    );
    syncMedicationsToGenie(pid, pool).catch((e) =>
      console.warn("[Visit] Medications push skipped:", e.message),
    );
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

  // Genie-sourced (patient-added) meds — update mirror + Genie Supabase so
  // the change reflects in the app.
  if (rawId.startsWith("genie:")) {
    const genieMedId = rawId.slice("genie:".length);
    if (!genieMedId) return res.status(400).json({ error: "Invalid IDs" });
    try {
      const { dose, frequency, timing } = req.body;
      const fields = {};
      if (dose !== undefined) fields.dose = t(dose, 100);
      if (frequency !== undefined) fields.frequency = t(frequency, 100);
      if (timing !== undefined) fields.timing = t(timing, 200);
      const result = await updateGenieMedication(pid, genieMedId, fields, pool);
      if (!result.updated) {
        return res.status(500).json({ error: result.reason || "Update failed" });
      }
      return res.json({ success: true, source: "genie" });
    } catch (e) {
      return handleError(res, e, "Edit Genie medication");
    }
  }

  const mid = Number(rawId);
  if (!mid) return res.status(400).json({ error: "Invalid IDs" });
  try {
    const { dose, frequency, timing, reason } = req.body;

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

    const r = await pool.query(
      `UPDATE medications SET
         dose = $1, frequency = $2, timing = $3,
         notes = COALESCE($4, notes),
         history = CASE WHEN $5::jsonb IS NULL THEN COALESCE(history, '[]'::jsonb)
                        ELSE COALESCE(history, '[]'::jsonb) || $5::jsonb END,
         updated_at = NOW()
       WHERE id = $6 AND patient_id = $7 AND is_active = true RETURNING *`,
      [nextDose, nextFreq, nextTiming, t(reason, 500), historyEntry, mid, pid],
    );
    if (!r.rows[0]) return res.status(404).json({ error: "Medication not found" });
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

  // Genie-sourced meds — flag as inactive in Genie + mirror so the app stops
  // showing the med as active.
  if (rawId.startsWith("genie:")) {
    const genieMedId = rawId.slice("genie:".length);
    if (!genieMedId) return res.status(400).json({ error: "Invalid IDs" });
    try {
      const result = await updateGenieMedication(
        pid,
        genieMedId,
        { is_active: false },
        pool,
      );
      if (!result.updated) {
        return res.status(500).json({ error: result.reason || "Stop failed" });
      }
      return res.json({ success: true, source: "genie" });
    } catch (e) {
      return handleError(res, e, "Stop Genie medication");
    }
  }

  const mid = Number(rawId);
  if (!mid) return res.status(400).json({ error: "Invalid IDs" });
  try {
    const { reason, notes } = req.body;
    if (!reason) return res.status(400).json({ error: "reason is required" });

    // Get the medication name before stopping (needed to clear duplicate inactive rows)
    const med = await pool.query(
      "SELECT pharmacy_match, name FROM medications WHERE id = $1 AND patient_id = $2",
      [mid, pid],
    );
    if (!med.rows[0]) return res.status(404).json({ error: "Medication not found" });

    // Remove any existing inactive duplicates with the same pharmacy_match/name
    // so the inactive partial unique index doesn't reject our UPDATE
    const matchKey = med.rows[0].pharmacy_match || med.rows[0].name;
    await pool.query(
      `DELETE FROM medications
       WHERE patient_id = $1 AND id != $2 AND is_active = false
         AND UPPER(COALESCE(pharmacy_match, name)) = UPPER($3)`,
      [pid, mid, matchKey],
    );

    const r = await pool.query(
      `UPDATE medications SET is_active = false, stopped_date = CURRENT_DATE,
         stop_reason = $1, notes = COALESCE($2, notes), updated_at = NOW()
       WHERE id = $3 AND patient_id = $4 AND is_active = true RETURNING *`,
      [t(reason, 200), t(notes, 500), mid, pid],
    );
    if (!r.rows[0])
      return res.status(404).json({ error: "Medication not found or already stopped" });
    syncMedicationsToGenie(pid, pool).catch((e) =>
      console.warn("[Visit] Medications push skipped:", e.message),
    );
    res.json(r.rows[0]);
  } catch (e) {
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
  try {
    const med = await pool.query(
      "SELECT pharmacy_match, name, is_active FROM medications WHERE id = $1 AND patient_id = $2",
      [mid, pid],
    );
    if (!med.rows[0]) return res.status(404).json({ error: "Medication not found" });
    if (med.rows[0].is_active) return res.json({ ok: true, alreadyActive: true });

    const matchKey = med.rows[0].pharmacy_match || med.rows[0].name;
    const dup = await pool.query(
      `SELECT id, name FROM medications
        WHERE patient_id = $1 AND id != $2 AND is_active = true
          AND UPPER(COALESCE(pharmacy_match, name)) = UPPER($3)
        LIMIT 1`,
      [pid, mid, matchKey],
    );
    if (dup.rows[0]) {
      return res.status(409).json({
        error: "An active medication with this name already exists",
        existingId: dup.rows[0].id,
        existingName: dup.rows[0].name,
      });
    }

    // Restart is clinically a re-prescription — reset started_date to today
    // AND clear consultation_id so the visit query's prescribed_date
    // (COALESCE(c.visit_date, m.started_date)) falls back to the fresh
    // started_date instead of the original consultation's old visit_date.
    // Without this, the row keeps lining up with the old visit and the
    // frontend grouping puts it under "Prev Visit".
    const r = await pool.query(
      `UPDATE medications
          SET is_active = true,
              stopped_date = NULL,
              stop_reason = NULL,
              started_date = CURRENT_DATE,
              consultation_id = NULL,
              updated_at = NOW()
        WHERE id = $1 AND patient_id = $2 AND is_active = false
        RETURNING *`,
      [mid, pid],
    );
    if (!r.rows[0])
      return res.status(404).json({ error: "Medication not found or already active" });

    syncMedicationsToGenie(pid, pool).catch((e) =>
      console.warn("[Visit] Medications push skipped:", e.message),
    );
    res.json(r.rows[0]);
  } catch (e) {
    handleError(res, e, "Restart medication");
  }
});

// ── DELETE /visit/:patientId/medication/:id — Delete medication permanently ──
router.delete("/visit/:patientId/medication/:id", async (req, res) => {
  const pid = Number(req.params.patientId);
  const rawId = String(req.params.id || "");
  if (!pid) return res.status(400).json({ error: "Invalid IDs" });

  // Genie-sourced meds use `genie:<uuid>` ids (the Supabase medications.id).
  // They aren't in the local `medications` table, so number coercion fails —
  // delete from the mirror + Genie Supabase instead.
  if (rawId.startsWith("genie:")) {
    const genieMedId = rawId.slice("genie:".length);
    if (!genieMedId) return res.status(400).json({ error: "Invalid IDs" });
    try {
      const result = await deleteGenieMedication(pid, genieMedId, pool);
      if (!result.deleted) {
        return res.status(500).json({ error: result.reason || "Delete failed" });
      }
      return res.json({ success: true, deleted: 1, source: "genie" });
    } catch (e) {
      return handleError(res, e, "Delete Genie medication");
    }
  }

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

export default router;
