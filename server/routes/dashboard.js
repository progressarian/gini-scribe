import { Router } from "express";
import pool from "../config/db.js";
import { handleError } from "../utils/errorHandler.js";

const router = Router();

// Biomarker definitions — each with aliases, target threshold, and direction
const BIOMARKERS = {
  hba1c: {
    label: "HbA1c",
    unit: "%",
    aliases: ["HbA1c", "hb_a1c", "Glycated Hemoglobin", "A1c", "HBA1C"],
    target: 7,
    danger: 9,
    lowerIsBetter: true,
    bands: [
      { label: "≤ 7%", max: 7 },
      { label: "7–8", max: 8 },
      { label: "8–9", max: 9 },
      { label: "9–10", max: 10 },
      { label: "> 10%", max: Infinity },
    ],
  },
  ldl: {
    label: "LDL",
    unit: "mg/dL",
    aliases: ["LDL", "LDL Cholesterol", "LDL-C", "LDL CHOLESTEROL-DIRECT", "ldl_cholesterol"],
    target: 100,
    danger: 160,
    lowerIsBetter: true,
    bands: [
      { label: "≤ 100", max: 100 },
      { label: "100–130", max: 130 },
      { label: "130–160", max: 160 },
      { label: "> 160", max: Infinity },
    ],
  },
  uacr: {
    label: "UACR",
    unit: "mg/g",
    aliases: ["UACR", "Urine ACR", "Microalbumin", "uacr", "microalbumin_creatinine"],
    target: 30,
    danger: 300,
    lowerIsBetter: true,
    bands: [
      { label: "< 30", max: 30 },
      { label: "30–60", max: 60 },
      { label: "60–300", max: 300 },
      { label: "> 300", max: Infinity },
    ],
  },
  tsh: {
    label: "TSH",
    unit: "µIU/mL",
    aliases: ["TSH", "Thyroid Stimulating Hormone", "THYROID STIMULATING HORMONE", "tsh"],
    target: 4.5,
    targetLow: 0.5,
    danger: 10,
    lowerIsBetter: null,
    bands: [
      { label: "< 0.5", max: 0.5 },
      { label: "0.5–4.5", max: 4.5 },
      { label: "4.5–10", max: 10 },
      { label: "> 10", max: Infinity },
    ],
  },
  tg: {
    label: "Triglycerides",
    unit: "mg/dL",
    aliases: ["Triglycerides", "TG", "TRIGLYCERIDES", "triglycerides"],
    target: 150,
    danger: 500,
    lowerIsBetter: true,
    bands: [
      { label: "< 150", max: 150 },
      { label: "150–200", max: 200 },
      { label: "200–500", max: 500 },
      { label: "> 500", max: Infinity },
    ],
  },
};

