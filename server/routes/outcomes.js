import { Router } from "express";
import pool from "../config/db.js";
import { handleError } from "../utils/errorHandler.js";

const router = Router();

router.get("/patients/:id/outcomes", async (req, res) => {
  try {
    const id = req.params.id;
    const { period } = req.query;
    let df = "",
      vf = "";
    if (period === "3m") {
      df = "AND test_date > NOW() - INTERVAL '3 months'";
      vf = "AND recorded_at > NOW() - INTERVAL '3 months'";
    } else if (period === "6m") {
      df = "AND test_date > NOW() - INTERVAL '6 months'";
      vf = "AND recorded_at > NOW() - INTERVAL '6 months'";
    } else if (period === "1y") {
      df = "AND test_date > NOW() - INTERVAL '1 year'";
      vf = "AND recorded_at > NOW() - INTERVAL '1 year'";
    }

    // Use canonical_name for reliable matching; fall back to test_name for un-normalized rows
    const labQ = (canonical) =>
      `SELECT result, test_date, test_name FROM lab_results
       WHERE patient_id=$1 AND (canonical_name=$2 OR test_name=$2) ${df}
       ORDER BY test_date, created_at DESC`;

    const vitalQ = (col) =>
      `SELECT DISTINCT ON (recorded_at::date) ${col}, recorded_at::date as date
       FROM vitals WHERE patient_id=$1 AND ${col} IS NOT NULL ${vf}
       ORDER BY recorded_at::date, recorded_at DESC`;

    // Biomarkers fetched in canonical lab order (see src/config/labOrder.js +
    // labOrder.md): Diabetes → Renal → Lipids → Liver → Thyroid → Cardiac/Inflam
    // → Vitamins → Vitals/Body Composition. The destructure order, queries and
    // JSON response below all follow this same sequence.
    const [
      // 1. Diabetes & Glycaemic Control
      hba1c,
      fpg,
      ppg,
      // 2. Renal Function
      creat,
      egfr,
      uacr,
      // 3. Lipid Profile
      ldl,
      hdl,
      tg,
      nonhdl,
      // 4. Liver Function
      alt,
      ast,
      alp,
      // 5. Thyroid
      tsh,
      // 6. Cardiac / Inflammation
      crp,
      // 7. Vitamins & Minerals
      vitd,
      vitb12,
      ferritin,
      // 8. Vitals / Body Composition
      bp,
      weight,
      waist,
      bodyFat,
      muscleMass,
      heartRate,
      height,
      bmi,
    ] = await Promise.all([
      // Diabetes
      pool.query(labQ("HbA1c"), [id, "HbA1c"]),
      pool.query(labQ("FBS"), [id, "FBS"]),
      pool.query(labQ("PPBS"), [id, "PPBS"]),
      // Renal
      pool.query(labQ("Creatinine"), [id, "Creatinine"]),
      pool.query(labQ("eGFR"), [id, "eGFR"]),
      pool.query(labQ("UACR"), [id, "UACR"]),
      // Lipids
      pool.query(labQ("LDL"), [id, "LDL"]),
      pool.query(labQ("HDL"), [id, "HDL"]),
      pool.query(labQ("Triglycerides"), [id, "Triglycerides"]),
      pool.query(labQ("Non-HDL"), [id, "Non-HDL"]),
      // Liver
      pool.query(labQ("SGPT (ALT)"), [id, "SGPT (ALT)"]),
      pool.query(labQ("SGOT (AST)"), [id, "SGOT (AST)"]),
      pool.query(labQ("ALP"), [id, "ALP"]),
      // Thyroid
      pool.query(labQ("TSH"), [id, "TSH"]),
      // Cardiac / Inflammation
      pool.query(labQ("CRP"), [id, "CRP"]),
      // Vitamins
      pool.query(labQ("Vitamin D"), [id, "Vitamin D"]),
      pool.query(labQ("Vitamin B12"), [id, "Vitamin B12"]),
      pool.query(labQ("Ferritin"), [id, "Ferritin"]),
      // Vitals / Body Composition
      pool.query(
        `SELECT DISTINCT ON (recorded_at::date) bp_sys, bp_dia, recorded_at::date as date FROM vitals WHERE patient_id=$1 AND bp_sys IS NOT NULL ${vf} ORDER BY recorded_at::date, recorded_at DESC`,
        [id],
      ),
      pool.query(vitalQ("weight"), [id]),
      pool.query(vitalQ("waist"), [id]),
      pool.query(vitalQ("body_fat"), [id]),
      pool.query(vitalQ("muscle_mass"), [id]),
      pool.query(vitalQ("pulse"), [id]),
      pool.query(vitalQ("height"), [id]),
      pool.query(vitalQ("bmi"), [id]),
    ]);

    const screenings = await pool.query(
      `SELECT DISTINCT ON (COALESCE(canonical_name, test_name))
         COALESCE(canonical_name, test_name) as test_name, result, unit, test_date, flag
       FROM lab_results WHERE patient_id=$1
         AND COALESCE(canonical_name, test_name) IN ('VPT','ABI','Retinopathy','ECG','Doppler','DEXA','Ultrasound','X-Ray','MRI')
       ORDER BY COALESCE(canonical_name, test_name), test_date DESC`,
      [id],
    );

    const diagJourney = await pool.query(
      `SELECT d.diagnosis_id, d.label, d.status,
              COALESCE(c.visit_date, d.created_at::date) AS visit_date,
              c.con_name, c.mo_name
       FROM diagnoses d LEFT JOIN consultations c ON c.id = d.consultation_id
       WHERE d.patient_id=$1 ORDER BY d.diagnosis_id, visit_date`,
      [id],
    );

    // For HealthRay-synced meds (consultation_id IS NULL) prefer started_date over created_at
    // so the timeline lines up with the actual prescription/appointment date, not sync time.
    const medTimeline = await pool.query(
      `SELECT m.name, m.dose, m.frequency, m.timing, m.when_to_take, m.is_active, m.is_new, m.started_date,
              COALESCE(c.visit_date, m.started_date, m.created_at::date) AS visit_date,
              m.pharmacy_match, m.source
       FROM medications m LEFT JOIN consultations c ON c.id = m.consultation_id
       WHERE m.patient_id=$1 ORDER BY UPPER(m.name), visit_date`,
      [id],
    );

    // Merge consultations + HealthRay-synced appointments, matching /api/visit/:patientId
    // and /api/patients/:id so Outcomes stays in sync with the Visit page.
    const visits = await pool.query(
      `WITH cons AS (
         SELECT c.id, c.visit_date, c.visit_type, c.mo_name, c.con_name, c.status, c.created_at,
                c.mo_data->'history'           AS history,
                c.mo_data->'complications'     AS complications,
                c.mo_data->'symptoms'          AS symptoms,
                c.mo_data->'compliance'        AS compliance,
                c.mo_data->'chief_complaints'  AS chief_complaints,
                c.mo_data->'diagnoses'         AS diagnoses,
                c.mo_data->'stopped_medications' AS stopped_medications,
                c.con_data->'diet_lifestyle'   AS lifestyle,
                c.con_data->'self_monitoring'  AS monitoring,
                c.con_data->'assessment_summary' AS summary,
                (SELECT json_agg(json_build_object('name', m.name, 'dose', m.dose, 'frequency', m.frequency,
                   'timing', m.timing, 'when_to_take', m.when_to_take, 'pharmacy_match', m.pharmacy_match, 'is_active', m.is_active))
                 FROM medications m WHERE m.consultation_id = c.id)::jsonb AS medications_confirmed,
                c.con_transcript
         FROM consultations c WHERE c.patient_id=$1
       ),
       appts AS (
         SELECT a.id,
                a.appointment_date               AS visit_date,
                a.visit_type,
                NULL::text                       AS mo_name,
                a.doctor_name                    AS con_name,
                a.status,
                a.created_at,
                NULL::jsonb                      AS history,
                NULL::jsonb                      AS complications,
                NULL::jsonb                      AS symptoms,
                COALESCE(a.compliance, '{}'::jsonb) AS compliance,
                NULL::jsonb                      AS chief_complaints,
                a.healthray_diagnoses            AS diagnoses,
                NULL::jsonb                      AS stopped_medications,
                NULL::jsonb                      AS lifestyle,
                NULL::jsonb                      AS monitoring,
                NULL::jsonb                      AS summary,
                a.healthray_medications          AS medications_confirmed,
                a.healthray_clinical_notes       AS con_transcript
         FROM appointments a
         WHERE a.patient_id=$1
           AND a.healthray_id IS NOT NULL
           AND a.appointment_date IS NOT NULL
       ),
       deduped AS (
         SELECT * FROM cons
         UNION ALL
         SELECT a.* FROM appts a
         WHERE NOT EXISTS (
           SELECT 1 FROM cons c WHERE c.visit_date::date = a.visit_date::date
         )
       )
       SELECT * FROM deduped ORDER BY visit_date DESC, created_at DESC`,
      [id],
    );

    // JSON keys grouped per canonical lab order so consumers iterating over
    // the response (debug tools, exports) see a clinically coherent sequence.
    res.json({
      // 1. Diabetes & Glycaemic Control
      hba1c: hba1c.rows,
      fpg: fpg.rows,
      ppg: ppg.rows,
      // 2. Renal Function
      creatinine: creat.rows,
      egfr: egfr.rows,
      uacr: uacr.rows,
      // 3. Lipid Profile
      ldl: ldl.rows,
      hdl: hdl.rows,
      triglycerides: tg.rows,
      nonhdl: nonhdl.rows,
      // 4. Liver Function
      alt: alt.rows,
      ast: ast.rows,
      alp: alp.rows,
      // 5. Thyroid
      tsh: tsh.rows,
      // 6. Cardiac / Inflammation
      crp: crp.rows,
      // 7. Vitamins & Minerals
      vitamin_d: vitd.rows,
      vitamin_b12: vitb12.rows,
      ferritin: ferritin.rows,
      // 8. Vitals / Body Composition
      bp: bp.rows,
      weight: weight.rows,
      waist: waist.rows,
      body_fat: bodyFat.rows,
      muscle_mass: muscleMass.rows,
      heart_rate: heartRate.rows,
      height: height.rows,
      bmi: bmi.rows,
      // 9. Other
      screenings: screenings.rows,
      diagnosis_journey: diagJourney.rows,
      med_timeline: medTimeline.rows,
      visits: visits.rows,
    });
  } catch (e) {
    handleError(res, e, "Outcomes");
  }
});

export default router;
