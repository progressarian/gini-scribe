import pool from "../../config/db.js";
import { sortDiagnoses } from "../../utils/diagnosisSort.js";

export const REPORT_CACHE_MS = 5 * 60 * 1000;
const DIAGNOSES_CACHE_MS = 10 * 60 * 1000;
const CACHE_LIMIT = 30;

const DATE_FILTERS = {
  today: "c.visit_date::date = CURRENT_DATE",
  week: "c.visit_date >= CURRENT_DATE - INTERVAL '7 days'",
  month: "c.visit_date >= CURRENT_DATE - INTERVAL '30 days'",
  quarter: "c.visit_date >= CURRENT_DATE - INTERVAL '90 days'",
  year: "c.visit_date >= CURRENT_DATE - INTERVAL '365 days'",
  all: "TRUE",
};

export const REPORT_PERIODS = Object.keys(DATE_FILTERS);
export const BIOMARKER_STATUSES = ["tested", "out_control", "warning", "in_control", "no_data"];

const LAB_TESTS = [
  "HbA1c",
  "FBG",
  "FPG",
  "Fasting Glucose",
  "Fasting Blood Sugar",
  "PP",
  "PP Glucose",
  "Post Prandial",
  "PPG",
  "LDL",
  "LDL-C",
  "LDL Cholesterol",
  "Triglycerides",
  "TG",
  "Non-HDL",
  "Non HDL",
  "NonHDL",
  "eGFR",
  "GFR",
  "UACR",
  "ACR",
  "Microalbumin",
  "Urine ACR",
  "Creatinine",
  "Serum Creatinine",
];

