import { Router } from "express";
import pool from "../config/db.js";
import { handleError } from "../utils/errorHandler.js";
import { validateQuery } from "../middleware/validate.js";
import {
  CLINICAL_REPORT_LABELS,
  biomarkerKeySchema,
  biomarkerPatientsQuerySchema,
  diagnosesQuerySchema,
  doctorsQuerySchema,
  reportSummaryQuerySchema,
  scorecardQuerySchema,
} from "../schemas/clinicalReport.js";
import {
  getBiomarkerPatients,
  getDiagnosisDistribution,
  getDoctorStats,
  getReportSummary,
  getScorecard,
} from "../services/reports/clinicalReport.js";

const router = Router();
const query = (schema) => validateQuery(schema, CLINICAL_REPORT_LABELS);
const run = (context, work) => async (req, res) => {
  try {
    res.json(await work(req));
  } catch (e) {
    handleError(res, e, context);
  }
};

router.get(
  "/reports/today",
  query(reportSummaryQuerySchema),
  run("Reports today", (req) =>
    getReportSummary({
      period: req.query.period,
      doctor: req.query.doctor,
      fresh: req.query.refresh,
    }),
  ),
);

router.get(
  "/reports/today/biomarker/:key",
  query(biomarkerPatientsQuerySchema),
  (req, res, next) =>
    biomarkerKeySchema.safeParse(req.params.key).success
      ? next()
      : res.status(404).json({ error: "Unknown biomarker" }),
  run("Report biomarker patients", (req) => getBiomarkerPatients(req.params.key, req.query)),
);

router.get(
  "/reports/today/scorecard",
  query(scorecardQuerySchema),
  run("Report scorecard", (req) => getScorecard(req.query)),
);

router.get(
  "/reports/diagnoses",
  query(diagnosesQuerySchema),
  run("Report", (req) =>
    getDiagnosisDistribution({ limit: req.query.limit, fresh: req.query.refresh }),
  ),
);

router.get(
  "/reports/doctors",
  query(doctorsQuerySchema),
  run("Report", (req) => getDoctorStats({ fresh: req.query.refresh })),
);

// AI Query — raw data for analysis
router.get("/reports/query-data", async (req, res) => {
  try {
    const [patients, meds, labs, diagnoses, vitals] = await Promise.all([
      pool.query(`SELECT p.id, p.name, p.age, p.sex, p.file_no,
        (SELECT MAX(visit_date) FROM consultations c WHERE c.patient_id=p.id) as last_visit,
        (SELECT con_name FROM consultations c WHERE c.patient_id=p.id ORDER BY visit_date DESC LIMIT 1) as doctor
        FROM patients p ORDER BY (SELECT MAX(visit_date) FROM consultations c WHERE c.patient_id=p.id) DESC NULLS LAST LIMIT 200`),
      pool.query(
        `SELECT m.patient_id, m.name, m.dose, m.is_active FROM medications m WHERE m.is_active=true`,
      ),
      pool.query(`SELECT lr.patient_id, lr.test_name, lr.result, lr.unit, lr.test_date
        FROM lab_results lr WHERE lr.test_date > CURRENT_DATE - INTERVAL '12 months'
        ORDER BY lr.test_date DESC`),
      pool.query(
        `SELECT d.patient_id, d.label, d.diagnosis_id, d.status, d.is_active FROM diagnoses d WHERE d.is_active=true`,
      ),
      pool.query(`SELECT DISTINCT ON (v.patient_id) v.patient_id, v.weight, v.bp_sys, v.bp_dia, v.bmi, v.recorded_at
        FROM vitals v ORDER BY v.patient_id, v.recorded_at DESC`),
    ]);

    const medMap = {},
      labMap = {},
      dxMap = {},
      vMap = {};
    meds.rows.forEach((m) => {
      if (!medMap[m.patient_id]) medMap[m.patient_id] = [];
      medMap[m.patient_id].push(m);
    });
    labs.rows.forEach((l) => {
      if (!labMap[l.patient_id]) labMap[l.patient_id] = [];
      if (labMap[l.patient_id].length < 10) labMap[l.patient_id].push(l);
    });
    diagnoses.rows.forEach((d) => {
      if (!dxMap[d.patient_id]) dxMap[d.patient_id] = [];
      dxMap[d.patient_id].push(d);
    });
    vitals.rows.forEach((v) => {
      vMap[v.patient_id] = v;
    });

    const summary = patients.rows.map((p) => ({
      ...p,
      medications: (medMap[p.id] || []).map((m) => `${m.name} ${m.dose}`),
      diagnoses: (dxMap[p.id] || []).map((d) => `${d.label}(${d.status})`),
      recent_labs: (labMap[p.id] || []).map(
        (l) =>
          `${l.test_name}:${l.result}${l.unit || ""}(${String(l.test_date || "").slice(0, 10)})`,
      ),
      vitals: vMap[p.id]
        ? `Wt:${vMap[p.id].weight}kg BP:${vMap[p.id].bp_sys}/${vMap[p.id].bp_dia} BMI:${vMap[p.id].bmi}`
        : null,
    }));

    res.json({ patient_count: summary.length, patients: summary });
  } catch (e) {
    handleError(res, e, "Report");
  }
});

