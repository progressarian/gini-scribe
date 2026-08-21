import { summariseUnmatched } from "./drugNormalizer.js";
import { classifyBiomarker, targetStatus } from "./biomarkerTargets.js";
import { conditionMembers } from "./conditions.js";
import { pct, round } from "./stats.js";

export async function getLabQuality(db, { asOf }) {
  const sql = `
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE canonical_name IS NULL) AS canonical_null,
      COUNT(*) FILTER (WHERE canonical_name ~ '^[a-z0-9_]+$') AS canonical_slug,
      COUNT(*) FILTER (WHERE result IS NULL AND result_text IS NOT NULL) AS text_only,
      COUNT(*) FILTER (WHERE test_date IS NULL) AS missing_date,
      COUNT(*) FILTER (WHERE test_date < '2015-01-01') AS implausible_date
      FROM lab_results
     WHERE test_date IS NULL OR test_date <= $1::date`;
  const { rows } = await db.query(sql, [asOf]);
  const r = rows[0];
  const total = Number(r.total);
  return {
    total_rows: total,
    canonical_missing: Number(r.canonical_null),
    canonical_missing_pct: pct(Number(r.canonical_null), total),
    canonical_unmapped_slug: Number(r.canonical_slug),
    canonical_unmapped_slug_pct: pct(Number(r.canonical_slug), total),
    non_numeric_results: Number(r.text_only),
    missing_test_date: Number(r.missing_date),
    implausible_test_date: Number(r.implausible_date),
  };
}

export async function getUnitHeterogeneity(db, { canonicalNames }) {
  const sql = `
    SELECT canonical_name, COALESCE(NULLIF(TRIM(unit), ''), '(blank)') AS unit, COUNT(*) AS n
      FROM lab_results
     WHERE canonical_name = ANY($1::text[])
     GROUP BY 1, 2`;
  const { rows } = await db.query(sql, [canonicalNames]);
  const byMarker = new Map();
  for (const r of rows) {
    const e = byMarker.get(r.canonical_name) || {
      canonical_name: r.canonical_name,
      total: 0,
      units: [],
    };
    e.total += Number(r.n);
    e.units.push({ unit: r.unit, n: Number(r.n) });
    byMarker.set(r.canonical_name, e);
  }
  return [...byMarker.values()]
    .map((e) => ({
      canonical_name: e.canonical_name,
      distinct_units: e.units.length,
      total_rows: e.total,
      dominant_unit: e.units.sort((a, b) => b.n - a.n)[0].unit,
      dominant_share_pct: pct(e.units[0].n, e.total),
      other_units: e.units.slice(1, 6),
    }))
    .sort((a, b) => b.distinct_units - a.distinct_units);
}

export async function getIdentityRisk(db) {
  const sql = `
    SELECT
      (SELECT COUNT(*) FROM patients) AS total,
      (SELECT COUNT(*) FROM patients WHERE dob IS NULL) AS dob_null,
      (SELECT COUNT(*) FROM patients WHERE age IS NULL AND dob IS NULL) AS age_unknown,
      (SELECT COUNT(*) FROM patients WHERE sex IS NULL OR sex NOT IN ('Male','Female')) AS sex_unspecified,
      (SELECT COUNT(*) FROM patients WHERE phone IS NULL OR TRIM(phone) = '') AS phone_missing,
      (SELECT COUNT(*) FROM patients WHERE file_no IS NULL) AS file_no_missing,
      (SELECT COUNT(*) FROM patients WHERE health_id IS NULL) AS health_id_missing,
      (SELECT COUNT(*) FROM (
         SELECT LOWER(TRIM(name)) AS n, COALESCE(phone,'') AS ph
           FROM patients WHERE name IS NOT NULL
          GROUP BY 1,2 HAVING COUNT(*) > 1) d) AS duplicate_name_phone_groups`;
  const { rows } = await db.query(sql);
  const r = rows[0];
  const total = Number(r.total);
  return {
    total_patients: total,
    dob_missing: Number(r.dob_null),
    dob_missing_pct: pct(Number(r.dob_null), total),
    age_unknown: Number(r.age_unknown),
    sex_unspecified: Number(r.sex_unspecified),
    sex_unspecified_pct: pct(Number(r.sex_unspecified), total),
    phone_missing: Number(r.phone_missing),
    file_no_missing: Number(r.file_no_missing),
    health_id_missing: Number(r.health_id_missing),
    health_id_missing_pct: pct(Number(r.health_id_missing), total),
    duplicate_name_phone_groups: Number(r.duplicate_name_phone_groups),
  };
}

export async function getLegacyTableStaleness(db) {
  const checks = [
    { table: "layer3_outcomes", column: "add_date" },
    { table: "glp1_cohort", column: "latest_consultation_date" },
    { table: "patient_metabolic_profile", column: "updated_at" },
    { table: "patient_treatment_history", column: "updated_at" },
    { table: "patient_health_model", column: null },
  ];
  const out = [];
  for (const check of checks) {
    try {
      const sql = check.column
        ? `SELECT COUNT(*) AS n, MAX(${check.column})::date AS newest FROM ${check.table}`
        : `SELECT COUNT(*) AS n, NULL::date AS newest FROM ${check.table}`;
      const { rows } = await db.query(sql);
      out.push({ table: check.table, rows: Number(rows[0].n), newest_record: rows[0].newest });
    } catch {
      out.push({ table: check.table, rows: null, newest_record: null });
    }
  }
  return out;
}

