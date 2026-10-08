import { getCanonical } from "../utils/labCanonical.js";

export function normalizeBiomarkerKeys(bio) {
  if (!bio || typeof bio !== "object") return bio;
  const aliases = { bpSys: "sbp", bpDia: "dbp", BPSys: "sbp", BPDia: "dbp" };
  for (const [from, to] of Object.entries(aliases)) {
    if (bio[from] != null && bio[to] == null) {
      const n = parseFloat(bio[from]);
      if (!isNaN(n)) bio[to] = n;
    }
  }
  return bio;
}

export async function loadTrendSources(patientIds, date, db) {
  const CANONICAL_TO_BIO = {
    HbA1c: "hba1c",
    FBS: "fg",
    PPBS: "ppbs",
    LDL: "ldl",
    HDL: "hdl",
    Triglycerides: "tg",
    UACR: "uacr",
    Microalbumin: "uacr",
    Creatinine: "creatinine",
    TSH: "tsh",
    Haemoglobin: "hb",
    Hemoglobin: "hb",
    eGFR: "egfr",
    ALT: "alt",
    AST: "ast",
  };
  const labByPt = {};
  const prevLabByPt = {};
  if (patientIds.length) {
    const { rows: labR } = await db.query(
      `SELECT patient_id, canonical_name, test_name, result, test_date, created_at
         FROM lab_results
        WHERE patient_id = ANY($1)
          AND result IS NOT NULL
        ORDER BY patient_id,
                 test_date DESC NULLS LAST,
                 created_at DESC`,
      [patientIds],
    );
    const seen = {};
    for (const r of labR) {
      const canonical = r.canonical_name || getCanonical(r.test_name) || r.test_name;
      const bioKey = CANONICAL_TO_BIO[canonical];
      if (!bioKey) continue;
      const val = parseFloat(r.result);
      if (isNaN(val)) continue;
      const byPt = seen[r.patient_id] || (seen[r.patient_id] = {});
      const list = byPt[bioKey] || (byPt[bioKey] = []);
      list.push({ val, date: r.test_date });
    }
    for (const [pid, byKey] of Object.entries(seen)) {
      for (const [bioKey, list] of Object.entries(byKey)) {
        if (list.length >= 1) {
          if (!labByPt[pid]) labByPt[pid] = {};
          labByPt[pid][bioKey] = { val: list[0].val, date: list[0].date };
        }
        if (list.length >= 2) {
          if (!prevLabByPt[pid]) prevLabByPt[pid] = {};
          prevLabByPt[pid][bioKey] = { val: list[1].val, date: list[1].date };
        }
      }
    }
  }

  const vitalsByPt = {};
  const prevVitalsByPt = {};
  if (patientIds.length) {
    try {
      const { rows: vR } = await db.query(
        `SELECT patient_id, bp_sys, bp_dia, weight, bmi, recorded_at, rn
         FROM (
           SELECT patient_id, bp_sys, bp_dia, weight, bmi, recorded_at,
                  ROW_NUMBER() OVER (
                    PARTITION BY patient_id
                    ORDER BY recorded_at DESC NULLS LAST
                  ) AS rn
             FROM vitals
            WHERE patient_id = ANY($1)
              AND (bp_sys IS NOT NULL OR weight IS NOT NULL OR bmi IS NOT NULL)
         ) t
         WHERE rn <= 2`,
        [patientIds],
      );
      for (const r of vR) {
        const bucket = Number(r.rn) === 1 ? vitalsByPt : prevVitalsByPt;
        bucket[r.patient_id] = {
          sbp: r.bp_sys != null ? Number(r.bp_sys) : null,
          dbp: r.bp_dia != null ? Number(r.bp_dia) : null,
          weight: r.weight != null ? Number(r.weight) : null,
          bmi: r.bmi != null ? Number(r.bmi) : null,
          date: r.recorded_at,
        };
      }
    } catch {}
  }

  const appReadingsByPt = {};
  const pushApp = (pid, k, val, d) => {
    const n = parseFloat(val);
    if (!isFinite(n)) return;
    const byPt = appReadingsByPt[pid] || (appReadingsByPt[pid] = {});
    const list = byPt[k] || (byPt[k] = []);
    list.push({ val: n, date: d || null });
  };
  if (patientIds.length) {
    try {
      const { rows: appR } = await db.query(
        `SELECT patient_id, bp_systolic, bp_diastolic, weight_kg, bmi,
                rbs, meal_type, waist, body_fat,
                COALESCE(created_at, recorded_date::timestamp) AS recorded_at
           FROM patient_vitals_log
          WHERE patient_id = ANY($1)`,
        [patientIds],
      );
      for (const r of appR) {
        const d = r.recorded_at;
        pushApp(r.patient_id, "sbp", r.bp_systolic, d);
        pushApp(r.patient_id, "dbp", r.bp_diastolic, d);
        pushApp(r.patient_id, "weight", r.weight_kg, d);
        pushApp(r.patient_id, "bmi", r.bmi, d);
        pushApp(r.patient_id, "waist", r.waist, d);
        pushApp(r.patient_id, "bodyFat", r.body_fat, d);
        if (r.rbs != null && (r.meal_type || "").toLowerCase() === "fasting") {
          pushApp(r.patient_id, "fg", r.rbs, d);
        }
      }
    } catch {}
    try {
      const { rows: fastR } = await db.query(
        `SELECT patient_id, rbs, recorded_at
           FROM vitals
          WHERE patient_id = ANY($1)
            AND rbs IS NOT NULL
            AND LOWER(COALESCE(meal_type, '')) = 'fasting'`,
        [patientIds],
      );
      for (const r of fastR) pushApp(r.patient_id, "fg", r.rbs, r.recorded_at);
    } catch {}
  }

  const prevHistByPt = {};
  if (patientIds.length) {
    try {
      const { rows: histR } = await db.query(
        `SELECT patient_id, biomarkers, appointment_date
           FROM appointments
          WHERE patient_id = ANY($1::int[])
            AND appointment_date < $2
            AND biomarkers IS NOT NULL
          ORDER BY patient_id, appointment_date DESC NULLS LAST, created_at DESC`,
        [patientIds, date],
      );
      for (const r of histR) {
        const bio = normalizeBiomarkerKeys(r.biomarkers || {});
        const bucket = prevHistByPt[r.patient_id] || (prevHistByPt[r.patient_id] = {});
        for (const [k, v] of Object.entries(bio)) {
          if (k.startsWith("_")) continue;
          const n = parseFloat(v);
          if (!isFinite(n)) continue;
          if (bucket[k] == null) bucket[k] = { val: n, date: r.appointment_date };
        }
      }
    } catch {}
  }

  return { labByPt, prevLabByPt, vitalsByPt, prevVitalsByPt, appReadingsByPt, prevHistByPt };
}

