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

    const labQ = (names) =>
      `SELECT result, test_date, test_name FROM lab_results WHERE patient_id=$1 AND LOWER(test_name) IN (${names.map((_, i) => `LOWER($${i + 2})`).join(",")}) ${df} ORDER BY test_date, created_at DESC`;

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
      pool.query(
        labQ(["HbA1c", "Glycated Hemoglobin", "Glycated Haemoglobin", "A1c", "Hemoglobin A1c"]),
        [id, "HbA1c", "Glycated Hemoglobin", "Glycated Haemoglobin", "A1c", "Hemoglobin A1c"],
      ),
      pool.query(
        labQ([
          "FBS",
          "FPG",
          "Fasting Glucose",
          "Fasting Blood Sugar",
          "Fasting Plasma Glucose",
          "FBG",
          "Blood Sugar Fasting",
        ]),
        [
          id,
          "FBS",
          "FPG",
          "Fasting Glucose",
          "Fasting Blood Sugar",
          "Fasting Plasma Glucose",
          "FBG",
          "Blood Sugar Fasting",
        ],
      ),
      pool.query(labQ(["LDL", "LDL Cholesterol", "LDL-C", "LDL Cholesterol (Direct)"]), [
        id,
        "LDL",
        "LDL Cholesterol",
        "LDL-C",
        "LDL Cholesterol (Direct)",
      ]),
      pool.query(labQ(["Triglycerides", "TG", "Triglyceride", "Serum Triglycerides"]), [
        id,
        "Triglycerides",
        "TG",
        "Triglyceride",
        "Serum Triglycerides",
      ]),
      pool.query(labQ(["HDL", "HDL Cholesterol", "HDL-C", "HDL Cholesterol (Direct)"]), [
        id,
        "HDL",
        "HDL Cholesterol",
        "HDL-C",
        "HDL Cholesterol (Direct)",
      ]),
      pool.query(labQ(["Creatinine", "Serum Creatinine", "S. Creatinine"]), [
        id,
        "Creatinine",
        "Serum Creatinine",
        "S. Creatinine",
      ]),
      pool.query(labQ(["eGFR", "GFR", "Estimated GFR"]), [id, "eGFR", "GFR", "Estimated GFR"]),
      pool.query(
        labQ(["UACR", "Urine Albumin Creatinine Ratio", "Microalbumin", "Urine Microalbumin"]),
        [id, "UACR", "Urine Albumin Creatinine Ratio", "Microalbumin", "Urine Microalbumin"],
      ),
      pool.query(labQ(["TSH", "Thyroid Stimulating Hormone", "TSH Ultrasensitive"]), [
        id,
        "TSH",
        "Thyroid Stimulating Hormone",
        "TSH Ultrasensitive",
      ]),
      pool.query(
        labQ([
          "PPBS",
          "PP",
          "PPG",
          "PP Glucose",
          "Post Prandial",
          "Post Prandial Glucose",
          "Post Prandial Blood Sugar",
        ]),
        [
          id,
          "PPBS",
          "PP",
          "PPG",
          "PP Glucose",
          "Post Prandial",
          "Post Prandial Glucose",
          "Post Prandial Blood Sugar",
        ],
      ),
      pool.query(labQ(["SGPT (ALT)", "SGPT", "ALT", "Alanine Aminotransferase"]), [
        id,
        "SGPT (ALT)",
        "SGPT",
        "ALT",
        "Alanine Aminotransferase",
      ]),
      pool.query(labQ(["SGOT (AST)", "SGOT", "AST", "Aspartate Aminotransferase"]), [
        id,
        "SGOT (AST)",
        "SGOT",
        "AST",
        "Aspartate Aminotransferase",
      ]),
      pool.query(labQ(["ALP", "Alkaline Phosphatase"]), [id, "ALP", "Alkaline Phosphatase"]),
      pool.query(labQ(["Non-HDL", "Non HDL", "NonHDL", "Non-HDL Cholesterol"]), [
        id,
        "Non-HDL",
        "Non HDL",
        "NonHDL",
        "Non-HDL Cholesterol",
      ]),
      pool.query(
        labQ([
          "Vitamin D",
          "25-OH Vitamin D",
          "Vit D",
          "Vitamin D3",
          "25(OH) Vitamin D",
          "25 Hydroxy Vitamin D",
        ]),
        [
          id,
          "Vitamin D",
          "25-OH Vitamin D",
          "Vit D",
          "Vitamin D3",
          "25(OH) Vitamin D",
          "25 Hydroxy Vitamin D",
        ],
      ),
      pool.query(labQ(["Vitamin B12", "Vit B12", "B12", "Cyanocobalamin"]), [
        id,
        "Vitamin B12",
        "Vit B12",
        "B12",
        "Cyanocobalamin",
      ]),
      pool.query(labQ(["Ferritin", "Serum Ferritin"]), [id, "Ferritin", "Serum Ferritin"]),
      pool.query(labQ(["CRP", "C-Reactive Protein", "hs-CRP"]), [
        id,
        "CRP",
        "C-Reactive Protein",
        "hs-CRP",
      ]),
      pool.query(
        `SELECT DISTINCT ON (recorded_at::date) bp_sys, bp_dia, recorded_at::date as date FROM vitals WHERE patient_id=$1 AND bp_sys IS NOT NULL ${vf} ORDER BY recorded_at::date, recorded_at DESC`,
        [id],
      ),
      pool.query(
        `SELECT DISTINCT ON (recorded_at::date) weight, recorded_at::date as date FROM vitals WHERE patient_id=$1 AND weight IS NOT NULL ${vf} ORDER BY recorded_at::date, recorded_at DESC`,
        [id],
      ),
      pool.query(
        `SELECT DISTINCT ON (recorded_at::date) waist, recorded_at::date as date FROM vitals WHERE patient_id=$1 AND waist IS NOT NULL ${vf} ORDER BY recorded_at::date, recorded_at DESC`,
        [id],
      ),
      pool.query(
        `SELECT DISTINCT ON (recorded_at::date) body_fat, recorded_at::date as date FROM vitals WHERE patient_id=$1 AND body_fat IS NOT NULL ${vf} ORDER BY recorded_at::date, recorded_at DESC`,
        [id],
      ),
      pool.query(
        `SELECT DISTINCT ON (recorded_at::date) muscle_mass, recorded_at::date as date FROM vitals WHERE patient_id=$1 AND muscle_mass IS NOT NULL ${vf} ORDER BY recorded_at::date, recorded_at DESC`,
        [id],
      ),
      pool.query(
        `SELECT DISTINCT ON (recorded_at::date) pulse, recorded_at::date as date FROM vitals WHERE patient_id=$1 AND pulse IS NOT NULL ${vf} ORDER BY recorded_at::date, recorded_at DESC`,
        [id],
      ),
      pool.query(
        `SELECT DISTINCT ON (recorded_at::date) height, recorded_at::date as date FROM vitals WHERE patient_id=$1 AND height IS NOT NULL ${vf} ORDER BY recorded_at::date, recorded_at DESC`,
        [id],
      ),
      pool.query(
        `SELECT DISTINCT ON (recorded_at::date) bmi, recorded_at::date as date FROM vitals WHERE patient_id=$1 AND bmi IS NOT NULL ${vf} ORDER BY recorded_at::date, recorded_at DESC`,
        [id],
      ),
    ]);

    const screenings = await pool.query(
      `SELECT DISTINCT ON (test_name) test_name, result, unit, test_date, flag
       FROM lab_results WHERE patient_id=$1 AND test_name IN ('VPT','ABI','Retinopathy','ECG','Doppler','DEXA','Ultrasound','X-Ray','MRI')
       ORDER BY test_name, test_date DESC`,
      [id],
    );

    const diagJourney = await pool.query(
      `SELECT d.diagnosis_id, d.label, d.status, c.visit_date, c.con_name, c.mo_name
       FROM diagnoses d JOIN consultations c ON c.id = d.consultation_id
       WHERE d.patient_id=$1 ORDER BY d.diagnosis_id, c.visit_date`,
      [id],
    );

    const medTimeline = await pool.query(
      `SELECT m.name, m.dose, m.frequency, m.timing, m.is_active, m.is_new, m.started_date, c.visit_date, m.pharmacy_match
       FROM medications m JOIN consultations c ON c.id = m.consultation_id
       WHERE m.patient_id=$1 ORDER BY UPPER(m.name), c.visit_date`,
      [id],
    );

    const visits = await pool.query(
      `SELECT id, visit_date, visit_type, mo_name, con_name, status,
       mo_data->'history' as history, mo_data->'complications' as complications,
       mo_data->'symptoms' as symptoms, mo_data->'compliance' as compliance,
       mo_data->'chief_complaints' as chief_complaints,
       con_data->'diet_lifestyle' as lifestyle, con_data->'self_monitoring' as monitoring,
       con_data->'assessment_summary' as summary,
       con_data->'medications_confirmed' as medications_confirmed,
       con_transcript
       FROM consultations WHERE patient_id=$1 ORDER BY visit_date DESC`,
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
