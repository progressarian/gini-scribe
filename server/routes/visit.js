import { Router } from "express";
import pool from "../config/db.js";
import { handleError } from "../utils/errorHandler.js";
import { n, num, t } from "../utils/helpers.js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY, STORAGE_BUCKET } from "../config/storage.js";
import { getCanonical } from "../utils/labCanonical.js";
import { parseClinicalWithAI } from "../services/healthray/parser.js";

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

// GET /api/visit/:patientId — comprehensive visit-page data
router.get("/visit/:patientId", async (req, res) => {
  const pid = Number(req.params.patientId);
  if (!pid) return res.status(400).json({ error: "Invalid patient ID" });

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
    ] = await Promise.all([
      // 1. Patient
      pool.query("SELECT * FROM patients WHERE id=$1", [pid]),

      // 2. All vitals (for history/trends)
      pool.query("SELECT * FROM vitals WHERE patient_id=$1 ORDER BY recorded_at DESC", [pid]),

      // 3. Diagnoses (deduplicated — one per diagnosis_id, active rows preferred, then latest)
      pool.query(
        `SELECT DISTINCT ON (diagnosis_id) * FROM diagnoses
         WHERE patient_id=$1
         ORDER BY diagnosis_id, is_active DESC, updated_at DESC`,
        [pid],
      ),

      // 4. Active medications (use m.started_date for documents, c.visit_date for consultations)
      pool.query(
        `WITH latest_cons AS (
           SELECT DISTINCT ON (COALESCE(con_name, mo_name, 'unknown')) id
           FROM consultations WHERE patient_id=$1
           ORDER BY COALESCE(con_name, mo_name, 'unknown'), visit_date DESC, created_at DESC
         )
         SELECT m.*, c.con_name AS prescriber, COALESCE(c.visit_date, m.started_date) AS prescribed_date
         FROM medications m LEFT JOIN consultations c ON c.id = m.consultation_id
         WHERE m.patient_id=$1 AND m.is_active = true
           AND (m.consultation_id IN (SELECT id FROM latest_cons) OR m.consultation_id IS NULL)
         ORDER BY COALESCE(c.visit_date, m.started_date) DESC, m.created_at DESC`,
        [pid],
      ),

      // 5. Stopped medications (deduplicated — one per drug name, latest wins)
      pool.query(
        `SELECT DISTINCT ON (UPPER(COALESCE(m.pharmacy_match, m.name)))
           m.*, c.con_name AS prescriber, COALESCE(c.visit_date, m.started_date) AS prescribed_date
         FROM medications m LEFT JOIN consultations c ON c.id = m.consultation_id
         WHERE m.patient_id=$1 AND m.is_active = false
         ORDER BY UPPER(COALESCE(m.pharmacy_match, m.name)), m.stopped_date DESC NULLS LAST`,
        [pid],
      ),

      // 6. All lab results (deduped: one per test per date, best source wins)
      pool.query(
        `SELECT * FROM (
           SELECT DISTINCT ON (COALESCE(canonical_name, test_name), test_date::date)
             *
           FROM lab_results
           WHERE patient_id = $1
           ORDER BY
             COALESCE(canonical_name, test_name),
             test_date::date,
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
         ) deduped
         ORDER BY test_date DESC, created_at DESC`,
        [pid],
      ),

      // 7. Consultations
      pool.query(
        `SELECT id, visit_date, visit_type, mo_name, con_name, status, created_at, con_data, exam_data
         FROM consultations WHERE patient_id=$1
         ORDER BY visit_date DESC, created_at DESC`,
        [pid],
      ),

      // 8. Documents
      pool.query(
        `SELECT id, doc_type, title, file_name, doc_date, source, notes, extracted_data, storage_path, file_url, reviewed, created_at
         FROM documents WHERE patient_id=$1 ORDER BY doc_date DESC NULLS LAST`,
        [pid],
      ),

      // 9. Goals
      pool.query("SELECT * FROM goals WHERE patient_id=$1 ORDER BY status, created_at DESC", [pid]),

      // 10. Genie vitals log (last 60 days)
      pool.query(
        `SELECT * FROM patient_vitals_log
         WHERE patient_id=$1 AND recorded_date >= NOW() - INTERVAL '60 days'
         ORDER BY recorded_date DESC`,
        [pid],
      ),

      // 11. Genie activity log (last 30 days)
      pool.query(
        `SELECT * FROM patient_activity_log
         WHERE patient_id=$1 AND log_date >= NOW() - INTERVAL '30 days'
         ORDER BY log_date DESC`,
        [pid],
      ),

      // 12. Genie symptom log (last 60 days)
      pool.query(
        `SELECT * FROM patient_symptom_log
         WHERE patient_id=$1 AND log_date >= NOW() - INTERVAL '60 days'
         ORDER BY log_date DESC`,
        [pid],
      ),

      // 13. Genie med log (last 30 days)
      pool.query(
        `SELECT * FROM patient_med_log
         WHERE patient_id=$1 AND log_date >= NOW() - INTERVAL '30 days'
         ORDER BY log_date DESC`,
        [pid],
      ),

      // 14. Genie meal log (last 30 days)
      pool.query(
        `SELECT * FROM patient_meal_log
         WHERE patient_id=$1 AND log_date >= NOW() - INTERVAL '30 days'
         ORDER BY log_date DESC`,
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
    for (const r of labsR.rows) {
      const key = r.canonical_name || r.test_name;
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
      if (!labLatest[key]) {
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
        };
      }
    }

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

    res.json({
      patient,
      vitals: vitalsR.rows,
      diagnoses: diagnosesR.rows,
      healthrayDiagnoses: healthrayDxAppt?.healthray_diagnoses || null,
      activeMeds: activeMedsR.rows,
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
      },
      summary: {
        totalVisits,
        firstVisitDate,
        monthsWithGini,
        carePhase,
      },
    });
  } catch (err) {
    handleError(res, err, "Failed to load visit data");
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
    const r = await pool.query(
      `INSERT INTO lab_results (patient_id, test_name, canonical_name, result, unit, test_date, source, appointment_id)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6::date, CURRENT_DATE),'manual',$7) RETURNING *`,
      [
        pid,
        t(test_name, 200),
        canonical,
        num(result),
        t(unit, 50),
        n(test_date),
        appointment_id || null,
      ],
    );
    res.json(r.rows[0]);
  } catch (e) {
    handleError(res, e, "Add lab value");
  }
});

