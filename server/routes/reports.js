import { Router } from "express";
import pool from "../config/db.js";
import { handleError } from "../utils/errorHandler.js";

const router = Router();

// Today's summary with biomarker control rates
router.get("/reports/today", async (req, res) => {
  try {
    const { period = "today", doctor } = req.query;
    let dateFilter = "c.visit_date::date = CURRENT_DATE";
    if (period === "week") dateFilter = "c.visit_date >= CURRENT_DATE - INTERVAL '7 days'";
    else if (period === "month") dateFilter = "c.visit_date >= CURRENT_DATE - INTERVAL '30 days'";
    else if (period === "quarter") dateFilter = "c.visit_date >= CURRENT_DATE - INTERVAL '90 days'";
    else if (period === "year") dateFilter = "c.visit_date >= CURRENT_DATE - INTERVAL '365 days'";
    else if (period === "all") dateFilter = "1=1";
    const doctorFilter = doctor ? ` AND c.con_name ILIKE $1` : "";
    const doctorParams = doctor ? [`%${doctor}%`] : [];

    const patients = await pool.query(
      `
      SELECT DISTINCT ON (p.id) p.id, p.name, p.age, p.sex, p.file_no, p.phone,
        c.visit_date, c.con_name,
        (SELECT json_agg(DISTINCT jsonb_build_object('label',d.label,'status',d.status,'id',d.diagnosis_id))
         FROM (SELECT DISTINCT ON (patient_id, diagnosis_id) label, status, diagnosis_id, patient_id
               FROM diagnoses WHERE patient_id=p.id AND is_active=true ORDER BY patient_id, diagnosis_id, created_at DESC) d
        ) as diagnoses
      FROM patients p
      JOIN consultations c ON c.patient_id=p.id
      WHERE ${dateFilter}${doctorFilter}
      ORDER BY p.id, c.visit_date DESC
    `,
      doctorParams,
    );

    const patientIds = patients.rows.map((p) => p.id);
    if (patientIds.length === 0) {
      return res.json({ total: 0, biomarkers: [], patients: [], by_doctor: {} });
    }

    const labs = (
      await pool.query(
        `
      SELECT DISTINCT ON (patient_id, test_name) patient_id, test_name, result, unit, test_date
      FROM lab_results
      WHERE patient_id = ANY($1)
        AND test_name IN ('HbA1c','FBG','FPG','Fasting Glucose','Fasting Blood Sugar','PP','PP Glucose','Post Prandial','PPG',
                          'LDL','LDL-C','LDL Cholesterol','Triglycerides','TG','Non-HDL','Non HDL','NonHDL',
                          'eGFR','GFR','UACR','ACR','Microalbumin','Urine ACR',
                          'Creatinine','Serum Creatinine')
        AND result IS NOT NULL
      ORDER BY patient_id, test_name, test_date DESC
    `,
        [patientIds],
      )
    ).rows;

    const vitals = (
      await pool.query(
        `
      SELECT DISTINCT ON (patient_id) patient_id, bp_sys, bp_dia, bmi, weight
      FROM vitals
      WHERE patient_id = ANY($1) AND (bp_sys IS NOT NULL OR bmi IS NOT NULL OR weight IS NOT NULL)
      ORDER BY patient_id, recorded_at DESC
    `,
        [patientIds],
      )
    ).rows;

    const prevWeights = (
      await pool.query(
        `
      SELECT DISTINCT ON (v.patient_id) v.patient_id, v.weight, v.recorded_at
      FROM vitals v
      INNER JOIN (
        SELECT patient_id, MAX(recorded_at) as latest FROM vitals WHERE patient_id = ANY($1) AND weight IS NOT NULL GROUP BY patient_id
      ) lv ON v.patient_id=lv.patient_id AND v.recorded_at < lv.latest
      WHERE v.patient_id = ANY($1) AND v.weight IS NOT NULL
      ORDER BY v.patient_id, v.recorded_at DESC
    `,
        [patientIds],
      )
    ).rows;

    // Build per-patient biomarker map
    const patientBio = {};
    patientIds.forEach((id) => {
      patientBio[id] = {};
    });

    labs.forEach((l) => {
      const pid = l.patient_id;
      const val = parseFloat(l.result);
      if (isNaN(val)) return;
      const tn = l.test_name.toLowerCase();

      if (tn.includes("a1c") || tn === "hba1c") patientBio[pid].hba1c = val;
      else if (["fbg", "fpg", "fasting glucose", "fasting blood sugar"].includes(tn))
        patientBio[pid].fbg = val;
      else if (["pp", "ppg", "pp glucose", "post prandial"].includes(tn)) patientBio[pid].ppg = val;
      else if (["ldl", "ldl-c", "ldl cholesterol"].includes(tn)) patientBio[pid].ldl = val;
      else if (["tg", "triglycerides"].includes(tn)) patientBio[pid].tg = val;
      else if (["non-hdl", "non hdl", "nonhdl"].includes(tn)) patientBio[pid].nonhdl = val;
      else if (["egfr", "gfr"].includes(tn)) patientBio[pid].egfr = val;
      else if (["uacr", "acr", "microalbumin", "urine acr"].includes(tn))
        patientBio[pid].uacr = val;
      else if (["creatinine", "serum creatinine"].includes(tn)) patientBio[pid].creatinine = val;
    });

    vitals.forEach((v) => {
      const pid = v.patient_id;
      if (v.bp_sys) patientBio[pid].bp_sys = parseFloat(v.bp_sys);
      if (v.bp_dia) patientBio[pid].bp_dia = parseFloat(v.bp_dia);
      if (v.bmi) patientBio[pid].bmi = parseFloat(v.bmi);
      if (v.weight) patientBio[pid].weight = parseFloat(v.weight);
    });

    prevWeights.forEach((w) => {
      patientBio[w.patient_id].prev_weight = parseFloat(w.weight);
    });

    // Biomarker targets
    const targets = [
      {
        key: "hba1c",
        label: "HbA1c",
        target: "<7%",
        unit: "%",
        good: (v) => v < 7,
        warn: (v) => v >= 7 && v < 8,
        emoji: "🩸",
      },
      {
        key: "fbg",
        label: "Fasting Glucose",
        target: "<130 mg/dL",
        unit: "mg/dL",
        good: (v) => v < 130,
        warn: (v) => v >= 130 && v < 180,
        emoji: "🍳",
      },
      {
        key: "ppg",
        label: "Post-Prandial",
        target: "<180 mg/dL",
        unit: "mg/dL",
        good: (v) => v < 180,
        warn: (v) => v >= 180 && v < 250,
        emoji: "🍽️",
      },
      {
        key: "bp",
        label: "Blood Pressure",
        target: "<130/80",
        unit: "mmHg",
        good: (v, p) => p.bp_sys < 130 && p.bp_dia < 80,
        warn: (v, p) => p.bp_sys >= 130 && p.bp_sys < 140,
        emoji: "💓",
        composite: true,
      },
      {
        key: "ldl",
        label: "LDL",
        target: "<100 mg/dL",
        unit: "mg/dL",
        good: (v) => v < 100,
        warn: (v) => v >= 100 && v < 130,
        emoji: "🫀",
      },
      {
        key: "tg",
        label: "Triglycerides",
        target: "<150 mg/dL",
        unit: "mg/dL",
        good: (v) => v < 150,
        warn: (v) => v >= 150 && v < 200,
        emoji: "🧈",
      },
      {
        key: "nonhdl",
        label: "Non-HDL",
        target: "<130 mg/dL",
        unit: "mg/dL",
        good: (v) => v < 130,
        warn: (v) => v >= 130 && v < 160,
        emoji: "🫀",
      },
      {
        key: "egfr",
        label: "eGFR",
        target: ">60 mL/min",
        unit: "mL/min",
        good: (v) => v > 60,
        warn: (v) => v >= 45 && v <= 60,
        emoji: "🫘",
      },
      {
        key: "uacr",
        label: "UACR",
        target: "<30 mg/g",
        unit: "mg/g",
        good: (v) => v < 30,
        warn: (v) => v >= 30 && v < 300,
        emoji: "🫘",
      },
      {
        key: "bmi",
        label: "BMI",
        target: "<25",
        unit: "kg/m²",
        good: (v) => v < 25,
        warn: (v) => v >= 25 && v < 30,
        emoji: "⚖️",
      },
      {
        key: "weight",
        label: "Weight Trend",
        target: "Losing/Stable",
        unit: "kg",
        good: (v, p) => p.prev_weight && v <= p.prev_weight,
        warn: (v, p) => !p.prev_weight,
        emoji: "📉",
        trend: true,
      },
    ];

    // Calculate control rates per biomarker
    const biomarkers = targets.map((t) => {
      let inControl = 0,
        outControl = 0,
        warning = 0,
        noData = 0,
        tested = 0;
      const patientDetails = [];

      patients.rows.forEach((p) => {
        const bio = patientBio[p.id];
        let val, status, displayVal;

        if (t.composite && t.key === "bp") {
          if (bio.bp_sys && bio.bp_dia) {
            val = bio.bp_sys;
            displayVal = `${bio.bp_sys}/${bio.bp_dia}`;
            tested++;
            if (t.good(val, bio)) {
              status = "in_control";
              inControl++;
            } else if (t.warn(val, bio)) {
              status = "warning";
              warning++;
            } else {
              status = "out_control";
              outControl++;
            }
          } else {
            status = "no_data";
            noData++;
          }
        } else if (t.trend && t.key === "weight") {
          if (bio.weight) {
            val = bio.weight;
            displayVal = `${bio.weight}kg`;
            tested++;
            if (bio.prev_weight) {
              const diff = bio.weight - bio.prev_weight;
              displayVal += ` (${diff > 0 ? "+" : ""}${diff.toFixed(1)})`;
              if (diff <= 0) {
                status = "in_control";
                inControl++;
              } else if (diff <= 2) {
                status = "warning";
                warning++;
              } else {
                status = "out_control";
                outControl++;
              }
            } else {
              status = "no_data";
              noData++;
            }
          } else {
            status = "no_data";
            noData++;
          }
        } else {
          val = bio[t.key];
          if (val !== undefined && val !== null) {
            displayVal = `${val} ${t.unit}`;
            tested++;
            if (t.good(val, bio)) {
              status = "in_control";
              inControl++;
            } else if (t.warn(val, bio)) {
              status = "warning";
              warning++;
            } else {
              status = "out_control";
              outControl++;
            }
          } else {
            status = "no_data";
            noData++;
          }
        }

        patientDetails.push({
          id: p.id,
          name: p.name,
          age: p.age,
          sex: p.sex,
          file_no: p.file_no,
          phone: p.phone,
          con_name: p.con_name,
          visit_date: p.visit_date,
          value: val,
          display: displayVal,
          status,
          diagnoses: p.diagnoses,
        });
      });

      return {
        key: t.key,
        label: t.label,
        target: t.target,
        unit: t.unit,
        emoji: t.emoji,
        in_control: inControl,
        warning,
        out_control: outControl,
        no_data: noData,
        tested,
        total: patients.rows.length,
        pct: tested > 0 ? Math.round((inControl / tested) * 100) : null,
        patients: patientDetails.sort((a, b) => {
          const order = { out_control: 0, warning: 1, in_control: 2, no_data: 3 };
          return (order[a.status] || 3) - (order[b.status] || 3);
        }),
      };
    });

    // Per-patient summary (how many targets met)
    const patientSummaries = patients.rows
      .map((p) => {
        const bio = patientBio[p.id];
        let met = 0,
          total = 0;
        const conditions = {};

        targets.forEach((t) => {
          let val,
            inCtrl = false,
            hasData = false;
          if (t.composite && t.key === "bp") {
            if (bio.bp_sys && bio.bp_dia) {
              hasData = true;
              inCtrl = t.good(bio.bp_sys, bio);
              val = `${bio.bp_sys}/${bio.bp_dia}`;
            }
          } else if (t.trend) {
            // skip weight from target count
          } else {
            val = bio[t.key];
            if (val !== undefined && val !== null) {
              hasData = true;
              inCtrl = t.good(val, bio);
            }
          }
          if (hasData && !t.trend) {
            total++;
            if (inCtrl) met++;
            conditions[t.key] = {
              val,
              in_control: inCtrl,
              label: t.label,
              emoji: t.emoji,
              target: t.target,
            };
          }
        });

        return {
          id: p.id,
          name: p.name,
          age: p.age,
          sex: p.sex,
          file_no: p.file_no,
          phone: p.phone,
          con_name: p.con_name,
          visit_date: p.visit_date,
          diagnoses: p.diagnoses,
          targets_met: met,
          targets_total: total,
          pct: total > 0 ? Math.round((met / total) * 100) : null,
          conditions,
          all_bio: bio,
        };
      })
      .sort((a, b) => (a.pct === null ? 999 : a.pct) - (b.pct === null ? 999 : b.pct));

    // Doctor breakdown
    const byDoctor = {};
    patients.rows.forEach((p) => {
      const d = p.con_name || "Unknown";
      byDoctor[d] = (byDoctor[d] || 0) + 1;
    });

    res.json({
      total: patients.rows.length,
      biomarkers,
      patients: patientSummaries,
      by_doctor: byDoctor,
    });
  } catch (e) {
    handleError(res, e, "Reports today");
  }
});

