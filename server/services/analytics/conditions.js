import { CONDITION_GROUPS, COMPLICATION_KEYS, AGE_BANDS } from "./constants.js";
import { pct } from "./stats.js";

const NEGATIVE_FINDING = /^(eu|normo|non_)|_(absent|resolved|screened)$/;

const slugCache = new Map();

export function groupsForSlug(slug) {
  if (slugCache.has(slug)) return slugCache.get(slug);
  let result = [];
  if (!NEGATIVE_FINDING.test(slug)) {
    result = CONDITION_GROUPS.filter((g) => g.pattern.test(slug)).map((g) => g.key);
  }
  slugCache.set(slug, result);
  return result;
}

export const CONDITION_LABELS = CONDITION_GROUPS.reduce((acc, g) => {
  acc[g.key] = g.label;
  return acc;
}, {});

export async function getDiagnosisRows(db, { activeOnly = true } = {}) {
  const sql = `
    SELECT patient_id, diagnosis_id, label, status, is_active, since_year,
           created_at::date AS created_on
      FROM diagnoses
     WHERE patient_id IS NOT NULL AND diagnosis_id IS NOT NULL
       ${activeOnly ? "AND is_active IS TRUE" : ""}`;
  const { rows } = await db.query(sql);
  return rows;
}

export function buildConditionIndex(diagnosisRows) {
  const byPatient = new Map();
  const unmappedSlugs = new Map();
  const captureStart = new Map();

  for (const row of diagnosisRows) {
    const groupKeys = groupsForSlug(row.diagnosis_id);
    if (!groupKeys.length) {
      const e = unmappedSlugs.get(row.diagnosis_id) || {
        slug: row.diagnosis_id,
        rows: 0,
        patients: new Set(),
      };
      e.rows += 1;
      e.patients.add(row.patient_id);
      unmappedSlugs.set(row.diagnosis_id, e);
      continue;
    }
    const set = byPatient.get(row.patient_id) || new Set();
    for (const key of groupKeys) {
      set.add(key);
      const existing = captureStart.get(key);
      if (row.created_on && (!existing || row.created_on < existing)) {
        captureStart.set(key, row.created_on);
      }
    }
    byPatient.set(row.patient_id, set);
  }

  return {
    byPatient,
    captureStart,
    unmapped: [...unmappedSlugs.values()]
      .map((e) => ({ slug: e.slug, rows: e.rows, patients: e.patients.size }))
      .sort((a, b) => b.patients - a.patients),
  };
}

export function buildPrevalence(patients, conditionIndex) {
  const withVisit = patients.filter((p) => p.first_visit);
  const byId = new Map(withVisit.map((p) => [p.patient_id, p]));
  const rows = [];

  for (const group of CONDITION_GROUPS) {
    const members = [];
    for (const [patientId, groups] of conditionIndex.byPatient.entries()) {
      if (!groups.has(group.key)) continue;
      const p = byId.get(patientId);
      if (p) members.push(p);
    }
    const continuing = members.filter((p) => p.continuing).length;
    const ages = members.map((p) => p.age).filter((a) => a != null);
    rows.push({
      condition: group.label,
      key: group.key,
      patients: members.length,
      share_of_panel_pct: pct(members.length, withVisit.length),
      continuing,
      continuing_pct: pct(continuing, members.length),
      lapsed: members.length - continuing,
      female: members.filter((p) => p.sex === "Female").length,
      male: members.filter((p) => p.sex === "Male").length,
      mean_age: ages.length ? Math.round(ages.reduce((a, b) => a + b, 0) / ages.length) : null,
      headline_marker: group.headlineMarker,
      capture_start: conditionIndex.captureStart.get(group.key) || null,
    });
  }

  return rows.sort((a, b) => b.patients - a.patients);
}

