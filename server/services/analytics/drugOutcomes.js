import {
  BASELINE_WINDOW,
  OUTCOME_WINDOWS,
  OUTCOME_MARKERS,
  WEIGHT_RESPONSE_THRESHOLDS,
  MARKERS,
  AUTOMATED_STOP_REASON,
} from "./constants.js";
import { getWindowedOutcomes } from "./markerSeries.js";
import { MOLECULE_LABELS } from "./drugNormalizer.js";
import { CLASS_LABELS } from "./treatment.js";
import { describe, pct, round } from "./stats.js";

const COMPARATOR_ARMS = ["sglt2i", "dpp4i", "sulfonylurea", "insulin", "biguanide"];

const EXTRA_COHORT_LABELS = {
  glp1_unspecified: "GLP-1, molecule not identified",
  glp1: "Any GLP-1 / GIP agonist",
};

function cohortLabel(key) {
  return EXTRA_COHORT_LABELS[key] || MOLECULE_LABELS[key] || CLASS_LABELS[key] || key;
}

function earliestDate(a, b) {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

export function buildDrugCohorts(medRows, patients, { asOf }) {
  const withVisit = new Set(patients.filter((p) => p.first_visit).map((p) => p.patient_id));
  const cohorts = new Map();

  const add = (cohortKey, kind, row) => {
    const id = `${cohortKey}::${row.patient_id}`;
    const indexDate = row.started_date || row.last_prescribed_date || row.created_on;
    if (!indexDate || indexDate > asOf) return;
    const existing = cohorts.get(id);
    if (existing) {
      if (indexDate < existing.index_date) {
        existing.index_date = indexDate;
        existing.index_source_created_on = row.created_on;
      }
      existing.rows.push(row);
      existing.active = existing.active || row.is_active;
      return;
    }
    cohorts.set(id, {
      cohort_key: cohortKey,
      kind,
      patient_id: row.patient_id,
      index_date: indexDate,
      index_source_created_on: row.created_on,
      rows: [row],
      active: !!row.is_active,
    });
  };

  for (const row of medRows) {
    if (!withVisit.has(row.patient_id)) continue;
    if (row.resolved.molecule) add(row.resolved.molecule, "molecule", row);
    for (const cls of row.resolved.classes) {
      if (cls === "glp1" || COMPARATOR_ARMS.includes(cls)) add(cls, "class", row);
    }
  }

  const patientById = new Map(patients.map((p) => [p.patient_id, p]));
  for (const c of cohorts.values()) {
    c.index_quality = classifyIndexQuality(c);
    const p = patientById.get(c.patient_id);
    c.observation_lead_days = p && p.first_visit ? daysBetween(p.first_visit, c.index_date) : null;
  }

  return [...cohorts.values()];
}

export const INDEX_QUALITY_LABELS = {
  observed_start: "Start observed as it happened",
  backfilled_short: "Start backfilled 1-6 months",
  backfilled_long: "Start backfilled 6+ months",
  unknown: "Start date provenance unknown",
};

function classifyIndexQuality(cohort) {
  const created = cohort.index_source_created_on;
  if (!created || !cohort.index_date) return "unknown";
  const gap = daysBetween(cohort.index_date, created);
  if (gap == null) return "unknown";
  if (gap <= 30) return "observed_start";
  if (gap <= 180) return "backfilled_short";
  return "backfilled_long";
}

function daysBetween(a, b) {
  if (!a || !b) return null;
  const x = new Date(`${a}T00:00:00Z`).getTime();
  const y = new Date(`${b}T00:00:00Z`).getTime();
  if (isNaN(x) || isNaN(y)) return null;
  return Math.round((y - x) / 86400000);
}

export async function computeOutcomes(db, cohorts, { asOf, markers = OUTCOME_MARKERS } = {}) {
  const input = cohorts.map((c) => ({
    patient_id: c.patient_id,
    index_date: c.index_date,
    cohort_key: c.cohort_key,
  }));
  const rows = await getWindowedOutcomes(db, {
    cohort: input,
    markers,
    asOf,
    baseline: BASELINE_WINDOW,
    windows: OUTCOME_WINDOWS,
  });

  const byCohortMarkerWindow = new Map();
  for (const row of rows) {
    if (row.followup_val == null) continue;
    const key = `${row.cohort_key}|${row.marker}|${row.window_key}`;
    const list = byCohortMarkerWindow.get(key) || [];
    list.push({
      patient_id: row.patient_id,
      baseline: Number(row.baseline_val),
      followup: Number(row.followup_val),
      delta: Number(row.followup_val) - Number(row.baseline_val),
      pct_change:
        Number(row.baseline_val) === 0
          ? null
          : ((Number(row.followup_val) - Number(row.baseline_val)) / Number(row.baseline_val)) *
            100,
      days_after: Number(row.days_after),
    });
    byCohortMarkerWindow.set(key, list);
  }

  const baselineByCohortMarker = new Map();
  for (const row of rows) {
    const key = `${row.cohort_key}|${row.marker}`;
    const set = baselineByCohortMarker.get(key) || new Map();
    set.set(row.patient_id, Number(row.baseline_val));
    baselineByCohortMarker.set(key, set);
  }

  return { byCohortMarkerWindow, baselineByCohortMarker };
}

export function summariseOutcomes(cohorts, outcomes, { markers = OUTCOME_MARKERS } = {}) {
  const cohortSizes = new Map();
  for (const c of cohorts) {
    cohortSizes.set(c.cohort_key, (cohortSizes.get(c.cohort_key) || 0) + 1);
  }

  const results = [];
  for (const cohortKey of cohortSizes.keys()) {
    for (const marker of markers) {
      const spec = MARKERS[marker];
      const baselineSet =
        outcomes.baselineByCohortMarker.get(`${cohortKey}|${marker}`) || new Map();
      for (const window of OUTCOME_WINDOWS) {
        const pairs =
          outcomes.byCohortMarkerWindow.get(`${cohortKey}|${marker}|${window.key}`) || [];
        if (!pairs.length) continue;
        const deltas = pairs.map((p) => p.delta);
        const pctChanges = pairs.map((p) => p.pct_change).filter((v) => v != null);
        const row = {
          cohort: cohortKey,
          cohort_label: cohortLabel(cohortKey),
          marker,
          marker_label: spec.label,
          unit: spec.unit,
          window: window.key,
          window_label: window.label,
          cohort_size: cohortSizes.get(cohortKey),
          with_baseline: baselineSet.size,
          paired_n: pairs.length,
          baseline: describe(
            pairs.map((p) => p.baseline),
            spec.decimals,
          ),
          followup: describe(
            pairs.map((p) => p.followup),
            spec.decimals,
          ),
          change: describe(deltas, spec.decimals),
          pct_change: describe(pctChanges, 1),
          median_days_after: Math.round(
            describe(
              pairs.map((p) => p.days_after),
              0,
            ).median,
          ),
        };

        if (marker === "weight") {
          for (const threshold of WEIGHT_RESPONSE_THRESHOLDS) {
            const n = pairs.filter(
              (p) => p.pct_change != null && p.pct_change <= -threshold,
            ).length;
            row[`loss_ge_${threshold}pct`] = n;
            row[`loss_ge_${threshold}pct_rate`] = pct(n, pairs.length);
          }
        }
        if (marker === "hba1c") {
          const toGoal = pairs.filter((p) => p.followup < 7).length;
          const drop1 = pairs.filter((p) => p.delta <= -1).length;
          const startedAbove = pairs.filter((p) => p.baseline >= 7);
          const reachedFromAbove = startedAbove.filter((p) => p.followup < 7).length;
          row.reached_under_7 = toGoal;
          row.reached_under_7_rate = pct(toGoal, pairs.length);
          row.drop_ge_1pct = drop1;
          row.drop_ge_1pct_rate = pct(drop1, pairs.length);
          row.above_goal_at_baseline = startedAbove.length;
          row.above_goal_reached_target_rate = pct(reachedFromAbove, startedAbove.length);
        }
        results.push(row);
      }
    }
  }
  return results;
}

export function buildIndexSensitivity(cohorts, outcomes, { cohortKeys, marker, window }) {
  const strata = ["observed_start", "backfilled_short", "backfilled_long"];
  const leadStrata = [
    {
      key: "lead_ge_30",
      label: "Known to us 30+ days before start",
      test: (c) => c.observation_lead_days != null && c.observation_lead_days >= 30,
    },
    {
      key: "lead_lt_30",
      label: "Started at first visit",
      test: (c) => c.observation_lead_days != null && c.observation_lead_days < 30,
    },
  ];

  const memberQuality = new Map();
  for (const c of cohorts) {
    if (!cohortKeys.includes(c.cohort_key)) continue;
    memberQuality.set(`${c.cohort_key}|${c.patient_id}`, c);
  }

  const rows = [];
  for (const cohortKey of cohortKeys) {
    const pairs = outcomes.byCohortMarkerWindow.get(`${cohortKey}|${marker}|${window}`) || [];
    if (!pairs.length) continue;

    const emit = (stratumKey, label, filtered) => {
      if (!filtered.length) return;
      const deltas = filtered.map((p) => p.delta);
      const pctChanges = filtered.map((p) => p.pct_change).filter((v) => v != null);
      rows.push({
        cohort: cohortKey,
        cohort_label: cohortLabel(cohortKey),
        stratum: stratumKey,
        stratum_label: label,
        paired_n: filtered.length,
        mean_change: round(describe(deltas, 2).mean, 2),
        median_change: round(describe(deltas, 2).median, 2),
        mean_pct_change: round(describe(pctChanges, 1).mean, 1),
        responder_rate_pct:
          marker === "weight"
            ? pct(
                filtered.filter((p) => p.pct_change != null && p.pct_change <= -5).length,
                filtered.length,
              )
            : pct(filtered.filter((p) => p.delta <= -1).length, filtered.length),
      });
    };

    emit("all", "All patients in cohort", pairs);
    for (const stratum of strata) {
      emit(
        stratum,
        INDEX_QUALITY_LABELS[stratum],
        pairs.filter((p) => {
          const c = memberQuality.get(`${cohortKey}|${p.patient_id}`);
          return c && c.index_quality === stratum;
        }),
      );
    }
    for (const lead of leadStrata) {
      emit(
        lead.key,
        lead.label,
        pairs.filter((p) => {
          const c = memberQuality.get(`${cohortKey}|${p.patient_id}`);
          return c && lead.test(c);
        }),
      );
    }
  }

  return {
    marker,
    window,
    rows,
    notes: [
      "The index date is when the drug is recorded as having been started. For most patients that date was backfilled after the fact, so it is uncertain.",
      "This table recomputes the same outcome under different index-date definitions. A large spread between strata means the headline estimate is sensitive to that uncertainty and should be read as a range, not a point value.",
      "No stratum here is a randomised comparison. Patients are not exchangeable across strata, so differences may reflect who was in each group as much as any measurement artefact.",
    ],
  };
}

export function buildPersistenceByCohort(cohorts, { asOf }) {
  const byCohort = new Map();
  for (const c of cohorts) {
    const list = byCohort.get(c.cohort_key) || [];
    list.push(c);
    byCohort.set(c.cohort_key, list);
  }

  const out = [];
  for (const [cohortKey, members] of byCohort.entries()) {
    const durations = [];
    let stoppedCount = 0;
    let clinicalReason = 0;
    for (const m of members) {
      const stopDates = m.rows.map((r) => r.stopped_date).filter(Boolean);
      const anyActive = m.rows.some((r) => r.is_active);
      const end = anyActive ? asOf : stopDates.sort().pop() || asOf;
      if (!anyActive && stopDates.length) stoppedCount += 1;
      if (m.rows.some((r) => r.stop_reason && !AUTOMATED_STOP_REASON.test(r.stop_reason))) {
        clinicalReason += 1;
      }
      const days = Math.round(
        (new Date(`${end}T00:00:00Z`) - new Date(`${m.index_date}T00:00:00Z`)) / 86400000,
      );
      if (days >= 0 && days < 4000) durations.push(days);
    }
    out.push({
      cohort: cohortKey,
      cohort_label: cohortLabel(cohortKey),
      patients: members.length,
      still_on_drug: members.filter((m) => m.active).length,
      still_on_drug_pct: pct(members.filter((m) => m.active).length, members.length),
      discontinued: stoppedCount,
      discontinued_pct: pct(stoppedCount, members.length),
      discontinued_with_clinical_reason: clinicalReason,
      time_on_drug_days: describe(durations, 0),
    });
  }
  return out.sort((a, b) => b.patients - a.patients);
}

export function buildTitrationLadder(medRows, molecule) {
  const doses = new Map();
  const perPatientSteps = new Map();
  for (const row of medRows) {
    if (row.resolved.molecule !== molecule) continue;
    const dose = extractDose(row);
    if (dose == null) continue;
    const e = doses.get(dose) || { dose, patients: new Set(), rows: 0 };
    e.patients.add(row.patient_id);
    e.rows += 1;
    doses.set(dose, e);
    const steps = perPatientSteps.get(row.patient_id) || new Set();
    steps.add(dose);
    perPatientSteps.set(row.patient_id, steps);
  }

  const escalation = new Map();
  for (const steps of perPatientSteps.values()) {
    const n = steps.size;
    const bucket =
      n === 1
        ? "Single dose recorded"
        : n === 2
          ? "2 dose levels"
          : n === 3
            ? "3 dose levels"
            : "4 or more dose levels";
    escalation.set(bucket, (escalation.get(bucket) || 0) + 1);
  }

  return {
    molecule,
    molecule_label: MOLECULE_LABELS[molecule] || molecule,
    doses: [...doses.values()]
      .map((d) => ({ dose_mg: d.dose, patients: d.patients.size, prescriptions: d.rows }))
      .sort((a, b) => a.dose_mg - b.dose_mg),
    escalation: [...escalation.entries()].map(([bucket, patients]) => ({ bucket, patients })),
    patients_with_dose_data: perPatientSteps.size,
  };
}

function extractDose(row) {
  const text = `${row.dose || ""} ${row.name || ""}`;
  const match = text.match(/(\d+(?:\.\d+)?)\s*mg\b/i);
  if (match) {
    const v = parseFloat(match[1]);
    return v > 0 && v <= 100 ? v : null;
  }
  const bare = (row.dose || "").trim().match(/^(\d+(?:\.\d+)?)$/);
  if (bare) {
    const v = parseFloat(bare[1]);
    return v > 0 && v <= 100 ? v : null;
  }
  return null;
}

export { COMPARATOR_ARMS, round };