export const TARGETS = [
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

export const BIOMARKER_KEYS = TARGETS.map((t) => t.key);

const STATUS_ORDER = { out_control: 0, warning: 1, in_control: 2, no_data: 3 };

function labKey(testName) {
  const tn = testName.toLowerCase();
  if (tn.includes("a1c") || tn === "hba1c") return "hba1c";
  if (["fbg", "fpg", "fasting glucose", "fasting blood sugar"].includes(tn)) return "fbg";
  if (["pp", "ppg", "pp glucose", "post prandial"].includes(tn)) return "ppg";
  if (["ldl", "ldl-c", "ldl cholesterol"].includes(tn)) return "ldl";
  if (["tg", "triglycerides"].includes(tn)) return "tg";
  if (["non-hdl", "non hdl", "nonhdl"].includes(tn)) return "nonhdl";
  if (["egfr", "gfr"].includes(tn)) return "egfr";
  if (["uacr", "acr", "microalbumin", "urine acr"].includes(tn)) return "uacr";
  if (["creatinine", "serum creatinine"].includes(tn)) return "creatinine";
  return null;
}

function rate(t, bio) {
  if (t.composite && t.key === "bp") {
    if (!(bio.bp_sys && bio.bp_dia)) return { status: "no_data" };
    const display = `${bio.bp_sys}/${bio.bp_dia}`;
    const status = t.good(bio.bp_sys, bio)
      ? "in_control"
      : t.warn(bio.bp_sys, bio)
        ? "warning"
        : "out_control";
    return { value: bio.bp_sys, display, status, tested: true };
  }
  if (t.trend && t.key === "weight") {
    if (!bio.weight) return { status: "no_data" };
    let display = `${bio.weight}kg`;
    if (!bio.prev_weight) return { value: bio.weight, display, status: "no_data", tested: true };
    const diff = bio.weight - bio.prev_weight;
    display += ` (${diff > 0 ? "+" : ""}${diff.toFixed(1)})`;
    const status = diff <= 0 ? "in_control" : diff <= 2 ? "warning" : "out_control";
    return { value: bio.weight, display, status, tested: true };
  }
  const value = bio[t.key];
  if (value === undefined || value === null) return { status: "no_data" };
  const status = t.good(value, bio) ? "in_control" : t.warn(value, bio) ? "warning" : "out_control";
  return { value, display: `${value} ${t.unit}`, status, tested: true };
}

function scoreOf(bio) {
  let met = 0;
  let total = 0;
  const conditions = {};
  for (const t of TARGETS) {
    if (t.trend) continue;
    let val;
    let hasData = false;
    let inCtrl = false;
    if (t.composite && t.key === "bp") {
      if (bio.bp_sys && bio.bp_dia) {
        hasData = true;
        inCtrl = t.good(bio.bp_sys, bio);
        val = `${bio.bp_sys}/${bio.bp_dia}`;
      }
    } else {
      val = bio[t.key];
      if (val !== undefined && val !== null) {
        hasData = true;
        inCtrl = t.good(val, bio);
      }
    }
    if (!hasData) continue;
    total += 1;
    if (inCtrl) met += 1;
    conditions[t.key] = {
      val,
      in_control: inCtrl,
      label: t.label,
      emoji: t.emoji,
      target: t.target,
    };
  }
  return {
    targets_met: met,
    targets_total: total,
    pct: total > 0 ? Math.round((met / total) * 100) : null,
    conditions,
  };
}

async function buildReport(period, doctor, db) {
  const doctorParams = doctor ? [`%${doctor}%`] : [];
  const { rows: patients } = await db.query(
    `SELECT DISTINCT ON (p.id) p.id, p.name, p.age, p.sex, p.file_no, p.phone,
            c.visit_date, c.con_name
       FROM patients p
       JOIN consultations c ON c.patient_id = p.id
      WHERE ${DATE_FILTERS[period]}${doctor ? " AND c.con_name ILIKE $1" : ""}
      ORDER BY p.id, c.visit_date DESC`,
    doctorParams,
  );
  const ids = patients.map((p) => p.id);
  const bio = new Map(ids.map((id) => [id, {}]));
  if (ids.length) {
    const [labs, vitals, prevWeights] = await Promise.all([
      db.query(
        `SELECT DISTINCT ON (patient_id, test_name) patient_id, test_name, result
           FROM lab_results
          WHERE patient_id = ANY($1) AND test_name = ANY($2) AND result IS NOT NULL
          ORDER BY patient_id, test_name, test_date DESC`,
        [ids, LAB_TESTS],
      ),
      db.query(
        `SELECT DISTINCT ON (patient_id) patient_id, bp_sys, bp_dia, bmi, weight
           FROM vitals
          WHERE patient_id = ANY($1) AND (bp_sys IS NOT NULL OR bmi IS NOT NULL OR weight IS NOT NULL)
          ORDER BY patient_id, recorded_at DESC`,
        [ids],
      ),
      db.query(
        `SELECT DISTINCT ON (v.patient_id) v.patient_id, v.weight
           FROM vitals v
           JOIN (SELECT patient_id, MAX(recorded_at) AS latest
                   FROM vitals WHERE patient_id = ANY($1) AND weight IS NOT NULL
                  GROUP BY patient_id) lv
             ON v.patient_id = lv.patient_id AND v.recorded_at < lv.latest
          WHERE v.patient_id = ANY($1) AND v.weight IS NOT NULL
          ORDER BY v.patient_id, v.recorded_at DESC`,
        [ids],
      ),
    ]);
    for (const l of labs.rows) {
      const val = parseFloat(l.result);
      const key = labKey(l.test_name);
      if (!Number.isNaN(val) && key) bio.get(l.patient_id)[key] = val;
    }
    for (const v of vitals.rows) {
      const b = bio.get(v.patient_id);
      if (v.bp_sys) b.bp_sys = parseFloat(v.bp_sys);
      if (v.bp_dia) b.bp_dia = parseFloat(v.bp_dia);
      if (v.bmi) b.bmi = parseFloat(v.bmi);
      if (v.weight) b.weight = parseFloat(v.weight);
    }
    for (const w of prevWeights.rows) bio.get(w.patient_id).prev_weight = parseFloat(w.weight);
  }

  const byDoctor = {};
  for (const p of patients) {
    const d = p.con_name || "Unknown";
    byDoctor[d] = (byDoctor[d] || 0) + 1;
  }

  const biomarkers = TARGETS.map((t) => {
    const counts = { in_control: 0, warning: 0, out_control: 0, no_data: 0 };
    let tested = 0;
    const rated = patients.map((p, index) => {
      const r = rate(t, bio.get(p.id));
      counts[r.status] += 1;
      if (r.tested) tested += 1;
      return { index, ...r };
    });
    rated.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.index - b.index);
    return {
      summary: {
        key: t.key,
        label: t.label,
        target: t.target,
        unit: t.unit,
        emoji: t.emoji,
        ...counts,
        tested,
        total: patients.length,
        pct: tested > 0 ? Math.round((counts.in_control / tested) * 100) : null,
      },
      rated,
    };
  });

  const scorecard = patients
    .map((p, index) => ({ index, ...scoreOf(bio.get(p.id)) }))
    .sort((a, b) => (a.pct === null ? 999 : a.pct) - (b.pct === null ? 999 : b.pct));

  return { period, doctor, builtAt: new Date().toISOString(), patients, bio, byDoctor, biomarkers, scorecard };
}

const cache = new Map();

function remember(key, ttl, build, { fresh = false } = {}) {
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < ttl) return hit.promise;
  const promise = build().catch((error) => {
    if (cache.get(key)?.promise === promise) cache.delete(key);
    throw error;
  });
  cache.set(key, { at: Date.now(), promise });
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  return promise;
}

export const clearClinicalReportCache = () => cache.clear();

const reportFor = ({ period = "today", doctor = "", fresh = false }, db) =>
  remember(`report|${period}|${doctor}`, REPORT_CACHE_MS, () => buildReport(period, doctor, db), {
    fresh,
  });

export async function getReportSummary(filters, db = pool) {
  const report = await reportFor(filters, db);
  return {
    total: report.patients.length,
    by_doctor: report.byDoctor,
    biomarkers: report.biomarkers.map((b) => b.summary),
    built_at: report.builtAt,
  };
}