export function buildComorbidityMatrix(patients, conditionIndex, topN = 8) {
  const withVisit = new Set(patients.filter((p) => p.first_visit).map((p) => p.patient_id));
  const counts = new Map();
  for (const group of CONDITION_GROUPS) counts.set(group.key, 0);
  for (const [patientId, groups] of conditionIndex.byPatient.entries()) {
    if (!withVisit.has(patientId)) continue;
    for (const g of groups) counts.set(g, (counts.get(g) || 0) + 1);
  }
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([k]) => k);

  const matrix = [];
  for (const a of top) {
    const row = { condition: CONDITION_LABELS[a], key: a };
    for (const b of top) {
      let both = 0;
      for (const [patientId, groups] of conditionIndex.byPatient.entries()) {
        if (!withVisit.has(patientId)) continue;
        if (groups.has(a) && groups.has(b)) both += 1;
      }
      row[b] = both;
    }
    matrix.push(row);
  }

  const burden = new Map();
  for (const patientId of withVisit) {
    const n = (conditionIndex.byPatient.get(patientId) || new Set()).size;
    const key =
      n === 0
        ? "None recorded"
        : n === 1
          ? "1 condition"
          : n <= 3
            ? "2-3 conditions"
            : n <= 5
              ? "4-5 conditions"
              : "6+ conditions";
    burden.set(key, (burden.get(key) || 0) + 1);
  }

  return {
    keys: top,
    labels: top.map((k) => CONDITION_LABELS[k]),
    matrix,
    burden: [...burden.entries()].map(([bucket, patients]) => ({
      bucket,
      patients,
      share_pct: pct(patients, withVisit.size),
    })),
  };
}

export function buildComplicationProfile(patients, conditionIndex) {
  const byId = new Map(patients.filter((p) => p.first_visit).map((p) => [p.patient_id, p]));
  const diabetics = [];
  for (const [patientId, groups] of conditionIndex.byPatient.entries()) {
    const p = byId.get(patientId);
    if (p && groups.has("diabetes")) diabetics.push(p);
  }

  const rows = COMPLICATION_KEYS.map((key) => {
    const start = conditionIndex.captureStart.get(key) || null;
    const eligible = start
      ? diabetics.filter((p) => p.last_visit && p.last_visit >= start)
      : diabetics;
    let affected = 0;
    let affectedEligible = 0;
    for (const p of diabetics) {
      const groups = conditionIndex.byPatient.get(p.patient_id);
      if (!groups || !groups.has(key)) continue;
      affected += 1;
      if (!start || (p.last_visit && p.last_visit >= start)) affectedEligible += 1;
    }
    return {
      complication: CONDITION_LABELS[key],
      key,
      capture_start: start,
      patients_affected: affected,
      crude_rate_pct: pct(affected, diabetics.length),
      eligible_denominator: eligible.length,
      adjusted_rate_pct: pct(affectedEligible, eligible.length),
    };
  });

  const overallStart = [...conditionIndex.captureStart.entries()]
    .filter(([k]) => COMPLICATION_KEYS.includes(k))
    .map(([, v]) => v)
    .sort()
    .pop();
  const eligibleAny = overallStart
    ? diabetics.filter((p) => p.last_visit && p.last_visit >= overallStart)
    : diabetics;
  let anyComplication = 0;
  for (const p of eligibleAny) {
    const groups = conditionIndex.byPatient.get(p.patient_id);
    if (groups && COMPLICATION_KEYS.some((c) => groups.has(c))) anyComplication += 1;
  }

  return {
    diabetic_denominator: diabetics.length,
    eligible_denominator: eligibleAny.length,
    capture_start: overallStart,
    rows: rows.sort((a, b) => b.patients_affected - a.patients_affected),
    any_complication: anyComplication,
    any_complication_pct: pct(anyComplication, eligibleAny.length),
    notes: [
      "The diagnoses table was first populated on 2026-02-15, and individual complications began being captured on different dates. A patient last seen before a complication started being recorded cannot carry that diagnosis, which inflates the apparent recency of complicated patients.",
      "Crude rate uses all diabetics as the denominator and therefore understates prevalence. Adjusted rate restricts the denominator to diabetics seen on or after that complication's capture start date, and is the figure to rely on.",
      "These are recorded-diagnosis rates, not screening-confirmed prevalence. A low rate can mean under-detection rather than genuinely low prevalence.",
      "The diagnoses table holds one upserted row per patient and condition, so prevalence is a point-in-time snapshot and cannot be trended over time.",
    ],
  };
}

export function buildConditionByAge(patients, conditionIndex, conditionKeys) {
  const byId = new Map(patients.filter((p) => p.first_visit).map((p) => [p.patient_id, p]));
  const rows = [];
  for (const band of AGE_BANDS) {
    const row = { age_band: band.label };
    for (const key of conditionKeys) {
      let n = 0;
      for (const [patientId, groups] of conditionIndex.byPatient.entries()) {
        const p = byId.get(patientId);
        if (p && p.ageBand === band.key && groups.has(key)) n += 1;
      }
      row[key] = n;
    }
    rows.push(row);
  }
  return rows;
}

export function conditionMembers(conditionIndex, key) {
  const out = new Set();
  for (const [patientId, groups] of conditionIndex.byPatient.entries()) {
    if (groups.has(key)) out.add(patientId);
  }
  return out;
}
