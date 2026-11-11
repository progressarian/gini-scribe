import { normalizeDrug, isInsulinIcodec } from "./drugNormalizer.js";
import { mean, median, pct, round, stdDev } from "./stats.js";

export const DM_PERIOD = { start: "2021-11-14", end: "2026-10-31" };

export const DM_WINDOWS = [
  { key: "m3", months: 3, label: "3 months", minDays: 60, maxDays: 150, targetDays: 90 },
  { key: "m6", months: 6, label: "6 months", minDays: 151, maxDays: 270, targetDays: 180 },
  { key: "m12", months: 12, label: "12 months", minDays: 271, maxDays: 450, targetDays: 365 },
  { key: "m24", months: 24, label: "24 months", minDays: 630, maxDays: 810, targetDays: 730 },
  { key: "m36", months: 36, label: "36 months", minDays: 990, maxDays: 1170, targetDays: 1095 },
];

export const DM_BASELINE = { beforeDays: 180, afterDays: 14 };

export const SEVERITY_BANDS = [
  { key: "lt7", label: "Below 7%", min: 0, max: 7 },
  { key: "7_8", label: "7.0–7.9%", min: 7, max: 8 },
  { key: "8_9", label: "8.0–8.9%", min: 8, max: 9 },
  { key: "9_10", label: "9.0–9.9%", min: 9, max: 10 },
  { key: "ge10", label: "10% or above", min: 10, max: 99 },
];

const ENGAGEMENT = { activeDays: 180, overdueDays: 365 };
const LATEST_CONTROL_LOOKBACK_DAYS = 365;

const MARKER_SPECS = {
  hba1c: { canonical: ["HbA1c"], min: 3, max: 20 },
  ldl: { canonical: ["LDL"], min: 10, max: 400 },
  egfr: { canonical: ["eGFR"], min: 1, max: 200 },
  uacr: { canonical: ["UACR"], min: 0, max: 5000 },
  sbp: { canonical: ["BP (mmHg)", "Systolic BP"], vitals: "bp_sys", min: 70, max: 260 },
  dbp: { canonical: ["Diastolic BP"], vitals: "bp_dia", min: 40, max: 160 },
  weight: { canonical: ["Weight"], vitals: "weight", min: 25, max: 300 },
  bmi: { canonical: ["BMI"], vitals: "bmi", min: 10, max: 80 },
};

export const LAB_CONFIRMED_SOURCES = [
  "lab_healthray",
  "lab",
  "report_extract",
  "import",
  "vendor_import",
  "vendor_import_2",
  "vendor_import_3",
  "baseline_table",
  "vitals_sheet",
];

export const DM_SLUG =
  "^(type_?[12]_?(diabetes(_mellitus)?|dm)|dm[12]|t[12]dm|diabetes(_mellitus)?|lada|early_onset_(type_2_dm|t2dm|type_2_diabetes_mellitus)|young_type_2_dm|type_1b_dm|mody|type_3c_dm|pancreatogenous_diabetes(_type_3c)?|nadm)$";

const TYPE_RULES = [
  { type: "Type 1 / LADA", pattern: /^(type_?1|dm1|t1dm|lada|type_1b)/ },
  { type: "Type 2", pattern: /^(type_?2|dm2|t2dm|early_onset|young_type_2)/ },
  { type: "Other specified", pattern: /^(mody|type_3c|pancreatogenous|nadm)/ },
];

const VISIT_STATUSES = ["seen", "completed", "checkedin"];

export const addDays = (date, days) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