export function applyTrendBiomarkers(row, sources) {
  const { labByPt, prevLabByPt, vitalsByPt, prevVitalsByPt, appReadingsByPt, prevHistByPt } =
    sources;
  const labs = labByPt[row.patient_id];
  if (labs) {
    const bio = row.biomarkers || {};
    const dates = bio._lab_dates || {};
    for (const [bioKey, { val, date: d }] of Object.entries(labs)) {
      if (!dates[bioKey] || d >= dates[bioKey]) {
        bio[bioKey] = val;
        if (!bio._lab_dates) bio._lab_dates = {};
        bio._lab_dates[bioKey] = d;
      }
    }
    row.biomarkers = bio;
  }

  const vit = vitalsByPt[row.patient_id];
  if (vit) {
    const bio = row.biomarkers || {};
    if (vit.sbp != null && bio.sbp == null) bio.sbp = vit.sbp;
    if (vit.dbp != null && bio.dbp == null) bio.dbp = vit.dbp;
    if (vit.weight != null && bio.weight == null) bio.weight = vit.weight;
    if (vit.bmi != null && bio.bmi == null) bio.bmi = vit.bmi;
    row.biomarkers = bio;
  }
  row.biomarkers = normalizeBiomarkerKeys(row.biomarkers || {});

  const prevLabs = prevLabByPt[row.patient_id] || {};
  const prevVit = prevVitalsByPt[row.patient_id] || {};
  const prevHist = prevHistByPt[row.patient_id] || {};
  const appReads = appReadingsByPt[row.patient_id] || {};
  const candidates = {};
  const addCand = (k, val, d, priority = 1) => {
    if (val == null || !isFinite(val)) return;
    const list = candidates[k] || (candidates[k] = []);
    list.push({ val, date: d || null, priority });
  };
  for (const [k, { val, date: d }] of Object.entries(prevLabs)) addCand(k, val, d, 1);
  for (const [k, entry] of Object.entries(prevHist)) addCand(k, entry.val, entry.date, 2);
  if (prevVit.sbp != null) addCand("sbp", prevVit.sbp, prevVit.date, 1);
  if (prevVit.dbp != null) addCand("dbp", prevVit.dbp, prevVit.date, 1);
  if (prevVit.weight != null) addCand("weight", prevVit.weight, prevVit.date, 1);
  if (prevVit.bmi != null) addCand("bmi", prevVit.bmi, prevVit.date, 1);
  for (const [k, list] of Object.entries(appReads)) {
    for (const e of list) addCand(k, e.val, e.date, 1);
  }
  const curBio = row.biomarkers || {};
  const prev = {};
  for (const [k, list] of Object.entries(candidates)) {
    const cur = parseFloat(curBio[k]);
    const tiers = [...new Set(list.map((c) => c.priority))].sort((a, b) => a - b);
    for (const tier of tiers) {
      const tierList = list
        .filter((c) => c.priority === tier)
        .sort((x, y) => {
          const dx = x.date ? new Date(x.date).getTime() : 0;
          const dy = y.date ? new Date(y.date).getTime() : 0;
          return dy - dx;
        });
      let picked = null;
      for (const c of tierList) {
        if (isFinite(cur) && c.val === cur) continue;
        picked = c.val;
        break;
      }
      if (picked != null) {
        prev[k] = picked;
        break;
      }
    }
  }
  row.prev_biomarkers = normalizeBiomarkerKeys(prev);
  row.prev_hba1c = prev.hba1c != null ? prev.hba1c : null;
}