// Diagnosis distribution
router.get("/reports/diagnoses", async (req, res) => {
  try {
    const result = await pool.query(`
      WITH latest AS (
        SELECT DISTINCT ON (patient_id, diagnosis_id)
          patient_id, diagnosis_id, label, status
        FROM diagnoses WHERE is_active=true
        ORDER BY patient_id, diagnosis_id, created_at DESC
      )
      SELECT diagnosis_id as id,
        (array_agg(label ORDER BY label))[1] as label,
        status,
        COUNT(DISTINCT patient_id) as patient_count
      FROM latest
      GROUP BY diagnosis_id, status
      ORDER BY patient_count DESC
    `);

    const map = {};
    result.rows.forEach((r) => {
      if (!map[r.id])
        map[r.id] = {
          id: r.id,
          label: r.label,
          total: 0,
          controlled: 0,
          uncontrolled: 0,
          present: 0,
        };
      const cnt = parseInt(r.patient_count);
      map[r.id].total += cnt;
      if (r.status === "Controlled") map[r.id].controlled += cnt;
      else if (r.status === "Uncontrolled") map[r.id].uncontrolled += cnt;
      else map[r.id].present += cnt;
    });

    res.json(Object.values(map).sort((a, b) => b.total - a.total));
  } catch (e) {
    handleError(res, e, "Report");
  }
});