export const dayDiff = (from, to) =>
  Math.round(
    (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86400000,
  );

async function loadRegistry(db, period) {
  const { rows } = await db.query(
    `WITH dx AS (
       SELECT patient_id, array_agg(DISTINCT diagnosis_id) AS slugs
         FROM diagnoses WHERE is_active AND diagnosis_id ~ $3 GROUP BY patient_id
     ),
     high AS (
       SELECT patient_id FROM lab_results
        WHERE canonical_name = 'HbA1c' AND result BETWEEN 6.5 AND 20
          AND test_date IS NOT NULL AND to_char(test_date, 'MM-DD') <> '01-01'
          AND test_date <= $2::date
        GROUP BY patient_id
       HAVING COUNT(DISTINCT test_date) >= 2
          AND (COUNT(DISTINCT result) >= 2 OR bool_or(source = ANY($5::text[])))
     ),
     members AS (
       SELECT patient_id FROM dx UNION SELECT patient_id FROM high
     ),
     visits AS (
       SELECT patient_id, visit_date AS d FROM consultations
        WHERE visit_date BETWEEN $1::date AND $2::date AND patient_id IN (SELECT patient_id FROM members)
       UNION
       SELECT patient_id, appointment_date FROM appointments
        WHERE appointment_date BETWEEN $1::date AND $2::date AND status = ANY($4::text[])
          AND patient_id IN (SELECT patient_id FROM members)
     ),
     visit_list AS (
       SELECT patient_id, array_agg(d::text ORDER BY d) AS visits FROM visits GROUP BY patient_id
     )
     SELECT p.id AS patient_id, p.sex, p.dob::text AS dob, p.age AS stored_age,
            CASE WHEN p.dob IS NOT NULL THEN md5(lower(trim(p.name)) || p.dob::text) END AS person_key,
            dx.slugs, (dx.patient_id IS NOT NULL) AS has_dx, v.visits
       FROM members m
       JOIN patients p ON p.id = m.patient_id
       JOIN visit_list v ON v.patient_id = m.patient_id
       LEFT JOIN dx ON dx.patient_id = m.patient_id`,
    [period.start, period.end, DM_SLUG, VISIT_STATUSES, LAB_CONFIRMED_SOURCES],
  );
  return rows;
}

async function loadReadings(db, patientIds, period) {
  const parts = [];
  const params = [patientIds, period.end];
  for (const [marker, spec] of Object.entries(MARKER_SPECS)) {
    params.push(marker, spec.canonical, spec.min, spec.max);
    const i = params.length;
    parts.push(`SELECT patient_id, $${i - 3}::text AS marker, test_date AS d, result::float8 AS val,
                       COALESCE(source, 'unknown') AS src
                  FROM lab_results
                 WHERE patient_id = ANY($1::int[]) AND canonical_name = ANY($${i - 2}::text[])
                   AND result::float8 BETWEEN $${i - 1} AND $${i}
                   AND test_date IS NOT NULL AND test_date <= $2::date`);
    if (spec.vitals) {
      parts.push(`SELECT patient_id, $${i - 3}::text, recorded_at::date, ${spec.vitals}::float8, 'vitals'
                    FROM vitals
                   WHERE patient_id = ANY($1::int[]) AND ${spec.vitals} IS NOT NULL
                     AND ${spec.vitals}::float8 BETWEEN $${i - 1} AND $${i}
                     AND recorded_at IS NOT NULL AND recorded_at::date <= $2::date`);
    }
  }
  const { rows } = await db.query(
    `SELECT patient_id, marker, d::text AS d, val, src FROM (${parts.join(" UNION ALL ")}) r
      WHERE d >= '2015-01-01'`,
    params,
  );
  return rows;
}

async function loadComplications(db, patientIds) {
  const { rows } = await db.query(
    `SELECT patient_id, array_agg(DISTINCT diagnosis_id) AS slugs
       FROM diagnoses WHERE is_active AND patient_id = ANY($1::int[]) GROUP BY patient_id`,
    [patientIds],
  );
  return rows;
}

const COMPLICATIONS = [
  {
    key: "nephropathy",
    label: "Kidney disease / nephropathy",
    pattern: /(nephropathy|^ckd|chronic_kidney|albuminuria|esrd|renal_failure|diabetic_kidney)/,
  },
  { key: "neuropathy", label: "Neuropathy", pattern: /neuropathy/ },
  { key: "retinopathy", label: "Retinopathy", pattern: /retinopathy/ },
  { key: "foot", label: "Diabetic foot / ulcer", pattern: /(diabetic_foot|foot_ulcer|charcot)/ },
  {
    key: "cad",
    label: "Coronary artery disease",
    pattern: /(coronary|^cad$|^ihd$|myocardial_infarction|angina)/,
  },
  { key: "stroke", label: "Stroke / CVA", pattern: /(^cva$|stroke|cerebrovascular)/ },
  {
    key: "pvd",
    label: "Peripheral vascular disease",
    pattern: /(peripheral_vascular|^pvd$|peripheral_arterial)/,
  },
];
const NEGATIVE_FINDING = /^(eu|normo|non_|no_)|_(absent|resolved|screened|negative)$/;

function complicationProfile(people, rows, personOf) {
  const byPerson = new Map();
  for (const r of rows) {
    const person = personOf.get(r.patient_id);
    if (person == null) continue;
    const set = byPerson.get(person) || new Set();
    for (const slug of r.slugs) {
      if (NEGATIVE_FINDING.test(slug)) continue;
      for (const c of COMPLICATIONS) if (c.pattern.test(slug)) set.add(c.key);
    }
    byPerson.set(person, set);
  }
  const has = (p, key) => byPerson.get(p.id)?.has(key) ?? false;
  return {
    population: people.length,
    rows: COMPLICATIONS.map((c) => ({
      key: c.key,
      label: c.label,
      ...share(people.filter((p) => has(p, c.key)).length, people.length),
    })),
    any_microvascular: share(
      people.filter((p) => ["nephropathy", "neuropathy", "retinopathy"].some((k) => has(p, k)))
        .length,
      people.length,
    ),
    any_macrovascular: share(
      people.filter((p) => ["cad", "stroke", "pvd"].some((k) => has(p, k))).length,
      people.length,
    ),
  };
}

const UACR_STAGE = (v) => (v < 30 ? 1 : v <= 300 ? 2 : 3);

function kidneyOutcomes(people, end) {
  const out = {};
  for (const wk of ["m12", "m24"]) {
    const uacr = markerPairs(people, "uacr", end, wk);
    const egfr = markerPairs(people, "egfr", end, wk);
    const moved = uacr.pairs.map((x) => UACR_STAGE(x.follow) - UACR_STAGE(x.baseline));
    const albuminuric = uacr.pairs.filter((x) => x.baseline >= 30);
    out[wk] = {
      uacr: {
        eligible: uacr.eligible,
        with_baseline: uacr.with_baseline,
        measured: share(uacr.pairs.length, uacr.with_baseline),
        median_baseline: round(median(uacr.pairs.map((x) => x.baseline)), 1),
        median_follow: round(median(uacr.pairs.map((x) => x.follow)), 1),
        stage_better: share(moved.filter((m) => m < 0).length, moved.length),
        stage_same: share(moved.filter((m) => m === 0).length, moved.length),
        stage_worse: share(moved.filter((m) => m > 0).length, moved.length),
        albuminuric_fell_30pct: share(
          albuminuric.filter((x) => x.follow <= x.baseline * 0.7).length,
          albuminuric.length,
        ),
      },
      egfr: {
        eligible: egfr.eligible,
        with_baseline: egfr.with_baseline,
        measured: share(egfr.pairs.length, egfr.with_baseline),
        median_baseline: round(median(egfr.pairs.map((x) => x.baseline)), 0),
        median_follow: round(median(egfr.pairs.map((x) => x.follow)), 0),
        median_change: round(median(egfr.pairs.map((x) => x.follow - x.baseline)), 1),
        fell_30pct: share(
          egfr.pairs.filter((x) => x.follow <= x.baseline * 0.7).length,
          egfr.pairs.length,
        ),
      },
    };
  }
  return out;
}

function bpOn(p, date, pick) {
  const sbp = pick(p.series.get("sbp"), date);
  if (!sbp) return null;
  const dbp = (p.series.get("dbp") || []).find((r) => r.d === sbp.d);
  return dbp ? { sbp: sbp.val, dbp: dbp.val } : null;
}

function combinedControlChange(people, end, windowKey) {
  const w = DM_WINDOWS.find((x) => x.key === windowKey);
  const atTarget = (a1c, bp, ldl) => a1c < 7 && bp.sbp < 130 && bp.dbp < 80 && ldl < 100;
  let complete = 0;
  let before = 0;
  let after = 0;
  const eligible = people.filter((p) => isEligible(p.index_date, w, end));
  for (const p of eligible) {
    const a0 = pickBaseline(p.series.get("hba1c"), p.index_date);
    const l0 = pickBaseline(p.series.get("ldl"), p.index_date);
    const b0 = bpOn(p, p.index_date, pickBaseline);
    const a1 = pickFollowUp(p.series.get("hba1c"), p.index_date, w);
    const l1 = pickFollowUp(p.series.get("ldl"), p.index_date, w);
    const b1 = bpOn(p, p.index_date, (series, d) => pickFollowUp(series, d, w));
    if (!a0 || !l0 || !b0 || !a1 || !l1 || !b1) continue;
    complete += 1;
    if (atTarget(a0.val, b0, l0.val)) before += 1;
    if (atTarget(a1.val, b1, l1.val)) after += 1;
  }
  return {
    window: windowKey,
    eligible: eligible.length,
    complete_pairs: complete,
    all_three_at_baseline: share(before, complete),
    all_three_at_follow_up: share(after, complete),
  };
}

const DIABETES_DRUG_CLASSES = [
  "biguanide",
  "sulfonylurea",
  "dpp4i",
  "sglt2i",
  "glp1",
  "insulin",
  "tzd",
  "agi",
];

const NEW_PATIENT_LEEWAY_DAYS = 30;

async function loadNewPatientVisits(db, patientIds, period) {
  const wanted = new Set(patientIds);
  const { rows } = await db.query(
    `SELECT patient_id, MIN(appointment_date)::text AS d FROM appointments
      WHERE visit_type = 'New Patient' AND status = ANY($1::text[])
        AND appointment_date BETWEEN $2::date AND $3::date
      GROUP BY patient_id`,
    [VISIT_STATUSES, period.start, period.end],
  );
  return new Map(rows.filter((r) => wanted.has(r.patient_id)).map((r) => [r.patient_id, r.d]));
}

async function loadMedications(db, patientIds, period) {
  const { rows } = await db.query(
    `SELECT patient_id, name, composition, pharmacy_match, drug_class, dose, frequency,
            started_date::text AS started_date, last_prescribed_date::text AS last_prescribed_date,
            created_at::date::text AS created_on
       FROM medications
      WHERE patient_id = ANY($1::int[]) AND (started_date IS NULL OR started_date <= $2::date)`,
    [patientIds, period.end],
  );
  return rows;
}

function diabetesType(slugs) {
  if (!slugs || !slugs.length) return "Unspecified";
  for (const rule of TYPE_RULES) if (slugs.some((s) => rule.pattern.test(s))) return rule.type;
  return "Unspecified";
}

function normalizeSex(sex) {
  const s = (sex || "").toLowerCase();
  if (s.startsWith("m")) return "Male";
  if (s.startsWith("f")) return "Female";
  return "Unspecified";
}

function mergePersons(rows) {
  const persons = new Map();
  let merged = 0;
  for (const r of rows) {
    const key = r.person_key || `id:${r.patient_id}`;
    const existing = persons.get(key);
    if (existing) {
      merged += 1;
      existing.patient_ids.push(r.patient_id);
      existing.visits = [...new Set([...existing.visits, ...r.visits])].sort();
      existing.slugs = [...new Set([...(existing.slugs || []), ...(r.slugs || [])])];
      existing.has_dx = existing.has_dx || r.has_dx;
      continue;
    }
    persons.set(key, { ...r, patient_ids: [r.patient_id], slugs: r.slugs || [] });
  }
  return { persons: [...persons.values()], merged };
}

function cleanReadings(raw, personOf) {
  const byPerson = new Map();
  const labSet = new Set(LAB_CONFIRMED_SOURCES);
  const sorted = raw
    .map((r) => ({ ...r, person: personOf.get(r.patient_id) }))
    .filter((r) => r.person != null)
    .sort((a, b) => a.d.localeCompare(b.d));
  const seenValues = new Map();
  const dropped = { placeholder_date: 0, repeated_copy: 0, carried_forward: 0 };
  const lastVitals = new Map();
  for (const r of sorted) {
    if (r.marker === "hba1c" && r.d.slice(5) === "01-01") {
      dropped.placeholder_date += 1;
      continue;
    }
    const lab = labSet.has(r.src);
    const valueKey = `${r.person}|${r.marker}|${r.val}`;
    const firstSeen = seenValues.get(valueKey);
    if (!lab && r.src !== "vitals" && firstSeen && firstSeen < r.d) {
      dropped.repeated_copy += 1;
      continue;
    }
    if (!firstSeen) seenValues.set(valueKey, r.d);
    if (r.src === "vitals" && (r.marker === "weight" || r.marker === "bmi")) {
      const lastKey = `${r.person}|${r.marker}`;
      const prev = lastVitals.get(lastKey);
      lastVitals.set(lastKey, { d: r.d, val: r.val });
      if (prev && prev.d !== r.d && prev.val === r.val) {
        dropped.carried_forward += 1;
        continue;
      }
    }
    const perPerson = byPerson.get(r.person) || new Map();
    const series = perPerson.get(r.marker) || new Map();
    const day = series.get(r.d);
    if (!day) series.set(r.d, { d: r.d, val: r.val, lab, labVal: lab ? r.val : null });
    else {
      if (lab && (day.labVal == null || r.val > day.labVal)) day.labVal = r.val;
      day.lab = day.lab || lab;
      day.val = day.labVal ?? Math.max(day.val, r.val);
    }
    perPerson.set(r.marker, series);
    byPerson.set(r.person, perPerson);
  }
  const out = new Map();
  for (const [person, markers] of byPerson) {
    const m = new Map();
    for (const [marker, series] of markers) {
      m.set(
        marker,
        [...series.values()].sort((a, b) => a.d.localeCompare(b.d)),
      );
    }
    out.set(person, m);
  }
  return { series: out, dropped };
}

export function pickBaseline(series, indexDate, { labOnly = false } = {}) {
  let best = null;
  for (const r of series || []) {
    if (labOnly && !r.lab) continue;
    const diff = dayDiff(indexDate, r.d);
    if (diff < -DM_BASELINE.beforeDays || diff > DM_BASELINE.afterDays) continue;
    const dist = Math.abs(diff);
    if (!best || dist < best.dist || (dist === best.dist && r.d < best.r.d)) best = { r, dist };
  }
  return best ? best.r : null;
}

export function pickFollowUp(series, indexDate, window, { labOnly = false } = {}) {
  let best = null;
  for (const r of series || []) {
    if (labOnly && !r.lab) continue;
    const diff = dayDiff(indexDate, r.d);
    if (diff < window.minDays || diff > window.maxDays) continue;
    const dist = Math.abs(diff - window.targetDays);
    if (!best || dist < best.dist || (dist === best.dist && r.d > best.r.d)) best = { r, dist };
  }
  return best ? best.r : null;
}

export const isEligible = (indexDate, window, end) => addDays(indexDate, window.maxDays) <= end;

const wilson = (n, d) => {
  if (!d) return null;
  const z = 1.96;
  const p = n / d;
  const centre = (p + (z * z) / (2 * d)) / (1 + (z * z) / d);
  const half = (z * Math.sqrt((p * (1 - p)) / d + (z * z) / (4 * d * d))) / (1 + (z * z) / d);
  return [round((centre - half) * 100, 1), round((centre + half) * 100, 1)];
};

const share = (n, d) => ({ n, d, pct: pct(n, d), ci95: wilson(n, d) });

const meanCi = (xs) => {
  if (xs.length < 2) return null;
  const half = (1.96 * stdDev(xs)) / Math.sqrt(xs.length);
  const m = mean(xs);
  return [round(m - half, 2), round(m + half, 2)];
};

function severityOf(value) {
  return SEVERITY_BANDS.find((b) => value >= b.min && value < b.max)?.key ?? null;
}

function ageAt(dob, date, stored) {
  if (!dob) return stored ?? null;
  const b = new Date(`${dob}T00:00:00Z`);
  const t = new Date(`${date}T00:00:00Z`);
  let age = t.getUTCFullYear() - b.getUTCFullYear();
  if (
    t.getUTCMonth() < b.getUTCMonth() ||
    (t.getUTCMonth() === b.getUTCMonth() && t.getUTCDate() < b.getUTCDate())
  )
    age -= 1;
  return age >= 0 && age < 120 ? age : null;
}

export function summarisePairs(pairs) {
  const base = pairs.map((p) => p.baseline);
  const follow = pairs.map((p) => p.follow);
  const change = pairs.map((p) => round(p.follow - p.baseline, 2));
  const above = pairs.filter((p) => p.baseline >= 7);
  const below = pairs.filter((p) => p.baseline < 7);
  return {
    n: pairs.length,
    baseline_mean: round(mean(base), 2),
    baseline_median: round(median(base), 2),
    follow_mean: round(mean(follow), 2),
    follow_median: round(median(follow), 2),
    change_mean: round(mean(change), 2),
    change_median: round(median(change), 2),
    change_ci95: meanCi(change),
    any_improvement: share(change.filter((c) => c < 0).length, pairs.length),
    improved_05: share(change.filter((c) => c <= -0.5).length, pairs.length),
    improved_10: share(change.filter((c) => c <= -1.0).length, pairs.length),
    worsened_05: share(change.filter((c) => c >= 0.5).length, pairs.length),
    below7_at_follow: share(pairs.filter((p) => p.follow < 7).length, pairs.length),
    reached_below7: share(above.filter((p) => p.follow < 7).length, above.length),
    maintained_below7: share(below.filter((p) => p.follow < 7).length, below.length),
  };
}

function summariseChange(pairs, decimals = 1) {
  const change = pairs.map((p) => p.follow - p.baseline);
  return {
    n: pairs.length,
    baseline_mean: round(mean(pairs.map((p) => p.baseline)), decimals),
    follow_mean: round(mean(pairs.map((p) => p.follow)), decimals),
    change_mean: round(mean(change), decimals),
    change_median: round(median(change), decimals),
    pct_change_mean: round(mean(pairs.map((p) => ((p.follow - p.baseline) / p.baseline) * 100)), 1),
  };
}

function hba1cWindowTable(people, end, { labOnly = false, filter = () => true } = {}) {
  return DM_WINDOWS.map((w) => {
    const eligible = people.filter((p) => filter(p) && isEligible(p.index_date, w, end));
    const withBaseline = [];
    const pairs = [];
    for (const p of eligible) {
      const series = p.series.get("hba1c");
      const base = pickBaseline(series, p.index_date, { labOnly });
      if (!base) continue;
      withBaseline.push(p);
      const follow = pickFollowUp(series, p.index_date, w, { labOnly });
      if (follow)
        pairs.push({
          person: p,
          baseline: base.val,
          follow: follow.val,
          days: dayDiff(p.index_date, follow.d),
        });
    }
    const bySeverity = SEVERITY_BANDS.map((b) => ({
      band: b.label,
      key: b.key,
      ...summarisePairs(pairs.filter((x) => severityOf(x.baseline) === b.key)),
    }));
    return {
      window: w.key,
      label: w.label,
      measurement_range_days: [w.minDays, w.maxDays],
      eligible: eligible.length,
      with_baseline: withBaseline.length,
      measured: share(pairs.length, withBaseline.length),
      missing: share(withBaseline.length - pairs.length, withBaseline.length),
      median_days_to_followup: round(median(pairs.map((x) => x.days)), 0),
      outcome: summarisePairs(pairs),
      by_severity: bySeverity,
      pairs,
    };
  });
}

function markerPairs(people, marker, end, windowKey, indexOf = (p) => p.index_date) {
  const w = DM_WINDOWS.find((x) => x.key === windowKey);
  const eligible = people.filter((p) => indexOf(p) && isEligible(indexOf(p), w, end));
  const pairs = [];
  let withBaseline = 0;
  for (const p of eligible) {
    const series = p.series.get(marker);
    const base = pickBaseline(series, indexOf(p));
    if (!base) continue;
    withBaseline += 1;
    const follow = pickFollowUp(series, indexOf(p), w);
    if (follow) pairs.push({ baseline: base.val, follow: follow.val });
  }
  return { eligible: eligible.length, with_baseline: withBaseline, pairs };
}

function latestWithin(series, from, to) {
  let hit = null;
  for (const r of series || []) if (r.d >= from && r.d <= to) hit = r;
  return hit;
}

function latestControl(people) {
  let complete = 0;
  const counts = { a1c: 0, bp: 0, bp140: 0, ldl100: 0, ldl70: 0, all3: 0, all3_lenient: 0 };
  const each = { a1c: [0, 0], bp: [0, 0], ldl: [0, 0] };
  for (const p of people) {
    const to = p.last_visit;
    const from = addDays(to, -LATEST_CONTROL_LOOKBACK_DAYS);
    const a1c = latestWithin(p.series.get("hba1c"), from, to);
    const sbpSeries = p.series.get("sbp") || [];
    const dbpByDay = new Map((p.series.get("dbp") || []).map((r) => [r.d, r.val]));
    let bp = null;
    for (const r of sbpSeries)
      if (r.d >= from && r.d <= to && dbpByDay.has(r.d))
        bp = { sbp: r.val, dbp: dbpByDay.get(r.d) };
    const ldl = latestWithin(p.series.get("ldl"), from, to);
    if (a1c) {
      each.a1c[1] += 1;
      if (a1c.val < 7) each.a1c[0] += 1;
    }
    if (bp) {
      each.bp[1] += 1;
      if (bp.sbp < 130 && bp.dbp < 80) each.bp[0] += 1;
    }
    if (ldl) {
      each.ldl[1] += 1;
      if (ldl.val < 100) each.ldl[0] += 1;
    }
    if (!a1c || !bp || !ldl) continue;
    complete += 1;
    const a = a1c.val < 7;
    const b = bp.sbp < 130 && bp.dbp < 80;
    const b140 = bp.sbp < 140 && bp.dbp < 90;
    const l = ldl.val < 100;
    if (a) counts.a1c += 1;
    if (b) counts.bp += 1;
    if (b140) counts.bp140 += 1;
    if (l) counts.ldl100 += 1;
    if (ldl.val < 70) counts.ldl70 += 1;
    if (a && b && l) counts.all3 += 1;
    if (a && b140 && l) counts.all3_lenient += 1;
  }
  return {
    population: people.length,
    complete: share(complete, people.length),
    among_complete: {
      hba1c_below7: share(counts.a1c, complete),
      bp_below_130_80: share(counts.bp, complete),
      bp_below_140_90: share(counts.bp140, complete),
      ldl_below100: share(counts.ldl100, complete),
      ldl_below70: share(counts.ldl70, complete),
      all_three: share(counts.all3, complete),
      all_three_bp140: share(counts.all3_lenient, complete),
    },
    each_marker: {
      hba1c_below7: share(...each.a1c),
      bp_below_130_80: share(...each.bp),
      ldl_below100: share(...each.ldl),
    },
  };
}

function engagementStatus(p, end) {
  const days = dayDiff(p.last_visit, end);
  if (days <= ENGAGEMENT.activeDays) return "active";
  if (days <= ENGAGEMENT.overdueDays) return "overdue";
  return "long_gap";
}

function retention(people, end) {
  const years = [...new Set(people.map((p) => p.index_date.slice(0, 4)))].sort();
  const windows = DM_WINDOWS.filter((w) => w.months <= 24);
  return years.map((year) => {
    const cohort = people.filter((p) => p.index_date.startsWith(year));
    const row = { enrollment_year: year, enrolled: cohort.length };
    for (const w of windows) {
      const eligible = cohort.filter((p) => isEligible(p.index_date, w, end));
      const engaged = eligible.filter((p) =>
        p.visits.some((v) => {
          const d = dayDiff(p.index_date, v);
          return d >= w.minDays && d <= w.maxDays;
        }),
      );
      const stillSeen = eligible.filter((p) => dayDiff(p.index_date, p.last_visit) >= w.minDays);
      row[w.key] = {
        visit_in_window: share(engaged.length, eligible.length),
        seen_on_or_after: share(stillSeen.length, eligible.length),
      };
    }
    return row;
  });
}

function baselineComparison(windowRow) {
  const measuredIds = new Set(windowRow.pairs.map((x) => x.person.id));
  const groups = { measured: [], not_measured: [] };
  for (const p of windowRow._withBaseline)
    (measuredIds.has(p.id) ? groups.measured : groups.not_measured).push(p);
  const profile = (list) => ({
    n: list.length,
    mean_age: round(mean(list.map((p) => p.age).filter((a) => a != null)), 1),
    female: share(list.filter((p) => p.sex === "Female").length, list.length),
    mean_baseline_hba1c: round(mean(list.map((p) => p._baseline)), 2),
    median_visits: median(list.map((p) => p.visits.length)),
    type1: share(list.filter((p) => p.dm_type === "Type 1 / LADA").length, list.length),
  });
  return { measured: profile(groups.measured), not_measured: profile(groups.not_measured) };
}

const TREATMENT_COHORTS = [
  {
    key: "glp1",
    label: "GLP-1 receptor agonist (excl. tirzepatide)",
    match: (r) => r.isIncretin && r.molecule !== "tirzepatide",
  },
  {
    key: "tirzepatide",
    label: "Tirzepatide (GLP-1/GIP)",
    match: (r) => r.molecule === "tirzepatide",
  },
  { key: "any_incretin", label: "Any GLP-1 or tirzepatide", match: (r) => r.isIncretin },
  {
    key: "weekly_insulin",
    label: "Weekly insulin (icodec)",
    match: (r, med) => isInsulinIcodec(med),
  },
  {
    key: "daily_insulin",
    label: "Daily insulin",
    match: (r, med) => r.classes.includes("insulin") && !isInsulinIcodec(med),
  },
];

function treatmentStarts(meds, personOf, period) {
  const starts = new Map();
  for (const med of meds) {
    const person = personOf.get(med.patient_id);
    if (person == null) continue;
    const resolved = normalizeDrug(med);
    const date = med.started_date || med.last_prescribed_date || med.created_on;
    if (!date || date > period.end) continue;
    for (const c of TREATMENT_COHORTS) {
      if (!c.match(resolved, med)) continue;
      const key = `${c.key}|${person}`;
      const prev = starts.get(key);
      if (!prev || date < prev) starts.set(key, date);
    }
  }
  return starts;
}

const NEW_START_DAYS = 30;

function treatmentOutcomes(people, starts, period) {
  return TREATMENT_COHORTS.map((c) => {
    const members = people
      .filter((p) => starts.has(`${c.key}|${p.id}`))
      .map((p) => ({ ...p, drug_index: starts.get(`${c.key}|${p.id}`) }));
    const inPeriod = members.filter((p) => p.drug_index >= period.start);
    const newStarts = inPeriod.filter((p) => dayDiff(p.index_date, p.drug_index) >= NEW_START_DAYS);
    const baselines = inPeriod
      .map((p) => pickBaseline(p.series.get("hba1c"), p.drug_index))
      .filter(Boolean)
      .map((r) => r.val);
    const result = {
      key: c.key,
      label: c.label,
      patients: members.length,
      started_in_period: inPeriod.length,
      new_starts: newStarts.length,
      first_start: inPeriod.map((p) => p.drug_index).sort()[0] ?? null,
      baseline_hba1c: {
        n: baselines.length,
        mean: round(mean(baselines), 2),
        median: round(median(baselines), 2),
      },
    };
    result.new_start = {};
    for (const wk of ["m3", "m6", "m12"]) {
      const a = markerPairs(newStarts, "hba1c", period.end, wk, (p) => p.drug_index);
      const wt = markerPairs(newStarts, "weight", period.end, wk, (p) => p.drug_index);
      result.new_start[wk] = {
        hba1c: {
          eligible: a.eligible,
          with_baseline: a.with_baseline,
          measured: share(a.pairs.length, a.with_baseline),
          ...summarisePairs(a.pairs),
        },
        weight: { with_baseline: wt.with_baseline, ...summariseChange(wt.pairs) },
      };
    }
    for (const wk of ["m3", "m6", "m12"]) {
      const a1c = markerPairs(inPeriod, "hba1c", period.end, wk, (p) => p.drug_index);
      const wt = markerPairs(inPeriod, "weight", period.end, wk, (p) => p.drug_index);
      result[wk] = {
        hba1c: {
          eligible: a1c.eligible,
          with_baseline: a1c.with_baseline,
          measured: share(a1c.pairs.length, a1c.with_baseline),
          ...summarisePairs(a1c.pairs),
        },
        weight: {
          eligible: wt.eligible,
          with_baseline: wt.with_baseline,
          measured: share(wt.pairs.length, wt.with_baseline),
          ...summariseChange(wt.pairs),
          lost_5pct: share(
            wt.pairs.filter((x) => (x.follow - x.baseline) / x.baseline <= -0.05).length,
            wt.pairs.length,
          ),
        },
      };
    }
    return result;
  });
}

function sameGroupTrajectory(people, end) {
  const [w3, , w12] = DM_WINDOWS;
  const tracked = [];
  for (const p of people) {
    if (!isEligible(p.index_date, w12, end)) continue;
    const series = p.series.get("hba1c");
    const base = pickBaseline(series, p.index_date);
    const at3 = base && pickFollowUp(series, p.index_date, w3);
    const at12 = at3 && pickFollowUp(series, p.index_date, w12);
    if (at12) tracked.push({ base: base.val, m3: at3.val, m12: at12.val });
  }
  const change12 = tracked.map((t) => round(t.m12 - t.base, 2));
  const change3 = tracked.map((t) => round(t.m3 - t.base, 2));
  return {
    n: tracked.length,
    baseline_mean: round(mean(tracked.map((t) => t.base)), 2),
    m3_mean: round(mean(tracked.map((t) => t.m3)), 2),
    m12_mean: round(mean(tracked.map((t) => t.m12)), 2),
    change3_mean: round(mean(change3), 2),
    change12_mean: round(mean(change12), 2),
    change12_ci95: meanCi(change12),
    improved_05_at_12: share(change12.filter((c) => c <= -0.5).length, tracked.length),
    below7_at_12: share(tracked.filter((t) => t.m12 < 7).length, tracked.length),
    held_3m_gain: share(tracked.filter((t) => round(t.m12 - t.m3, 2) < 0.5).length, tracked.length),
  };
}

function stripPairs(rows) {
  return rows.map(({ pairs, _withBaseline, ...rest }) => rest);
}

function auditSample(windows, size) {
  const out = [];
  for (const w of windows) {
    const pool = [...w.pairs].sort(() => Math.random() - 0.5).slice(0, size);
    for (const x of pool) {
      const base = pickBaseline(x.person.series.get("hba1c"), x.person.index_date);
      const follow = pickFollowUp(
        x.person.series.get("hba1c"),
        x.person.index_date,
        DM_WINDOWS.find((d) => d.key === w.window),
      );
      out.push({
        window: w.window,
        patient_id: x.person.id,
        index_date: x.person.index_date,
        baseline: base,
        follow,
      });
    }
  }
  return out;
}

export async function buildDmOutcomes(db, period = DM_PERIOD, { audit = 0, rows = false } = {}) {
  const started = Date.now();
  const registryRows = await loadRegistry(db, period);
  const { persons, merged } = mergePersons(registryRows);
  const personOf = new Map();
  for (const p of persons) for (const id of p.patient_ids) personOf.set(id, p.patient_ids[0]);
  const ids = [...personOf.keys()];
  const rawReadings = await loadReadings(db, ids, period);
  const meds = await loadMedications(db, ids, period);
  const complicationRows = await loadComplications(db, ids);
  const newPatientDates = await loadNewPatientVisits(db, ids, period);
  const onDiabetesMedicine = new Set();
  for (const med of meds) {
    if (normalizeDrug(med).classes.some((k) => DIABETES_DRUG_CLASSES.includes(k)))
      onDiabetesMedicine.add(personOf.get(med.patient_id));
  }
  const { series, dropped } = cleanReadings(rawReadings, personOf);

  const people = persons.map((p) => {
    const index = p.visits[0];
    const last = p.visits[p.visits.length - 1];
    const person = {
      id: p.patient_ids[0],
      sex: normalizeSex(p.sex),
      age: ageAt(p.dob, index, p.stored_age),
      dm_type: diabetesType(p.slugs),
      definition: p.has_dx ? "diagnosis" : "lab_confirmed",
      index_date: index,
      last_visit: last,
      visits: p.visits,
      series: series.get(p.patient_ids[0]) || new Map(),
    };
    person.status = engagementStatus(person, period.end);
    person.new_patient = p.patient_ids.some((id) => {
      const d = newPatientDates.get(id);
      return d != null && dayDiff(index, d) >= 0 && dayDiff(index, d) <= NEW_PATIENT_LEEWAY_DAYS;
    });
    person.confirmation = onDiabetesMedicine.has(person.id)
      ? "medicine"
      : (person.series.get("hba1c") || []).some((r) => r.val >= 6.5)
        ? "hba1c"
        : "unconfirmed";
    const base = pickBaseline(person.series.get("hba1c"), index);
    person._baseline = base ? base.val : null;
    return person;
  });

  const hba1cDates = (p) =>
    (p.series.get("hba1c") || []).filter((r) => r.d >= period.start && r.d <= period.end).length;
  const threeVisitsSixMonths = (p) =>
    p.visits.length >= 3 && dayDiff(p.index_date, p.last_visit) >= 180;

  const windows = hba1cWindowTable(people, period.end);
  for (const w of windows) {
    w._withBaseline = people.filter(
      (p) =>
        isEligible(
          p.index_date,
          DM_WINDOWS.find((x) => x.key === w.window),
          period.end,
        ) && p._baseline != null,
    );
  }
  const labOnlyWindows = hba1cWindowTable(people, period.end, { labOnly: true });

  const byYear = [...new Set(people.map((p) => p.index_date.slice(0, 4)))].sort().map((year) => {
    const rows = hba1cWindowTable(people, period.end, {
      filter: (p) => p.index_date.startsWith(year),
    });
    return {
      enrollment_year: year,
      enrolled: people.filter((p) => p.index_date.startsWith(year)).length,
      windows: rows.map((r) => ({
        window: r.window,
        eligible: r.eligible,
        with_baseline: r.with_baseline,
        measured: r.measured,
        change_mean: r.outcome.change_mean,
        improved_05: r.outcome.improved_05,
      })),
    };
  });

  const statusCounts = ["active", "overdue", "long_gap"].map((s) => ({
    status: s,
    ...share(people.filter((p) => p.status === s).length, people.length),
  }));
  const lapsed = people.filter((p) => p.status === "long_gap");
  const lastKnown = lapsed
    .map((p) => {
      const s = p.series.get("hba1c") || [];
      return s.length ? s[s.length - 1].val : null;
    })
    .filter((v) => v != null);

  const otherMarkers = {};
  for (const marker of ["weight", "bmi", "sbp", "dbp", "ldl", "egfr", "uacr"]) {
    otherMarkers[marker] = {};
    for (const wk of ["m6", "m12", "m24"]) {
      const r = markerPairs(people, marker, period.end, wk);
      otherMarkers[marker][wk] = {
        eligible: r.eligible,
        with_baseline: r.with_baseline,
        measured: share(r.pairs.length, r.with_baseline),
        ...summariseChange(r.pairs, marker === "uacr" ? 1 : 1),
      };
    }
  }

  const starts = treatmentStarts(meds, personOf, period);
  const funnel = {
    registry: people.length,
    by_definition: {
      diagnosis: people.filter((p) => p.definition === "diagnosis").length,
      lab_confirmed: people.filter((p) => p.definition === "lab_confirmed").length,
    },
    confirmation: {
      medicine: share(people.filter((p) => p.confirmation === "medicine").length, people.length),
      hba1c_only: share(people.filter((p) => p.confirmation === "hba1c").length, people.length),
      unconfirmed: share(
        people.filter((p) => p.confirmation === "unconfirmed").length,
        people.length,
      ),
    },
    new_patients: people.filter((p) => p.new_patient).length,
    single_visit: share(people.filter((p) => p.visits.length === 1).length, people.length),
    with_baseline_hba1c: share(people.filter((p) => p._baseline != null).length, people.length),
    with_any_hba1c_in_period: share(people.filter((p) => hba1cDates(p) >= 1).length, people.length),
    with_two_plus_hba1c: share(people.filter((p) => hba1cDates(p) >= 2).length, people.length),
    three_plus_visits: share(people.filter((p) => p.visits.length >= 3).length, people.length),
    three_visits_over_six_months: share(people.filter(threeVisitsSixMonths).length, people.length),
    windows: windows.map((w) => ({
      window: w.window,
      label: w.label,
      eligible: w.eligible,
      too_recent: people.length - w.eligible,
      with_baseline: w.with_baseline,
      measured: w.measured,
    })),
  };

  const demographics = {
    sex: ["Female", "Male", "Unspecified"].map((s) => ({
      sex: s,
      ...share(people.filter((p) => p.sex === s).length, people.length),
    })),
    dm_type: ["Type 2", "Type 1 / LADA", "Other specified", "Unspecified"].map((t) => ({
      type: t,
      ...share(people.filter((p) => p.dm_type === t).length, people.length),
    })),
    age_at_enrollment: {
      known: people.filter((p) => p.age != null).length,
      mean: round(mean(people.map((p) => p.age).filter((a) => a != null)), 1),
      median: median(people.map((p) => p.age).filter((a) => a != null)),
      bands: [
        ["Under 30", 0, 29],
        ["30–44", 30, 44],
        ["45–59", 45, 59],
        ["60–74", 60, 74],
        ["75 and over", 75, 130],
      ].map(([band, lo, hi]) => ({
        band,
        ...share(
          people.filter((p) => p.age != null && p.age >= lo && p.age <= hi).length,
          people.length,
        ),
      })),
      unknown: share(people.filter((p) => p.age == null).length, people.length),
    },
    enrollment_by_year: byYear.map((y) => ({ year: y.enrollment_year, patients: y.enrolled })),
  };

  const audit_sample = audit
    ? auditSample(
        windows.filter((w) => ["m6", "m12"].includes(w.window)),
        audit,
      )
    : undefined;
  return {
    audit_sample,
    dashboard_rows: rows ? buildDashboardRows(people, starts, period) : undefined,
    meta: {
      period,
      generated_at: new Date().toISOString(),
      build_ms: Date.now() - started,
      windows: DM_WINDOWS,
      baseline: DM_BASELINE,
      engagement: ENGAGEMENT,
      lab_confirmed_sources: LAB_CONFIRMED_SOURCES,
      duplicate_records_merged: merged,
      readings_loaded: rawReadings.length,
      readings_dropped: dropped,
      deaths_transfers: "not recorded in Scribe",
    },
    funnel,
    new_patients: {
      patients: people.filter((p) => p.new_patient).length,
      first_new_visit:
        people
          .filter((p) => p.new_patient)
          .map((p) => p.index_date)
          .sort()[0] ?? null,
      windows: stripPairs(
        hba1cWindowTable(people, period.end, { filter: (p) => p.new_patient }).slice(0, 3),
      ),
      same_patients: sameGroupTrajectory(
        people.filter((p) => p.new_patient),
        period.end,
      ),
    },
    confirmed_only: stripPairs(
      hba1cWindowTable(people, period.end, { filter: (p) => p.confirmation !== "unconfirmed" }),
    ),
    demographics,
    hba1c: {
      windows: stripPairs(windows),
      lab_confirmed_only: stripPairs(labOnlyWindows),
      by_enrollment_year: byYear,
      missing_vs_measured_12m: baselineComparison(windows.find((w) => w.window === "m12")),
      missing_vs_measured_6m: baselineComparison(windows.find((w) => w.window === "m6")),
    },
    latest_control: {
      all: latestControl(people),
      active_only: latestControl(people.filter((p) => p.status === "active")),
    },
    other_markers: otherMarkers,
    kidney: kidneyOutcomes(people, period.end),
    combined_control_change: ["m6", "m12"].map((wk) =>
      combinedControlChange(people, period.end, wk),
    ),
    complications: complicationProfile(people, complicationRows, personOf),
    treatments: treatmentOutcomes(people, starts, period),
    engagement: {
      status: statusCounts,
      deceased_or_transferred: "not recorded",
      retention_by_enrollment_year: retention(people, period.end),
      long_gap_last_known_hba1c: {
        n: lastKnown.length,
        of: lapsed.length,
        mean: round(mean(lastKnown), 2),
        median: round(median(lastKnown), 2),
        below7: share(lastKnown.filter((v) => v < 7).length, lastKnown.length),
        note: "Historical — last value before the patient stopped attending. Not a current outcome.",
      },
    },
  };
}

export const DASHBOARD_CODES = {
  sex: ["Female", "Male", "Unspecified"],
  type: ["Type 2", "Type 1 / LADA", "Other specified", "Unspecified"],
  status: ["active", "overdue", "long_gap"],
  age: [
    ["Under 30", 0, 29],
    ["30–44", 30, 44],
    ["45–59", 45, 59],
    ["60–74", 60, 74],
    ["75 and over", 75, 130],
  ],
  treatments: TREATMENT_COHORTS.map((c) => ({ key: c.key, label: c.label })),
};

const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
const r0 = (v) => (v == null ? null : Math.round(v));

function controlFlags(p) {
  const to = p.last_visit;
  const from = addDays(to, -LATEST_CONTROL_LOOKBACK_DAYS);
  const within = (series) => {
    let hit = null;
    for (const r of series || []) if (r.d >= from && r.d <= to) hit = r;
    return hit;
  };
  const a1c = within(p.series.get("hba1c"));
  const dbpByDay = new Map((p.series.get("dbp") || []).map((r) => [r.d, r.val]));
  let bp = null;
  for (const r of p.series.get("sbp") || [])
    if (r.d >= from && r.d <= to && dbpByDay.has(r.d)) bp = [r.val, dbpByDay.get(r.d)];
  const ldl = within(p.series.get("ldl"));
  return [
    a1c ? (a1c.val < 7 ? 1 : 0) : null,
    bp ? (bp[0] < 130 && bp[1] < 80 ? 1 : 0) : null,
    ldl ? (ldl.val < 100 ? 1 : 0) : null,
  ];
}

function windowPairs(series, indexDate, round, windows = DM_WINDOWS) {
  const base = pickBaseline(series, indexDate);
  if (!base) return null;
  return [round(base.val), ...windows.map((w) => round(pickFollowUp(series, indexDate, w)?.val))];
}

export function buildDashboardRows(people, starts, period) {
  const eligibleMask = (date) =>
    DM_WINDOWS.reduce((m, w, i) => (isEligible(date, w, period.end) ? m | (1 << i) : m), 0);
  const early = DM_WINDOWS.slice(0, 3);
  const rows = people.map((p) => {
    const ageIdx =
      p.age == null
        ? -1
        : DASHBOARD_CODES.age.findIndex(([, lo, hi]) => p.age >= lo && p.age <= hi);
    let tx = 0;
    const tr = {};
    TREATMENT_COHORTS.forEach((c, i) => {
      const start = starts.get(`${c.key}|${p.id}`);
      if (!start || start < period.start) return;
      tx |= 1 << i;
      if (dayDiff(p.index_date, start) < NEW_START_DAYS) return;
      tr[i] = {
        e: early.reduce((m, w, k) => (isEligible(start, w, period.end) ? m | (1 << k) : m), 0),
        a: windowPairs(p.series.get("hba1c"), start, r2, early),
        w: windowPairs(p.series.get("weight"), start, r1, early),
      };
    });
    const visitBits = DM_WINDOWS.reduce(
      (m, w, i) =>
        p.visits.some((v) => {
          const d = dayDiff(p.index_date, v);
          return d >= w.minDays && d <= w.maxDays;
        })
          ? m | (1 << i)
          : m,
      0,
    );
    const inPeriod = (p.series.get("hba1c") || []).filter(
      (r) => r.d >= period.start && r.d <= period.end,
    ).length;
    return {
      y: Number(p.index_date.slice(0, 4)),
      nw: p.new_patient ? 1 : 0,
      cf: ["medicine", "hba1c", "unconfirmed"].indexOf(p.confirmation),
      a: ageIdx,
      s: DASHBOARD_CODES.sex.indexOf(p.sex),
      t: DASHBOARD_CODES.type.indexOf(p.dm_type),
      st: DASHBOARD_CODES.status.indexOf(p.status),
      v: Math.min(p.visits.length, 99),
      v6: p.visits.length >= 3 && dayDiff(p.index_date, p.last_visit) >= 180 ? 1 : 0,
      h: Math.min(inPeriod, 9),
      e: eligibleMask(p.index_date),
      rv: visitBits,
      hb: windowPairs(p.series.get("hba1c"), p.index_date, r2),
      wt: windowPairs(p.series.get("weight"), p.index_date, r1),
      bp: windowPairs(p.series.get("sbp"), p.index_date, r0),
      ldl: windowPairs(p.series.get("ldl"), p.index_date, r0),
      c: controlFlags(p),
      tx,
      tr,
    };
  });
  for (let i = rows.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [rows[i], rows[j]] = [rows[j], rows[i]];
  }
  return rows;
}

export function sameGroupFromRows(rows) {
  const tracked = rows
    .filter((r) => r.nw === 1 && (r.e & 4) !== 0 && r.hb && r.hb[1] != null && r.hb[3] != null)
    .map((r) => ({ base: r.hb[0], m3: r.hb[1], m12: r.hb[3] }));
  const change12 = tracked.map((t) => round(t.m12 - t.base, 2));
  const change3 = tracked.map((t) => round(t.m3 - t.base, 2));
  return {
    n: tracked.length,
    baseline_mean: round(mean(tracked.map((t) => t.base)), 2),
    m3_mean: round(mean(tracked.map((t) => t.m3)), 2),
    m12_mean: round(mean(tracked.map((t) => t.m12)), 2),
    change3_mean: round(mean(change3), 2),
    change12_mean: round(mean(change12), 2),
    change12_ci95: meanCi(change12),
    improved_05_at_12: share(change12.filter((c) => c <= -0.5).length, tracked.length),
    below7_at_12: share(tracked.filter((t) => t.m12 < 7).length, tracked.length),
    held_3m_gain: share(tracked.filter((t) => round(t.m12 - t.m3, 2) < 0.5).length, tracked.length),
  };
}
