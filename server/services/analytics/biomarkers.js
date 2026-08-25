import {
  MARKERS,
  MARKER_KEYS,
  GOAL_ATTAINMENT_MARKERS,
  GOAL_ATTAINMENT_MIN_VISITS,
} from "./constants.js";
import {
  classifyBiomarker,
  describeTargetBands,
  gapToGoal,
  targetStatus,
  CONTROL_LABELS,
  TRAJECTORY_LABELS,
} from "./biomarkerTargets.js";
import { describe, histogram, pct, round } from "./stats.js";
import { conditionMembers } from "./conditions.js";
import { daysBetween } from "./patientBase.js";

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

  const bands = { good: 0, warn: 0, bad: 0, unknown: 0 };
  for (const r of current) bands[targetStatus("hba1c", r.last_val)] += 1;

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
        step: "At goal (HbA1c 7% or below)",
        patients: bands.good,
        share_pct: pct(bands.good, diabetics.size),
      },
    ],
    control_bands: [
      {
        band: "7% or below (at goal)",
        status: "good",
        patients: bands.good,
        share_pct: pct(bands.good, current.length),
      },
      {
        band: "Over 7 to 9% (borderline)",
        status: "warn",
        patients: bands.warn,
        share_pct: pct(bands.warn, current.length),
      },
      {
        band: "Over 9% (poor control)",
        status: "bad",
        patients: bands.bad,
        share_pct: pct(bands.bad, current.length),
      },
    ],
    denominator: diabetics.size,
    current_denominator: current.length,
    notes: [
      "Each step is a subset of the one above it, so the drop between steps is the measurement gap rather than a treatment failure.",
      "Control bands use only patients with an HbA1c in the last 12 months; patients not recently tested are not counted as controlled or uncontrolled.",
      "Bands are the same HbA1c thresholds used everywhere else in this report (7% or below at goal, over 7 up to 9% borderline, over 9% poor control), so a value of exactly 7.0 or 9.0 falls in the same band on every chart.",
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

export function buildGoalAttainment(
  byMarker,
  patients,
  { asOf, markers = GOAL_ATTAINMENT_MARKERS, minVisits = GOAL_ATTAINMENT_MIN_VISITS } = {},
) {
  const engaged = patients.filter((p) => p.visit_days >= minVisits);
  const eligible = new Set(engaged.map((p) => p.patient_id));

  const rows = [];
  for (const key of markers) {
    const spec = MARKERS[key];
    if (!spec) continue;

    const paired = (byMarker.get(key) || []).filter(
      (r) => eligible.has(r.patient_id) && r.n >= 2 && r.first_val != null && r.last_val != null,
    );
    const startedOff = paired.filter((r) => {
      const status = targetStatus(key, r.first_val);
      return status === "warn" || status === "bad";
    });
    if (!startedOff.length) continue;

    const reached = startedOff.filter((r) => targetStatus(key, r.last_val) === "good");
    const improved = startedOff.filter(
      (r) => targetStatus(key, r.first_val) === "bad" && targetStatus(key, r.last_val) === "warn",
    );

    // Which way is everyone who started off goal heading? Uses the same
    // classifier as the trajectory charts, so "moving toward goal" here and
    // "improving" there mean the same thing on the same tolerances. Patients who
    // reached goal are included — arriving is the strongest form of moving
    // toward it — so this splits the same denominator the table above reports.
    const notReached = startedOff.filter((r) => targetStatus(key, r.last_val) !== "good");
    const moves = { better: [], stable: [], worse: [], unknown: [] };
    for (const r of startedOff) moves[classifyBiomarker(key, r.last_val, r.first_val)].push(r);
    const current = reached.filter((r) => currentWithin(r, asOf));
    const bands = describeTargetBands(key, spec.unit);

    rows.push({
      marker: key,
      label: spec.label,
      unit: spec.unit,
      goal: bands?.good || null,
      patients_paired: paired.length,
      started_off_goal: startedOff.length,
      reached_goal: reached.length,
      reached_goal_pct: pct(reached.length, startedOff.length),
      reached_goal_current: current.length,
      improved_band: improved.length,
      improved_band_pct: pct(improved.length, startedOff.length),
      still_off_goal: notReached.length,
      unchanged_band: startedOff.length - reached.length - improved.length,
      toward_goal: moves.better.length,
      toward_goal_pct: pct(moves.better.length, startedOff.length),
      holding_steady: moves.stable.length,
      holding_steady_pct: pct(moves.stable.length, startedOff.length),
      moving_away: moves.worse.length,
      moving_away_pct: pct(moves.worse.length, startedOff.length),
      median_gap_toward: round(
        describe(
          moves.better.map((r) => gapToGoal(key, r.last_val)),
          spec.decimals,
        ).median,
        spec.decimals,
      ),
      median_closed_toward: round(
        describe(
          moves.better.map((r) => gapToGoal(key, r.first_val) - gapToGoal(key, r.last_val)),
          spec.decimals,
        ).median,
        spec.decimals,
      ),
      median_first: round(
        describe(
          startedOff.map((r) => r.first_val),
          spec.decimals,
        ).median,
        spec.decimals,
      ),
      median_last_reached: round(
        describe(
          reached.map((r) => r.last_val),
          spec.decimals,
        ).median,
        spec.decimals,
      ),
      median_change_reached: round(
        describe(
          reached.map((r) => r.last_val - r.first_val),
          spec.decimals,
        ).median,
        spec.decimals,
      ),
      median_days_to_goal: round(
        describe(
          reached.map((r) => daysBetween(r.first_date, r.last_date)).filter((d) => d != null),
          0,
        ).median,
        0,
      ),
    });
  }

  return {
    min_visits: minVisits,
    engaged_patients: engaged.length,
    markers: rows,
    notes: [
      `Counts only patients with ${minVisits} or more recorded visit days, so every patient here has been followed rather than seen once.`,
      "The denominator is patients whose first recorded value for the marker missed goal. Patients already at goal on their first reading are excluded — they had no goal to reach.",
      "Reached goal compares that first reading with the patient's latest reading, whenever it was taken. The tested-in-12m column narrows it to patients whose latest reading is recent enough to still stand.",
      "Blood pressure is counted as systolic and diastolic separately, on the same thresholds used everywhere else in this report.",
      "The direction-of-travel split covers everyone who started off goal, including those who reached it — arriving counts as moving toward goal. Holding steady means the change is within the marker's noise tolerance, so it is not read as movement either way.",
      "First and latest readings can be years apart and are not tied to any treatment. This measures where the panel ended up, not what moved it.",
    ],
  };
}

export { CONTROL_LABELS, TRAJECTORY_LABELS };