// Doctor performance
router.get("/reports/doctors", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT c.con_name as doctor,
        COUNT(DISTINCT c.patient_id) as total_patients,
        COUNT(DISTINCT c.id) as total_visits,
        COUNT(DISTINCT CASE WHEN c.visit_date::date = CURRENT_DATE THEN c.patient_id END) as today,
        COUNT(DISTINCT CASE WHEN c.visit_date >= CURRENT_DATE - INTERVAL '7 days' THEN c.patient_id END) as this_week,
        COUNT(DISTINCT CASE WHEN c.visit_date >= CURRENT_DATE - INTERVAL '30 days' THEN c.patient_id END) as this_month
      FROM consultations c
      WHERE c.con_name IS NOT NULL AND c.con_name != ''
      GROUP BY c.con_name
      ORDER BY total_patients DESC
    `);
    res.json(result.rows);
  } catch (e) {
    handleError(res, e, "Report");
  }
});

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

    const reasoningFeed = await pool.query(
      `SELECT cr.*, p.name as patient_name, p.file_no FROM clinical_reasoning cr JOIN patients p ON p.id=cr.patient_id ${dateFilter ? "WHERE 1=1 " + dateFilter : ""} ORDER BY cr.created_at DESC LIMIT 50`,
    );

    const rxFeed = await pool.query(
      `SELECT rf.*, p.name as patient_name, p.file_no FROM rx_review_feedback rf JOIN patients p ON p.id=rf.patient_id ${dateFilter ? "WHERE 1=1 " + dateFilter : ""} ORDER BY rf.created_at DESC LIMIT 50`,
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
