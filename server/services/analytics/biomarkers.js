import { MARKERS, MARKER_KEYS } from "./constants.js";
import {
  classifyBiomarker,
  targetStatus,
  CONTROL_LABELS,
  TRAJECTORY_LABELS,
} from "./biomarkerTargets.js";
import { describe, histogram, pct, round } from "./stats.js";
import { conditionMembers } from "./conditions.js";

export function indexSummary(summaryRows) {
  const byMarker = new Map();
  for (const row of summaryRows) {
    const list = byMarker.get(row.marker) || [];
    list.push({
      patient_id: row.patient_id,
      n: Number(row.n),
      first_val: row.first_val == null ? null : Number(row.first_val),
      first_date: row.first_date,
      prev_val: row.prev_val == null ? null : Number(row.prev_val),
      prev_date: row.prev_date,
      last_val: row.last_val == null ? null : Number(row.last_val),
      last_date: row.last_date,
    });
    byMarker.set(row.marker, list);
  }
  return byMarker;
}

function currentWithin(row, asOf, days = 365) {
  if (!row.last_date) return false;
  const diff = (new Date(`${asOf}T00:00:00Z`) - new Date(`${row.last_date}T00:00:00Z`)) / 86400000;
  return diff <= days;
}

export function buildMarkerControl(byMarker, { asOf, markers = MARKER_KEYS } = {}) {
  const rows = [];
  for (const key of markers) {
    const spec = MARKERS[key];
    const list = byMarker.get(key) || [];
    if (!list.length) continue;

    const current = list.filter((r) => currentWithin(r, asOf));
    const statuses = { good: 0, warn: 0, bad: 0, unknown: 0 };
    for (const r of current) statuses[targetStatus(key, r.last_val)] += 1;

    const paired = list.filter((r) => r.n >= 2 && r.first_val != null && r.last_val != null);
    const trends = { better: 0, stable: 0, worse: 0, unknown: 0 };
    for (const r of paired) trends[classifyBiomarker(key, r.last_val, r.first_val)] += 1;

    const deltas = paired.map((r) => r.last_val - r.first_val);

    rows.push({
      marker: key,
      label: spec.label,
      unit: spec.unit,
      tier: spec.tier,
      patients_any: list.length,
      patients_current: current.length,
      patients_paired: paired.length,
      at_goal: statuses.good,
      at_goal_pct: pct(statuses.good, current.length - statuses.unknown),
      borderline: statuses.warn,
      borderline_pct: pct(statuses.warn, current.length - statuses.unknown),
      off_goal: statuses.bad,
      off_goal_pct: pct(statuses.bad, current.length - statuses.unknown),
      not_classifiable: statuses.unknown,
      improving: trends.better,
      improving_pct: pct(trends.better, paired.length),
      stable: trends.stable,
      stable_pct: pct(trends.stable, paired.length),
      worsening: trends.worse,
      worsening_pct: pct(trends.worse, paired.length),
      latest_values: describe(
        current.map((r) => r.last_val),
        spec.decimals,
      ),
      change_first_to_last: describe(deltas, spec.decimals),
    });
  }
  return rows;
}

export function buildMarkerDistribution(byMarker, key, { asOf, bins = 20 } = {}) {
  const spec = MARKERS[key];
  const list = (byMarker.get(key) || []).filter((r) => currentWithin(r, asOf));
  return {
    marker: key,
    label: spec.label,
    unit: spec.unit,
    bins: histogram(
      list.map((r) => r.last_val),
      { min: spec.min, max: spec.max, bins },
    ),
    n: list.length,
  };
}

export function buildControlByCondition(
  byMarker,
  conditionIndex,
  conditionKeys,
  { asOf, markers } = {},
) {
  const rows = [];
  for (const conditionKey of conditionKeys) {
    const members = conditionMembers(conditionIndex, conditionKey);
    for (const markerKey of markers) {
      const list = (byMarker.get(markerKey) || []).filter(
        (r) => members.has(r.patient_id) && currentWithin(r, asOf),
      );
      if (!list.length) continue;
      const statuses = { good: 0, warn: 0, bad: 0, unknown: 0 };
      for (const r of list) statuses[targetStatus(markerKey, r.last_val)] += 1;
      const classifiable = list.length - statuses.unknown;
      rows.push({
        condition: conditionKey,
        marker: markerKey,
        patients: list.length,
        at_goal_pct: pct(statuses.good, classifiable),
        borderline_pct: pct(statuses.warn, classifiable),
        off_goal_pct: pct(statuses.bad, classifiable),
        median: round(
          describe(
            list.map((r) => r.last_val),
            2,
          ).median,
          2,
        ),
      });
    }
  }
  return rows;
}