// ── POST /visit/:patientId/diagnosis — Add / upsert diagnosis ──
router.post("/visit/:patientId/diagnosis", async (req, res) => {
  const pid = Number(req.params.patientId);
  if (!pid) return res.status(400).json({ error: "Invalid patient ID" });
  try {
    const { name, icd_code, status, notes } = req.body;
    if (!name) return res.status(400).json({ error: "name is required" });
    const diagId = (icd_code || name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .slice(0, 100);
    const r = await pool.query(
      `INSERT INTO diagnoses (patient_id, diagnosis_id, label, status, notes)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (patient_id, diagnosis_id) DO UPDATE SET
         label = EXCLUDED.label, status = COALESCE(EXCLUDED.status, diagnoses.status),
         notes = COALESCE(EXCLUDED.notes, diagnoses.notes), updated_at = NOW()
       RETURNING *`,
      [pid, diagId, t(name, 500), t(status, 100) || "New", t(notes, 1000)],
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
    } = req.body;
    if (!name) return res.status(400).json({ error: "name is required" });
    const forDx = Array.isArray(for_diagnosis)
      ? for_diagnosis
      : for_diagnosis
        ? [for_diagnosis]
        : null;
    const r = await pool.query(
      `INSERT INTO medications (patient_id, name, composition, dose, frequency, timing, route, for_diagnosis, is_active, started_date, appointment_id, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,COALESCE($9::date, CURRENT_DATE),$10,'visit')
       ON CONFLICT (patient_id, UPPER(COALESCE(pharmacy_match, name))) WHERE is_active = true
       DO UPDATE SET
         composition = COALESCE(EXCLUDED.composition, medications.composition),
         dose = COALESCE(EXCLUDED.dose, medications.dose),
         frequency = COALESCE(EXCLUDED.frequency, medications.frequency),
         timing = COALESCE(EXCLUDED.timing, medications.timing),
         route = COALESCE(EXCLUDED.route, medications.route),
         for_diagnosis = COALESCE(EXCLUDED.for_diagnosis, medications.for_diagnosis),
         appointment_id = COALESCE(EXCLUDED.appointment_id, medications.appointment_id),
         updated_at = NOW()
       RETURNING *`,
      [
        pid,
        t(name, 200),
        t(composition, 200),
        t(dose, 100),
        t(frequency, 100),
        t(timing, 200),
        t(route, 50) || "Oral",
        forDx,
        n(started_date),
        appointment_id || null,
      ],
    );
    res.json(r.rows[0]);
  } catch (e) {
    handleError(res, e, "Add medication");
  }
});

// ── PATCH /visit/:patientId/medication/:id — Edit medication ──
router.patch("/visit/:patientId/medication/:id", async (req, res) => {
  const pid = Number(req.params.patientId);
  const mid = Number(req.params.id);
  if (!pid || !mid) return res.status(400).json({ error: "Invalid IDs" });
  try {
    const { dose, frequency, timing, reason } = req.body;
    const r = await pool.query(
      `UPDATE medications SET
         dose = COALESCE($1, dose), frequency = COALESCE($2, frequency),
         timing = COALESCE($3, timing), notes = COALESCE($4, notes), updated_at = NOW()
       WHERE id = $5 AND patient_id = $6 AND is_active = true RETURNING *`,
      [t(dose, 100), t(frequency, 100), t(timing, 200), t(reason, 500), mid, pid],
    );
    if (!r.rows[0]) return res.status(404).json({ error: "Medication not found" });
    res.json(r.rows[0]);
  } catch (e) {
    handleError(res, e, "Edit medication");
  }
});

// ── PATCH /visit/:patientId/medication/:id/stop — Stop medication ──
router.patch("/visit/:patientId/medication/:id/stop", async (req, res) => {
  const pid = Number(req.params.patientId);
  const mid = Number(req.params.id);
  if (!pid || !mid) return res.status(400).json({ error: "Invalid IDs" });
  try {
    const { reason, notes } = req.body;
    if (!reason) return res.status(400).json({ error: "reason is required" });
    const r = await pool.query(
      `UPDATE medications SET is_active = false, stopped_date = CURRENT_DATE,
         stop_reason = $1, notes = COALESCE($2, notes), updated_at = NOW()
       WHERE id = $3 AND patient_id = $4 AND is_active = true RETURNING *`,
      [t(reason, 200), t(notes, 500), mid, pid],
    );
    if (!r.rows[0])
      return res.status(404).json({ error: "Medication not found or already stopped" });
    res.json(r.rows[0]);
  } catch (e) {
    handleError(res, e, "Stop medication");
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
    // Upload file to Supabase if provided
    if (base64 && fileName && SUPABASE_URL && SUPABASE_SERVICE_KEY) {
      const mediaType = fileName.match(/\.pdf$/i)
        ? "application/pdf"
        : fileName.match(/\.png$/i)
          ? "image/png"
          : fileName.match(/\.jpe?g$/i)
            ? "image/jpeg"
            : "application/octet-stream";
      const storagePath = `patients/${pid}/${doc_type}/${Date.now()}_${fileName}`;
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
        await pool.query("UPDATE documents SET storage_path=$1, mime_type=$2 WHERE id=$3", [
          storagePath,
          mediaType,
          doc.id,
        ]);
        doc.storage_path = storagePath;
      }
    }
    res.json(doc);
  } catch (e) {
    handleError(res, e, "Upload document");
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
           -- Case 2: Document/uploaded prescription medicines from past dates only
           -- Excludes HealthRay medicines (source = 'healthray') — those stay active
           -- until the doctor explicitly stops them or HealthRay sync marks them stopped
           OR (consultation_id IS NULL
               AND COALESCE(source, '') != 'healthray'
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

// ── POST /visit/:patientId/vitals — Create new vitals record for today ──
router.post("/visit/:patientId/vitals", async (req, res) => {
  const pid = Number(req.params.patientId);
  if (!pid) return res.status(400).json({ error: "Invalid patient ID" });
  try {
    const { bp_sys, bp_dia, pulse, temp, spo2, weight, height, bmi, body_fat, muscle_mass, waist } =
      req.body;
    const { rows } = await pool.query(
      `INSERT INTO vitals (patient_id, bp_sys, bp_dia, pulse, temp, spo2, weight, height, bmi, body_fat, muscle_mass, waist)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [
        pid,
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
      ],
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
    ];
    const keys = allowed.filter((f) => req.body[f] !== undefined);
    if (!keys.length) return res.json({ ok: true });
    const sets = keys.map((f, i) => `${f} = $${i + 1}`).join(", ");
    const vals = keys.map((f) => num(req.body[f]));
    await pool.query(
      `UPDATE vitals SET ${sets} WHERE id = $${vals.length + 1} AND patient_id = $${vals.length + 2}`,
      [...vals, vid, pid],
    );
    res.json({ ok: true });
  } catch (e) {
    handleError(res, e, "Update vitals");
  }
});

export default router;