// Helper: compute stats for one biomarker across a set of patients
async function computeBiomarkerStats(patientIds, bioKey) {
  const bio = BIOMARKERS[bioKey];
  const empty = { key: bioKey, label: bio?.label || bioKey, unit: bio?.unit || "", target: bio ? (bio.lowerIsBetter === null ? `${bio.targetLow}-${bio.target}` : `≤ ${bio.target}`) : "", withData: 0, atTargetStable: 0, atTarget: 0, uncontrolled: 0, rising: 0, improving_count: 0, controlRate: 0, improving: { total: 0, bands: [] }, worsening: { total: 0, bands: [] }, stableOffTarget: 0, firstReading: 0, distribution: [], bandLabels: [] };
  if (!bio || patientIds.length === 0) return empty;

  try {
    const aliases = bio.aliases.map((a) => a.toLowerCase());

    const latestR = await pool.query(
      `SELECT DISTINCT ON (patient_id) patient_id, result, test_date
       FROM lab_results
       WHERE patient_id = ANY($1::int[])
         AND result IS NOT NULL
         AND LOWER(COALESCE(canonical_name, test_name)) = ANY($2::text[])
       ORDER BY patient_id, test_date DESC, created_at DESC`,
      [patientIds, aliases],
    );

    const prevR = await pool.query(
      `SELECT DISTINCT ON (patient_id) patient_id, result
       FROM (
         SELECT *, ROW_NUMBER() OVER (PARTITION BY patient_id ORDER BY test_date DESC, created_at DESC) AS rn
         FROM lab_results
         WHERE patient_id = ANY($1::int[])
           AND result IS NOT NULL
           AND LOWER(COALESCE(canonical_name, test_name)) = ANY($2::text[])
       ) sub WHERE rn = 2
       ORDER BY patient_id`,
      [patientIds, aliases],
    );

    const latestMap = new Map();
    for (const r of latestR.rows) latestMap.set(r.patient_id, parseFloat(r.result));
    const prevMap = new Map();
    for (const r of prevR.rows) prevMap.set(r.patient_id, parseFloat(r.result));

    let withData = 0, atTargetStable = 0, firstReading = 0;
    let improvingTotal = 0, worseningTotal = 0, stableOffTarget = 0;
    const distribution = bio.bands.map(() => 0);
    const improvingBands = bio.bands.map(() => 0);
    const worseningBands = bio.bands.map(() => 0);

    for (const [pid, v] of latestMap) {
      if (isNaN(v)) continue;
      withData++;

      // Distribution band
      let band = bio.bands.length - 1;
      for (let i = 0; i < bio.bands.length; i++) {
        if (v <= bio.bands[i].max || i === bio.bands.length - 1) { band = i; break; }
      }
      distribution[band]++;

      // Target check
      const atTarget = bio.lowerIsBetter === null
        ? (v >= (bio.targetLow || 0) && v <= bio.target)
        : (bio.lowerIsBetter ? v <= bio.target : v >= bio.target);

      // Trend
      const prev = prevMap.get(pid);
      if (prev == null || isNaN(prev)) { firstReading++; continue; }

      const pctChange = Math.abs(v - prev) / (Math.abs(prev) || 1) * 100;
      if (pctChange < 3) {
        if (atTarget) atTargetStable++;
        else stableOffTarget++;
        continue;
      }

      let improving = false;
      if (bio.lowerIsBetter === true) improving = v < prev;
      else if (bio.lowerIsBetter === false) improving = v > prev;
      else improving = Math.abs(v - (bio.target + (bio.targetLow || 0)) / 2) < Math.abs(prev - (bio.target + (bio.targetLow || 0)) / 2);

      if (improving) { improvingTotal++; improvingBands[band]++; }
      else { worseningTotal++; worseningBands[band]++; }
    }

    return {
      ...empty,
      withData,
      atTargetStable,
      atTarget: atTargetStable + (improvingBands[0] || 0),
      uncontrolled: (worseningBands[bio.bands.length - 1] || 0),
      rising: worseningTotal,
      improving_count: improvingTotal,
      controlRate: withData > 0 ? Math.round(((atTargetStable + (improvingBands[0] || 0)) / withData) * 100) : 0,
      improving: { total: improvingTotal, bands: improvingBands },
      worsening: { total: worseningTotal, bands: worseningBands },
      stableOffTarget,
      firstReading,
      distribution,
      bandLabels: bio.bands.map((b) => b.label),
    };
  } catch (e) {
    console.error(`Biomarker ${bioKey} failed:`, e.message);
    return empty;
  }
}

