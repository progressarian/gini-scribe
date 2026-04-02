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

    const [
      hba1c,
      fpg,
      ldl,
      tg,
      hdl,
      creat,
      egfr,
      uacr,
      tsh,
      ppg,
      alt,
      ast,
      alp,
      nonhdl,
      vitd,
      vitb12,
      ferritin,
      crp,
      bp,
      weight,
      waist,
      bodyFat,
      muscleMass,
      heartRate,
      height,
      bmi,
    ] = await Promise.all([
      pool.query(labQ("HbA1c"), [id, "HbA1c"]),
      pool.query(labQ("FBS"), [id, "FBS"]),
      pool.query(labQ("LDL"), [id, "LDL"]),
      pool.query(labQ("Triglycerides"), [id, "Triglycerides"]),
      pool.query(labQ("HDL"), [id, "HDL"]),
      pool.query(labQ("Creatinine"), [id, "Creatinine"]),
      pool.query(labQ("eGFR"), [id, "eGFR"]),
      pool.query(labQ("UACR"), [id, "UACR"]),
      pool.query(labQ("TSH"), [id, "TSH"]),
      pool.query(labQ("PPBS"), [id, "PPBS"]),
      pool.query(labQ("SGPT (ALT)"), [id, "SGPT (ALT)"]),
      pool.query(labQ("SGOT (AST)"), [id, "SGOT (AST)"]),
      pool.query(labQ("ALP"), [id, "ALP"]),
      pool.query(labQ("Non-HDL"), [id, "Non-HDL"]),
      pool.query(labQ("Vitamin D"), [id, "Vitamin D"]),
      pool.query(labQ("Vitamin B12"), [id, "Vitamin B12"]),
      pool.query(labQ("Ferritin"), [id, "Ferritin"]),
      pool.query(labQ("CRP"), [id, "CRP"]),
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

    const medTimeline = await pool.query(
      `SELECT m.name, m.dose, m.frequency, m.timing, m.is_active, m.is_new, m.started_date,
              COALESCE(c.visit_date, m.created_at::date) AS visit_date,
              m.pharmacy_match, m.source
       FROM medications m LEFT JOIN consultations c ON c.id = m.consultation_id
       WHERE m.patient_id=$1 ORDER BY UPPER(m.name), visit_date`,
      [id],
    );

    const visits = await pool.query(
      `SELECT c.id, c.visit_date, c.visit_type, c.mo_name, c.con_name, c.status,
       c.mo_data->'history' as history, c.mo_data->'complications' as complications,
       c.mo_data->'symptoms' as symptoms, c.mo_data->'compliance' as compliance,
       c.mo_data->'chief_complaints' as chief_complaints,
       c.mo_data->'diagnoses' as diagnoses,
       c.mo_data->'stopped_medications' as stopped_medications,
       c.con_data->'diet_lifestyle' as lifestyle, c.con_data->'self_monitoring' as monitoring,
       c.con_data->'assessment_summary' as summary,
       -- Live medications from table (not stale JSONB snapshot)
       (SELECT json_agg(json_build_object('name', m.name, 'dose', m.dose, 'frequency', m.frequency,
          'timing', m.timing, 'pharmacy_match', m.pharmacy_match, 'is_active', m.is_active))
        FROM medications m WHERE m.consultation_id = c.id) as medications_confirmed,
       c.con_transcript
       FROM consultations c WHERE c.patient_id=$1 ORDER BY c.visit_date DESC`,
      [id],
    );

    res.json({
      hba1c: hba1c.rows,
      fpg: fpg.rows,
      ppg: ppg.rows,
      ldl: ldl.rows,
      triglycerides: tg.rows,
      hdl: hdl.rows,
      nonhdl: nonhdl.rows,
      creatinine: creat.rows,
      egfr: egfr.rows,
      uacr: uacr.rows,
      tsh: tsh.rows,
      alt: alt.rows,
      ast: ast.rows,
      alp: alp.rows,
      vitamin_d: vitd.rows,
      vitamin_b12: vitb12.rows,
      ferritin: ferritin.rows,
      crp: crp.rows,
      bp: bp.rows,
      weight: weight.rows,
      waist: waist.rows,
      body_fat: bodyFat.rows,
      muscle_mass: muscleMass.rows,
      heart_rate: heartRate.rows,
      height: height.rows,
      bmi: bmi.rows,
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