const matches = (patient, q) => {
  if (!q) return true;
  const term = q.toLowerCase();
  return (
    String(patient.name || "")
      .toLowerCase()
      .includes(term) ||
    String(patient.file_no || "")
      .toLowerCase()
      .includes(term)
  );
};

const page = (rows, { page: number = 1, limit = 25 }) => {
  const size = Math.min(100, limit);
  const start = (number - 1) * size;
  return {
    rows: rows.slice(start, start + size),
    total: rows.length,
    page: number,
    limit: size,
    totalPages: Math.ceil(rows.length / size),
  };
};

const person = (p) => ({
  id: p.id,
  name: p.name,
  age: p.age,
  sex: p.sex,
  file_no: p.file_no,
  con_name: p.con_name,
  visit_date: p.visit_date,
});

export async function getBiomarkerPatients(key, filters, db = pool) {
  const report = await reportFor(filters, db);
  const entry = report.biomarkers.find((b) => b.summary.key === key);
  const status = filters.status || "tested";
  const wanted = entry.rated.filter(
    (r) =>
      (status === "tested" ? r.status !== "no_data" : r.status === status) &&
      matches(report.patients[r.index], filters.q),
  );
  const { rows, ...meta } = page(wanted, filters);
  return {
    ...meta,
    data: rows.map((r) => ({
      ...person(report.patients[r.index]),
      value: r.value,
      display: r.display,
      status: r.status,
    })),
  };
}

async function diagnosesFor(ids, db) {
  if (!ids.length) return new Map();
  const { rows } = await db.query(
    `SELECT DISTINCT ON (patient_id, diagnosis_id) patient_id, diagnosis_id AS id, label, status
       FROM diagnoses
      WHERE patient_id = ANY($1) AND is_active = true
      ORDER BY patient_id, diagnosis_id, created_at DESC`,
    [ids],
  );
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.patient_id)) map.set(r.patient_id, []);
    map.get(r.patient_id).push({ label: r.label, status: r.status, id: r.id });
  }
  return map;
}

export async function getScorecard(filters, db = pool) {
  const report = await reportFor(filters, db);
  const wanted = report.scorecard.filter((s) => matches(report.patients[s.index], filters.q));
  const { rows, ...meta } = page(wanted, filters);
  const dx = await diagnosesFor(
    rows.map((s) => report.patients[s.index].id),
    db,
  );
  return {
    ...meta,
    data: rows.map(({ index, ...score }) => {
      const p = report.patients[index];
      return {
        ...person(p),
        ...score,
        diagnoses: sortDiagnoses(dx.get(p.id) || []),
      };
    }),
  };
}

async function buildDiagnoses(db) {
  const { rows } = await db.query(`
    WITH latest AS (
      SELECT DISTINCT ON (patient_id, diagnosis_id) patient_id, diagnosis_id, label, status
        FROM diagnoses WHERE is_active = true
       ORDER BY patient_id, diagnosis_id, created_at DESC
    )
    SELECT diagnosis_id AS id, (array_agg(label ORDER BY label))[1] AS label, status,
           COUNT(DISTINCT patient_id) AS patient_count
      FROM latest
     GROUP BY diagnosis_id, status`);
  const map = {};
  for (const r of rows) {
    if (!map[r.id]) {
      map[r.id] = { id: r.id, label: r.label, total: 0, controlled: 0, uncontrolled: 0, present: 0 };
    }
    const cnt = parseInt(r.patient_count, 10);
    map[r.id].total += cnt;
    if (r.status === "Controlled") map[r.id].controlled += cnt;
    else if (r.status === "Uncontrolled") map[r.id].uncontrolled += cnt;
    else map[r.id].present += cnt;
  }
  return Object.values(map).sort((a, b) => b.total - a.total);
}

export async function getDiagnosisDistribution({ limit = 12, fresh = false } = {}, db = pool) {
  const all = await remember("diagnoses", DIAGNOSES_CACHE_MS, () => buildDiagnoses(db), { fresh });
  return all.slice(0, Math.min(100, limit));
}

export async function getDoctorStats({ fresh = false } = {}, db = pool) {
  return remember(
    "doctors",
    REPORT_CACHE_MS,
    async () =>
      (
        await db.query(`
          SELECT c.con_name AS doctor,
            COUNT(DISTINCT c.patient_id) AS total_patients,
            COUNT(DISTINCT c.id) AS total_visits,
            COUNT(DISTINCT CASE WHEN c.visit_date::date = CURRENT_DATE THEN c.patient_id END) AS today,
            COUNT(DISTINCT CASE WHEN c.visit_date >= CURRENT_DATE - INTERVAL '7 days' THEN c.patient_id END) AS this_week,
            COUNT(DISTINCT CASE WHEN c.visit_date >= CURRENT_DATE - INTERVAL '30 days' THEN c.patient_id END) AS this_month
          FROM consultations c
          WHERE c.con_name IS NOT NULL AND c.con_name != ''
          GROUP BY c.con_name
          ORDER BY total_patients DESC`)
      ).rows,
    { fresh },
  );
}