// Clinical Intelligence Report
router.get("/reports/clinical-intelligence", async (req, res) => {
  try {
    const { period } = req.query;
    let dateFilter = "";
    if (period === "month") dateFilter = "AND created_at > NOW() - INTERVAL '1 month'";
    else if (period === "quarter") dateFilter = "AND created_at > NOW() - INTERVAL '3 months'";
    else if (period === "year") dateFilter = "AND created_at > NOW() - INTERVAL '1 year'";

    const [
      crTotal,
      crMonth,
      rxTotal,
      rxMonth,
      agreementStats,
      disagreementTags,
      weeklyTrend,
      doctorStats,
      audioHours,
    ] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM clinical_reasoning`),
      pool.query(
        `SELECT COUNT(*) FROM clinical_reasoning WHERE created_at > NOW() - INTERVAL '1 month'`,
      ),
      pool.query(`SELECT COUNT(*) FROM rx_review_feedback`),
      pool.query(
        `SELECT COUNT(*) FROM rx_review_feedback WHERE created_at > NOW() - INTERVAL '1 month'`,
      ),
      pool.query(
        `SELECT agreement_level, COUNT(*) as count FROM rx_review_feedback ${dateFilter ? "WHERE 1=1 " + dateFilter : ""} GROUP BY agreement_level`,
      ),
      pool.query(
        `SELECT unnest(disagreement_tags) as tag, COUNT(*) as count FROM rx_review_feedback WHERE agreement_level != 'agree' ${dateFilter} GROUP BY tag ORDER BY count DESC LIMIT 10`,
      ),
      pool.query(
        `SELECT date_trunc('week', created_at)::date as week, agreement_level, COUNT(*) as count FROM rx_review_feedback WHERE created_at > NOW() - INTERVAL '3 months' GROUP BY week, agreement_level ORDER BY week`,
      ),
      pool.query(`SELECT doctor_name,
        (SELECT COUNT(*) FROM clinical_reasoning cr WHERE cr.doctor_name=d.doctor_name) as reasoning_count,
        (SELECT COUNT(*) FROM rx_review_feedback rx WHERE rx.doctor_name=d.doctor_name) as rx_count
        FROM (SELECT DISTINCT doctor_name FROM clinical_reasoning UNION SELECT DISTINCT doctor_name FROM rx_review_feedback) d
        ORDER BY reasoning_count DESC`),
      pool.query(
        `SELECT COALESCE(SUM(audio_duration),0) as total_seconds FROM clinical_reasoning WHERE audio_url IS NOT NULL`,
      ),
    ]);

    const crDateFilter = dateFilter.replace("created_at", "cr.created_at");
    const rfDateFilter = dateFilter.replace("created_at", "rf.created_at");

    const reasoningFeed = await pool.query(
      `SELECT cr.*, p.name as patient_name, p.file_no FROM clinical_reasoning cr JOIN patients p ON p.id=cr.patient_id ${crDateFilter ? "WHERE 1=1 " + crDateFilter : ""} ORDER BY cr.created_at DESC LIMIT 50`,
    );

    const rxFeed = await pool.query(
      `SELECT rf.*, p.name as patient_name, p.file_no FROM rx_review_feedback rf JOIN patients p ON p.id=rf.patient_id ${rfDateFilter ? "WHERE 1=1 " + rfDateFilter : ""} ORDER BY rf.created_at DESC LIMIT 50`,
    );

    res.json({
      overview: {
        cr_total: parseInt(crTotal.rows[0].count),
        cr_month: parseInt(crMonth.rows[0].count),
        rx_total: parseInt(rxTotal.rows[0].count),
        rx_month: parseInt(rxMonth.rows[0].count),
        agreement: agreementStats.rows,
        audio_hours: Math.round((parseInt(audioHours.rows[0].total_seconds) / 3600) * 10) / 10,
      },
      disagreement_tags: disagreementTags.rows,
      weekly_trend: weeklyTrend.rows,
      doctor_stats: doctorStats.rows,
      reasoning_feed: reasoningFeed.rows,
      rx_feed: rxFeed.rows,
    });
  } catch (e) {
    handleError(res, e, "CI Report");
  }
});

// Export clinical intelligence data
router.get("/reports/clinical-intelligence/export", async (req, res) => {
  try {
    const [reasoning, feedback] = await Promise.all([
      pool.query(
        `SELECT cr.*, p.file_no FROM clinical_reasoning cr JOIN patients p ON p.id=cr.patient_id ORDER BY cr.created_at DESC`,
      ),
      pool.query(
        `SELECT rf.*, p.file_no FROM rx_review_feedback rf JOIN patients p ON p.id=rf.patient_id ORDER BY rf.created_at DESC`,
      ),
    ]);
    res.json({
      clinical_reasoning: reasoning.rows,
      rx_feedback: feedback.rows,
      exported_at: new Date().toISOString(),
    });
  } catch (e) {
    handleError(res, e, "Report");
  }
});

export default router;