export function buildCoverageFunnel(patients, conditionIndex, byMarker) {
  const total = patients.length;
  const withVisit = patients.filter((p) => p.first_visit);
  const withDiagnosis = withVisit.filter((p) => conditionIndex.byPatient.has(p.patient_id));

  const markerIndex = new Map();
  for (const [marker, list] of byMarker.entries()) {
    markerIndex.set(marker, new Map(list.map((r) => [r.patient_id, r])));
  }
  const anyMarker = withVisit.filter((p) =>
    [...markerIndex.values()].some((m) => m.has(p.patient_id)),
  );
  const pairedMarker = withVisit.filter((p) =>
    [...markerIndex.values()].some((m) => {
      const r = m.get(p.patient_id);
      return r && r.n >= 2;
    }),
  );

  return [
    { step: "Registered patients", patients: total, share_pct: 100 },
    {
      step: "Has at least one recorded visit",
      patients: withVisit.length,
      share_pct: pct(withVisit.length, total),
    },
    {
      step: "Has at least one coded diagnosis",
      patients: withDiagnosis.length,
      share_pct: pct(withDiagnosis.length, total),
    },
    {
      step: "Has at least one measured biomarker",
      patients: anyMarker.length,
      share_pct: pct(anyMarker.length, total),
    },
    {
      step: "Has two or more readings of a biomarker (trendable)",
      patients: pairedMarker.length,
      share_pct: pct(pairedMarker.length, total),
    },
  ];
}

export function buildUnmatchedDrugs(medRows, minCount = 5) {
  return summariseUnmatched(medRows, minCount).slice(0, 200);
}

export function buildWorklists(patients, conditionIndex, byMarker, cohorts, { asOf, gaps }) {
  const byId = new Map(patients.map((p) => [p.patient_id, p]));
  const markerIndex = new Map();
  for (const [marker, list] of byMarker.entries()) {
    markerIndex.set(marker, new Map(list.map((r) => [r.patient_id, r])));
  }
  const val = (marker, patientId, field = "last_val") => {
    const m = markerIndex.get(marker);
    const r = m && m.get(patientId);
    return r ? r[field] : null;
  };

  const diabetics = conditionMembers(conditionIndex, "diabetes");

  const lapsedUncontrolled = [];
  for (const patientId of diabetics) {
    const p = byId.get(patientId);
    if (!p || p.continuing) continue;
    const a1c = val("hba1c", patientId);
    if (a1c == null || a1c < 9) continue;
    lapsedUncontrolled.push({
      patient_id: patientId,
      file_no: p.file_no,
      age: p.age,
      sex: p.sex,
      last_hba1c: round(a1c, 1),
      last_hba1c_date: val("hba1c", patientId, "last_date"),
      last_visit: p.last_visit,
      days_since_visit: p.days_since_visit,
    });
  }
  lapsedUncontrolled.sort((a, b) => b.last_hba1c - a.last_hba1c);

  const glp1Members = cohorts.filter((c) => c.cohort_key === "glp1");
  const noFollowup = [];
  for (const c of glp1Members) {
    const p = byId.get(c.patient_id);
    if (!p) continue;
    const a1c = markerIndex.get("hba1c")?.get(c.patient_id);
    const weight = markerIndex.get("weight")?.get(c.patient_id);
    const a1cAfter = a1c && a1c.last_date > c.index_date;
    const weightAfter = weight && weight.last_date > c.index_date;
    if (a1cAfter && weightAfter) continue;
    noFollowup.push({
      patient_id: c.patient_id,
      file_no: p.file_no,
      index_date: c.index_date,
      still_on_drug: c.active,
      has_followup_hba1c: !!a1cAfter,
      has_followup_weight: !!weightAfter,
      last_visit: p.last_visit,
    });
  }

  const worsening = [];
  for (const marker of ["hba1c", "sbp", "ldl"]) {
    const m = markerIndex.get(marker);
    if (!m) continue;
    for (const [patientId, r] of m.entries()) {
      if (r.n < 2 || r.first_val == null || r.last_val == null) continue;
      if (classifyBiomarker(marker, r.last_val, r.first_val) !== "worse") continue;
      if (targetStatus(marker, r.last_val) !== "bad") continue;
      const p = byId.get(patientId);
      if (!p) continue;
      worsening.push({
        patient_id: patientId,
        file_no: p.file_no,
        marker,
        first_value: round(r.first_val, 2),
        first_date: r.first_date,
        latest_value: round(r.last_val, 2),
        latest_date: r.last_date,
        change: round(r.last_val - r.first_val, 2),
        continuing: p.continuing,
      });
    }
  }
  worsening.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));

  const gapRows = [];
  for (const gap of gaps || []) {
    for (const s of gap.sample) {
      const p = byId.get(s.patient_id);
      gapRows.push({
        patient_id: s.patient_id,
        file_no: s.file_no,
        gap: gap.gap,
        continuing: p ? p.continuing : null,
        last_visit: p ? p.last_visit : null,
      });
    }
  }

  return {
    lapsed_uncontrolled_diabetics: lapsedUncontrolled,
    glp1_without_followup: noFollowup,
    worsening_tier1: worsening.slice(0, 2000),
    guideline_gaps: gapRows,
  };
}