// ── GET /api/dashboard ─────────────────────────────────────────────────────
router.get("/dashboard", async (req, res) => {
  try {
    const { period, from, to } = req.query;

    // ── 1. Determine date range ──
    const now = new Date();
    const todayStr = now.toISOString().split("T")[0];
    const fmtDate = (d) => {
      const dt = new Date(d);
      const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
      const days = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
      return `${days[dt.getDay()]} ${dt.getDate()} ${months[dt.getMonth()]} ${dt.getFullYear()}`;
    };
    let dateFrom, dateTo, label;

    if (from === "all") {
      dateFrom = "2000-01-01"; dateTo = todayStr; label = "All Time";
    } else if (from && to) {
      dateFrom = from; dateTo = to; label = `${fmtDate(from)} — ${fmtDate(to)}`;
    } else {
      switch (period) {
        case "tomorrow": {
          const t = new Date(now); t.setDate(t.getDate() + 1);
          dateFrom = dateTo = t.toISOString().split("T")[0];
          label = `Tomorrow · ${fmtDate(dateFrom)}`;
          break;
        }
        case "yesterday": {
          const y = new Date(now); y.setDate(y.getDate() - 1);
          dateFrom = dateTo = y.toISOString().split("T")[0];
          label = `Yesterday · ${fmtDate(dateFrom)}`;
          break;
        }
        case "week": {
          const d = now.getDay();
          const mon = new Date(now); mon.setDate(mon.getDate() - (d === 0 ? 6 : d - 1));
          dateFrom = mon.toISOString().split("T")[0]; dateTo = todayStr;
          label = `This Week · ${fmtDate(dateFrom)} — ${fmtDate(dateTo)}`;
          break;
        }
        case "month": {
          dateFrom = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
          dateTo = todayStr;
          label = `This Month · ${fmtDate(dateFrom)} — ${fmtDate(dateTo)}`;
          break;
        }
        case "lastmonth": {
          const lm = new Date(now.getFullYear(), now.getMonth() - 1, 1);
          const lmEnd = new Date(now.getFullYear(), now.getMonth(), 0);
          dateFrom = lm.toISOString().split("T")[0]; dateTo = lmEnd.toISOString().split("T")[0];
          label = `Last Month · ${fmtDate(dateFrom)} — ${fmtDate(dateTo)}`;
          break;
        }
        default: {
          dateFrom = dateTo = todayStr;
          label = `Today · ${fmtDate(todayStr)}`;
        }
      }
    }

    // ── 2. Get unique patients from appointments ──
    const apptR = await pool.query(
      `SELECT DISTINCT ON (COALESCE(a.patient_id, p.id))
              COALESCE(a.patient_id, p.id) AS patient_id,
              p.name, p.file_no, p.phone, p.age, p.sex,
              a.id AS appointment_id, a.appointment_date, a.status, a.category,
              a.doctor_name, a.time_slot, a.biomarkers, a.compliance,
              a.visit_type
       FROM appointments a
       LEFT JOIN patients p ON p.id = a.patient_id
       WHERE a.appointment_date >= $1::date AND a.appointment_date <= $2::date
       ORDER BY COALESCE(a.patient_id, p.id), a.appointment_date DESC`,
      [dateFrom, dateTo],
    );

    const patients = apptR.rows.filter((r) => r.patient_id);
    const patientIds = patients.map((p) => p.patient_id);

    // ── 3. New vs Follow-up split ──
    const newPatients = patients.filter((p) => {
      const vt = (p.visit_type || "").toLowerCase();
      return vt.includes("new") || vt === "opd";
    });
    const followUpPatients = patients.filter((p) => {
      const vt = (p.visit_type || "").toLowerCase();
      return !vt.includes("new") && vt !== "opd";
    });

    const emptyResponse = {
      period: { from: dateFrom, to: dateTo, label },
      patientSplit: { total: 0, new: 0, followUp: 0 },
      biomarkers: {},
      needsAttention: [], onTrack: [],
      visitFlow: null, healthraySyncedAt: null,
    };

    if (patientIds.length === 0) {
      emptyResponse.visitFlow = dateFrom === dateTo && dateTo === todayStr ? { seen: 0, withDoctor: 0, waiting: 0, ready: 0, pending: 0 } : null;
      return res.json(emptyResponse);
    }

    // ── 4. Compute biomarker stats (all in parallel) ──
    const emptyBio = (key) => ({ key, label: key, unit: "", withData: 0, atTargetStable: 0, improving: { total: 0, bands: [] }, worsening: { total: 0, bands: [] }, stableOffTarget: 0, firstReading: 0, distribution: [], bandLabels: [], atTarget: 0, uncontrolled: 0, rising: 0, improving_count: 0, controlRate: 0 });

    let hba1cStats, ldlStats, uacrStats, tshStats, tgStats;
    try {
      [hba1cStats, ldlStats, uacrStats, tshStats, tgStats] = await Promise.all([
        computeBiomarkerStats(patientIds, "hba1c"),
        computeBiomarkerStats(patientIds, "ldl"),
        computeBiomarkerStats(patientIds, "uacr"),
        computeBiomarkerStats(patientIds, "tsh"),
        computeBiomarkerStats(patientIds, "tg"),
      ]);
    } catch (e) {
      console.error("Biomarker computation failed:", e.message);
      hba1cStats = emptyBio("hba1c");
      ldlStats = emptyBio("ldl");
      uacrStats = emptyBio("uacr");
      tshStats = emptyBio("tsh");
      tgStats = emptyBio("tg");
    }

    // Also compute HbA1c separately for new vs follow-up
    const newIds = newPatients.map((p) => p.patient_id).filter(Boolean);
    const fuIds = followUpPatients.map((p) => p.patient_id).filter(Boolean);
    let hba1cNew = null, hba1cFU = null;
    try {
      [hba1cNew, hba1cFU] = await Promise.all([
        newIds.length > 0 ? computeBiomarkerStats(newIds, "hba1c") : null,
        fuIds.length > 0 ? computeBiomarkerStats(fuIds, "hba1c") : null,
      ]);
    } catch (e) {
      console.error("New/FU HbA1c split failed:", e.message);
    }

    // ── 5. Build needs attention + on track from HbA1c (primary metric) ──
    // Get latest + prev HbA1c per patient for the patient lists
    const hba1cAliases = BIOMARKERS.hba1c.aliases.map((a) => `'${a.replace(/'/g, "''")}'`).join(",");
    const latestR = await pool.query(
      `SELECT DISTINCT ON (patient_id) patient_id, result, test_date
       FROM lab_results WHERE patient_id = ANY($1::int[])
         AND COALESCE(canonical_name, test_name) IN (${hba1cAliases}) AND result IS NOT NULL
       ORDER BY patient_id, test_date DESC, created_at DESC`,
      [patientIds],
    );
    const prevR = await pool.query(
      `SELECT DISTINCT ON (patient_id) patient_id, result
       FROM (
         SELECT *, ROW_NUMBER() OVER (PARTITION BY patient_id ORDER BY test_date DESC, created_at DESC) AS rn
         FROM lab_results WHERE patient_id = ANY($1::int[])
           AND COALESCE(canonical_name, test_name) IN (${hba1cAliases}) AND result IS NOT NULL
       ) sub WHERE rn = 2 ORDER BY patient_id`,
      [patientIds],
    );

    const latestMap = new Map();
    for (const r of latestR.rows) latestMap.set(r.patient_id, { value: parseFloat(r.result), date: r.test_date });
    const prevMap = new Map();
    for (const r of prevR.rows) prevMap.set(r.patient_id, parseFloat(r.result));

    const needsAttention = [];
    const onTrack = [];

    for (const p of patients) {
      const latest = latestMap.get(p.patient_id);
      const prev = prevMap.get(p.patient_id);
      const compliance = p.compliance?.medPct ?? null;
      const vt = (p.visit_type || "").toLowerCase();
      const isNew = vt.includes("new") || vt === "opd";

      if (!latest) {
        needsAttention.push({
          patientId: p.patient_id, name: p.name, fileNo: p.file_no,
          latestHba1c: null, prevHba1c: null, trend: null, compliance,
          lastVisit: p.appointment_date, urgencyReason: "Missing data — no HbA1c on file",
          priority: 5, doctor: p.doctor_name, category: p.category, visitType: isNew ? "New" : "Follow-Up",
        });
        continue;
      }

      const v = latest.value;
      const isRising = prev != null && v > prev;
      const row = {
        patientId: p.patient_id, name: p.name, fileNo: p.file_no,
        latestHba1c: v, latestDate: latest.date,
        prevHba1c: prev || null,
        trend: prev == null ? "first" : v > prev ? "rising" : v < prev ? "falling" : "stable",
        compliance, lastVisit: p.appointment_date, doctor: p.doctor_name, category: p.category,
        visitType: isNew ? "New" : "Follow-Up",
      };

      if (v > 9 && isRising) {
        needsAttention.push({ ...row, urgencyReason: "Uncontrolled + worsening — urgent", priority: 0 });
      } else if (v > 9) {
        needsAttention.push({ ...row, urgencyReason: `Uncontrolled — HbA1c ${v}%`, priority: 1 });
      } else if (isRising) {
        needsAttention.push({ ...row, urgencyReason: `Rising trend (${prev}→${v}%) — needs review`, priority: 2 });
      } else if (compliance != null && compliance < 60) {
        needsAttention.push({ ...row, urgencyReason: `Low compliance ${compliance}%`, priority: 3 });
      } else if (v > 7 && v <= 9 && prev != null && v >= prev) {
        needsAttention.push({ ...row, urgencyReason: "Stuck — not progressing", priority: 4 });
      } else if (v <= 7.5) {
        onTrack.push(row);
      }
    }

    needsAttention.sort((a, b) => a.priority - b.priority);
    onTrack.sort((a, b) => (a.latestHba1c || 0) - (b.latestHba1c || 0));

    // ── 6. Visit flow (today only) ──
    let visitFlow = null;
    if (dateFrom === dateTo && dateTo === todayStr) {
      const allAppts = await pool.query(
        `SELECT status FROM appointments WHERE appointment_date = $1::date`, [todayStr],
      );
      const flow = { seen: 0, withDoctor: 0, waiting: 0, ready: 0, pending: 0 };
      for (const a of allAppts.rows) {
        switch (a.status) {
          case "seen": case "completed": flow.seen++; break;
          case "in_visit": flow.withDoctor++; break;
          case "checkedin": flow.waiting++; break;
          default: flow.pending++;
        }
      }
      visitFlow = flow;
    }

    // ── 7. Last HealthRay sync ──
    let healthraySyncedAt = null;
    try {
      const syncR = await pool.query(`SELECT MAX(updated_at) AS last_sync FROM appointments WHERE source = 'healthray'`);
      healthraySyncedAt = syncR.rows[0]?.last_sync || null;
    } catch {}

    // ── 8. BP from vitals (separate from lab_results) ──
    const bpR = await pool.query(
      `SELECT DISTINCT ON (patient_id) patient_id, bp_sys, bp_dia
       FROM vitals WHERE patient_id = ANY($1::int[]) AND bp_sys IS NOT NULL
       ORDER BY patient_id, recorded_at DESC`,
      [patientIds],
    );
    let bpWithData = 0, bpAtTarget = 0, bpUncontrolled = 0;
    const bpDist = [0, 0, 0, 0];
    for (const r of bpR.rows) {
      const sys = parseFloat(r.bp_sys);
      if (isNaN(sys)) continue;
      bpWithData++;
      if (sys < 130) { bpAtTarget++; bpDist[0]++; }
      else if (sys < 140) { bpDist[1]++; }
      else if (sys <= 150) { bpDist[2]++; }
      else { bpUncontrolled++; bpDist[3]++; }
    }

    // Body composition from vitals (latest + previous for trend)
    let weightStats = { key: "weight", label: "Weight", unit: "kg", withData: 0, improving: { total: 0 }, worsening: { total: 0 }, controlRate: null, target: "Patient-specific" };
    let waistStats = { key: "waist", label: "Waist", unit: "cm", withData: 0, improving: { total: 0 }, worsening: { total: 0 }, controlRate: null, target: "Patient-specific" };
    let bodyFatStats = { key: "body_fat", label: "Body Fat", unit: "%", withData: 0, improving: { total: 0 }, worsening: { total: 0 }, controlRate: null, target: "Patient-specific" };
    let muscleMassStats = { key: "muscle_mass", label: "Muscle Mass", unit: "kg", withData: 0, improving: { total: 0 }, worsening: { total: 0 }, controlRate: null, target: "Trend only" };

    try {
      const bodyR = await pool.query(
        `SELECT DISTINCT ON (patient_id) patient_id, weight, waist, body_fat, muscle_mass
         FROM vitals WHERE patient_id = ANY($1::int[])
           AND (weight IS NOT NULL OR waist IS NOT NULL)
         ORDER BY patient_id, recorded_at DESC`,
        [patientIds],
      );
      const bodyPrevR = await pool.query(
        `SELECT DISTINCT ON (patient_id) patient_id, weight, waist, body_fat, muscle_mass
         FROM (
           SELECT *, ROW_NUMBER() OVER (PARTITION BY patient_id ORDER BY recorded_at DESC) AS rn
           FROM vitals WHERE patient_id = ANY($1::int[])
             AND (weight IS NOT NULL OR waist IS NOT NULL)
         ) sub WHERE rn = 2 ORDER BY patient_id`,
        [patientIds],
      );
      const bodyPrevMap = new Map();
      for (const r of bodyPrevR.rows) bodyPrevMap.set(r.patient_id, r);

      function computeVitalMetric(field, label, unit, lowerIsBetter = true) {
        let withData = 0, improving = 0, worsening = 0;
        for (const r of bodyR.rows) {
          const v = parseFloat(r[field]);
          if (isNaN(v)) continue;
          withData++;
          const prev = bodyPrevMap.get(r.patient_id);
          const pv = prev ? parseFloat(prev[field]) : NaN;
          if (!isNaN(pv)) {
            const better = lowerIsBetter ? v < pv : v > pv;
            const worse = lowerIsBetter ? v > pv : v < pv;
            if (better) improving++;
            else if (worse) worsening++;
          }
        }
        return { key: field, label, unit, withData, improving: { total: improving }, worsening: { total: worsening }, controlRate: null, target: "Patient-specific" };
      }

      weightStats = computeVitalMetric("weight", "Weight", "kg", true);
      waistStats = computeVitalMetric("waist", "Waist", "cm", true);
      bodyFatStats = computeVitalMetric("body_fat", "Body Fat", "%", true);
      muscleMassStats = computeVitalMetric("muscle_mass", "Muscle Mass", "kg", false); // higher is better
    } catch (e) {
      console.log("Body composition query failed (non-critical):", e.message);
    }

    res.json({
      period: { from: dateFrom, to: dateTo, label },
      patientSplit: {
        total: patients.length,
        new: newPatients.length,
        followUp: followUpPatients.length,
      },
      biomarkers: {
        hba1c: { ...hba1cStats, newPatients: hba1cNew, followUpPatients: hba1cFU },
        bp: {
          key: "bp", label: "Blood Pressure", unit: "mmHg", target: "< 130/80",
          withData: bpWithData, atTarget: bpAtTarget, uncontrolled: bpUncontrolled,
          rising: 0, improving: { total: 0 }, distribution: bpDist,
          bandLabels: ["< 130", "130–140", "140–150", "> 150"],
          controlRate: bpWithData > 0 ? Math.round((bpAtTarget / bpWithData) * 100) : 0,
        },
        ldl: ldlStats,
        tg: tgStats,
        uacr: uacrStats,
        tsh: tshStats,
        weight: weightStats,
        waist: waistStats,
        bodyFat: bodyFatStats,
        muscleMass: muscleMassStats,
      },
      // Legacy compat (HbA1c as primary stat cards)
      stats: {
        totalPatients: patients.length,
        withHba1c: hba1cStats.withData,
        atTarget: hba1cStats.atTarget,
        uncontrolled: hba1cStats.uncontrolled,
        risingTrend: hba1cStats.rising,
        missingData: patients.length - hba1cStats.withData,
        controlRate: hba1cStats.controlRate,
        coverageRate: patients.length > 0 ? Math.round((hba1cStats.withData / patients.length) * 100) : 0,
      },
      distribution: hba1cStats.distribution,
      needsAttention,
      onTrack,
      visitFlow,
      healthraySyncedAt,
    });
  } catch (err) {
    console.error("Dashboard error:", err.message);
    console.error("Dashboard stack:", err.stack?.split("\n").slice(0, 8).join("\n"));
    handleError(res, err, "Dashboard");
  }
});

export default router;