export function buildTrajectoryByCondition(
  byMarker,
  conditionIndex,
  conditionKeys,
  { markers } = {},
) {
  const rows = [];
  for (const conditionKey of conditionKeys) {
    const members = conditionMembers(conditionIndex, conditionKey);
    for (const markerKey of markers) {
      const list = (byMarker.get(markerKey) || []).filter(
        (r) => members.has(r.patient_id) && r.n >= 2 && r.first_val != null && r.last_val != null,
      );
      if (!list.length) continue;
      const trends = { better: 0, stable: 0, worse: 0, unknown: 0 };
      for (const r of list) trends[classifyBiomarker(markerKey, r.last_val, r.first_val)] += 1;
      const deltas = list.map((r) => r.last_val - r.first_val);
      rows.push({
        condition: conditionKey,
        marker: markerKey,
        patients_paired: list.length,
        improving_pct: pct(trends.better, list.length),
        stable_pct: pct(trends.stable, list.length),
        worsening_pct: pct(trends.worse, list.length),
        mean_change: round(describe(deltas, 2).mean, 2),
        median_change: round(describe(deltas, 2).median, 2),
      });
    }
  }
  return rows;
}

export function buildControlCascade(byMarker, conditionIndex, patients, { asOf }) {
  const byId = new Map(patients.filter((p) => p.first_visit).map((p) => [p.patient_id, p]));
  const diabetics = new Set(
    [...conditionMembers(conditionIndex, "diabetes")].filter((id) => byId.has(id)),
  );
  const list = (byMarker.get("hba1c") || []).filter((r) => diabetics.has(r.patient_id));
  const measured = list.length;
  const current = list.filter((r) => currentWithin(r, asOf));

  const bands = { lt7: 0, b7_9: 0, ge9: 0 };
  for (const r of current) {
    if (r.last_val < 7) bands.lt7 += 1;
    else if (r.last_val < 9) bands.b7_9 += 1;
    else bands.ge9 += 1;
  }

  return {
    steps: [
      { step: "Diagnosed with diabetes", patients: diabetics.size, share_pct: 100 },
      {
        step: "Ever had an HbA1c recorded",
        patients: measured,
        share_pct: pct(measured, diabetics.size),
      },
      {
        step: "HbA1c in the last 12 months",
        patients: current.length,
        share_pct: pct(current.length, diabetics.size),
      },
      {
        step: "At goal (HbA1c under 7%)",
        patients: bands.lt7,
        share_pct: pct(bands.lt7, diabetics.size),
      },
    ],
    control_bands: [
      {
        band: "Under 7% (at goal)",
        patients: bands.lt7,
        share_pct: pct(bands.lt7, current.length),
      },
      {
        band: "7 to 9% (above goal)",
        patients: bands.b7_9,
        share_pct: pct(bands.b7_9, current.length),
      },
      {
        band: "9% or above (poor control)",
        patients: bands.ge9,
        share_pct: pct(bands.ge9, current.length),
      },
    ],
    denominator: diabetics.size,
    current_denominator: current.length,
    notes: [
      "Each step is a subset of the one above it, so the drop between steps is the measurement gap rather than a treatment failure.",
      "Control bands use only patients with an HbA1c in the last 12 months; patients not recently tested are not counted as controlled or uncontrolled.",
    ],
  };
}

export function buildControlByContinuity(byMarker, patients, { asOf, markers }) {
  const byId = new Map(patients.map((p) => [p.patient_id, p]));
  const rows = [];
  for (const markerKey of markers) {
    const list = (byMarker.get(markerKey) || []).filter((r) => currentWithin(r, asOf));
    for (const group of ["continuing", "lapsed"]) {
      const subset = list.filter((r) => {
        const p = byId.get(r.patient_id);
        return p && (group === "continuing" ? p.continuing : !p.continuing);
      });
      if (!subset.length) continue;
      const statuses = { good: 0, warn: 0, bad: 0, unknown: 0 };
      for (const r of subset) statuses[targetStatus(markerKey, r.last_val)] += 1;
      const classifiable = subset.length - statuses.unknown;
      rows.push({
        marker: markerKey,
        group,
        patients: subset.length,
        at_goal_pct: pct(statuses.good, classifiable),
        off_goal_pct: pct(statuses.bad, classifiable),
        median: round(
          describe(
            subset.map((r) => r.last_val),
            2,
          ).median,
          2,
        ),
      });
    }
  }
  return rows;
}

export { CONTROL_LABELS, TRAJECTORY_LABELS };
