import {
  ENGINE_VERSION,
  CONTINUITY_DAYS,
  OUTCOME_WINDOWS,
  BASELINE_WINDOW,
  MARKER_KEYS,
  OUTCOME_MARKERS,
} from "./constants.js";
import { getPatientBase } from "./patientBase.js";
import { getMarkerCoverage, getMarkerSummary } from "./markerSeries.js";
import {
  buildRegistry,
  buildRetentionCurve,
  getAttendance,
  getIntervals,
  getVisitVolume,
} from "./registry.js";
import {
  buildComorbidityMatrix,
  buildComplicationProfile,
  buildConditionByAge,
  buildConditionIndex,
  buildPrevalence,
  getDiagnosisRows,
} from "./conditions.js";
import {
  buildControlByCondition,
  buildControlByContinuity,
  buildControlCascade,
  buildGoalAttainment,
  buildMarkerControl,
  buildMarkerDistribution,
  buildTrajectoryByCondition,
  indexSummary,
} from "./biomarkers.js";
import {
  buildDiabetesRegimenMix,
  buildGuidelineGaps,
  buildPersistence,
  buildSupportMedProfile,
  buildTreatmentLandscape,
  getMedicationRows,
} from "./treatment.js";
import {
  buildDrugCohorts,
  buildIndexSensitivity,
  buildPersistenceByCohort,
  buildTitrationLadder,
  computeOutcomes,
  summariseOutcomes,
  INDEX_QUALITY_LABELS,
} from "./drugOutcomes.js";
import {
  buildCoverageFunnel,
  buildUnmatchedDrugs,
  buildWorklists,
  getIdentityRisk,
  getLabQuality,
  getLegacyTableStaleness,
  getUnitHeterogeneity,
} from "./dataQuality.js";
import { INCRETIN_MOLECULES } from "./drugNormalizer.js";

const HEADLINE_CONDITIONS = [
  "diabetes",
  "hypertension",
  "adiposity",
  "masld",
  "thyroid",
  "dyslipidemia",
  "ckd",
];
const HEADLINE_MARKERS = ["hba1c", "sbp", "ldl", "weight", "bmi", "uacr", "egfr", "tsh", "tg"];

// Cohort filters offered on the Outcomes, Conditions and Prescribing tabs. Each
// restricts its section to patients meeting the predicate, so the figures can be
// read for the engaged panel rather than for everyone who ever gave a sample.
//
// Deliberately not offered on Panel & retention (measuring return rates over
// patients selected for returning is circular), GLP-1 results (its cohorts are
// already small and its outcomes come from their own SQL) or Data quality
// (filtering out poorly-recorded patients hides the very gap it reports).
const PANEL_COHORTS = [
  {
    key: "visits3",
    label: "3+ visits ever",
    note: "Patients with three or more recorded visit days at any time.",
    match: (p) => p.visit_days >= 3,
  },
  {
    key: "dense_year",
    label: "3+ visits in a 12-month span",
    note: "Patients whose history contains a 365-day window holding three or more visit days.",
    match: (p) => p.dense_year,
  },
];

// Restrict the per-marker index to a set of patients, reusing the same row
// objects — the builders only read them.
function narrowByMarker(byMarker, allowed) {
  const out = new Map();
  for (const [marker, list] of byMarker.entries()) {
    const kept = list.filter((r) => allowed.has(r.patient_id));
    if (kept.length) out.set(marker, kept);
  }
  return out;
}
const INCRETIN_COHORTS = [...INCRETIN_MOLECULES, "glp1_unspecified", "glp1"];
const COMPARATOR_COHORTS = ["sglt2i", "dpp4i", "sulfonylurea", "insulin", "biguanide"];

export async function buildFullReport(db, { asOf } = {}) {
  const startedAt = Date.now();
  const reportDate = asOf || new Date().toISOString().slice(0, 10);

  const [patients, diagnosisRows, medRows, markerSummary, markerCoverage] = await Promise.all([
    getPatientBase(db, { asOf: reportDate }),
    getDiagnosisRows(db),
    getMedicationRows(db, { asOf: reportDate }),
    getMarkerSummary(db, { asOf: reportDate }),
    getMarkerCoverage(db, { asOf: reportDate }),
  ]);

  const conditionIndex = buildConditionIndex(diagnosisRows);
  const byMarker = indexSummary(markerSummary);

  const [visitVolume, attendance, intervals, labQuality, identity, legacy, unitHeterogeneity] =
    await Promise.all([
      getVisitVolume(db, { asOf: reportDate }),
      getAttendance(db, { asOf: reportDate }),
      getIntervals(db, { asOf: reportDate }),
      getLabQuality(db, { asOf: reportDate }),
      getIdentityRisk(db),
      getLegacyTableStaleness(db),
      getUnitHeterogeneity(db, {
        canonicalNames: ["UACR", "HbA1c", "LDL", "Weight", "eGFR", "TSH"],
      }),
    ]);

  const cohorts = buildDrugCohorts(medRows, patients, { asOf: reportDate });
  const outcomes = await computeOutcomes(db, cohorts, { asOf: reportDate });
  const outcomeRows = summariseOutcomes(cohorts, outcomes);
  const guidelineGaps = buildGuidelineGaps(medRows, byMarker, conditionIndex, patients);

  const incretinPatientIds = new Set(
    cohorts.filter((c) => c.cohort_key === "glp1").map((c) => c.patient_id),
  );

  const registry = buildRegistry(patients, { asOf: reportDate });

  const report = {
    meta: {
      engine_version: ENGINE_VERSION,
      as_of: reportDate,
      generated_at: new Date().toISOString(),
      continuity_days: CONTINUITY_DAYS,
      baseline_window: BASELINE_WINDOW,
      outcome_windows: OUTCOME_WINDOWS,
      markers_tracked: MARKER_KEYS.length,
      build_ms: null,
    },
    s1_registry: {
      ...registry,
      visit_volume: visitVolume,
    },
    s2_conditions: {
      prevalence: buildPrevalence(patients, conditionIndex),
      comorbidity: buildComorbidityMatrix(patients, conditionIndex),
      by_age: buildConditionByAge(patients, conditionIndex, HEADLINE_CONDITIONS),
      complications: buildComplicationProfile(patients, conditionIndex),
      unmapped_diagnoses: conditionIndex.unmapped.slice(0, 100),
      cohorts: PANEL_COHORTS.map((c) => {
        const members = patients.filter(c.match);
        return {
          key: c.key,
          label: c.label,
          note: c.note,
          patients: members.length,
          prevalence: buildPrevalence(members, conditionIndex),
          comorbidity: buildComorbidityMatrix(members, conditionIndex),
          by_age: buildConditionByAge(members, conditionIndex, HEADLINE_CONDITIONS),
          complications: buildComplicationProfile(members, conditionIndex),
        };
      }),
    },
    s3_retention: {
      recency: registry.recency,
      retention_curve: buildRetentionCurve(patients, { asOf: reportDate }),
      attendance,
      intervals,
      by_condition: buildPrevalence(patients, conditionIndex).map((r) => ({
        condition: r.condition,
        key: r.key,
        patients: r.patients,
        continuing: r.continuing,
        continuing_pct: r.continuing_pct,
        lapsed: r.lapsed,
        capture_start: r.capture_start,
      })),
    },
    s4_biomarkers: {
      coverage: markerCoverage.map((r) => ({
        marker: r.marker,
        readings: Number(r.readings),
        patients_any: Number(r.patients_any),
        patients_paired: Number(r.patients_paired),
        patients_current: Number(r.patients_current),
      })),
      control: buildMarkerControl(byMarker, { asOf: reportDate }),
      cascade: buildControlCascade(byMarker, conditionIndex, patients, { asOf: reportDate }),
      by_condition: buildControlByCondition(byMarker, conditionIndex, HEADLINE_CONDITIONS, {
        asOf: reportDate,
        markers: HEADLINE_MARKERS,
      }),
      trajectory_by_condition: buildTrajectoryByCondition(
        byMarker,
        conditionIndex,
        HEADLINE_CONDITIONS,
        {
          markers: HEADLINE_MARKERS,
        },
      ),
      by_continuity: buildControlByContinuity(byMarker, patients, {
        asOf: reportDate,
        markers: HEADLINE_MARKERS,
      }),
      cohorts: PANEL_COHORTS.map((c) => {
        const members = patients.filter(c.match);
        const allowed = new Set(members.map((p) => p.patient_id));
        const narrowed = narrowByMarker(byMarker, allowed);
        return {
          key: c.key,
          label: c.label,
          note: c.note,
          patients: members.length,
          control: buildMarkerControl(narrowed, { asOf: reportDate }),
          cascade: buildControlCascade(narrowed, conditionIndex, members, { asOf: reportDate }),
          by_continuity: buildControlByContinuity(narrowed, members, {
            asOf: reportDate,
            markers: HEADLINE_MARKERS,
          }),
        };
      }),
      goal_attainment: buildGoalAttainment(byMarker, patients, { asOf: reportDate }),
      distributions: ["hba1c", "bmi", "ldl", "sbp"].map((m) =>
        buildMarkerDistribution(byMarker, m, { asOf: reportDate }),
      ),
    },
    s5_treatment: {
      landscape: buildTreatmentLandscape(medRows, patients),
      regimen: buildDiabetesRegimenMix(medRows, conditionIndex, patients),
      persistence: buildPersistence(medRows, { asOf: reportDate }),
      gaps: guidelineGaps.map(({ sample, ...rest }) => rest),
      cohorts: PANEL_COHORTS.map((c) => {
        const members = patients.filter(c.match);
        const allowed = new Set(members.map((p) => p.patient_id));
        return {
          key: c.key,
          label: c.label,
          note: c.note,
          patients: members.length,
          landscape: buildTreatmentLandscape(medRows, members),
          regimen: buildDiabetesRegimenMix(medRows, conditionIndex, members),
          persistence: buildPersistence(medRows, { asOf: reportDate, patientIds: allowed }),
          gaps: buildGuidelineGaps(medRows, byMarker, conditionIndex, members).map(
            ({ sample, ...rest }) => rest,
          ),
        };
      }),
    },
    s6_drug_outcomes: {
      cohort_sizes: summariseCohortSizes(cohorts),
      outcomes: outcomeRows.filter((r) =>
        [...INCRETIN_COHORTS, ...COMPARATOR_COHORTS].includes(r.cohort),
      ),
      persistence: buildPersistenceByCohort(cohorts, { asOf: reportDate }).filter((r) =>
        [...INCRETIN_COHORTS, ...COMPARATOR_COHORTS].includes(r.cohort),
      ),
      titration: ["tirzepatide", "semaglutide_inj", "semaglutide_oral"].map((m) =>
        buildTitrationLadder(medRows, m),
      ),
      sensitivity_weight: buildIndexSensitivity(cohorts, outcomes, {
        cohortKeys: ["glp1", "semaglutide_inj", "tirzepatide"],
        marker: "weight",
        window: "m6",
      }),
      sensitivity_hba1c: buildIndexSensitivity(cohorts, outcomes, {
        cohortKeys: ["glp1", "semaglutide_inj", "tirzepatide"],
        marker: "hba1c",
        window: "m6",
      }),
      tolerability: buildSupportMedProfile(medRows, incretinPatientIds),
      index_quality_labels: INDEX_QUALITY_LABELS,
      notes: [
        "These are observational cohorts drawn from routine care. Patients were not randomised, and who receives a GLP-1 agonist differs systematically from who does not, so differences between arms cannot be read as drug effects.",
        "Every cell states its paired sample size. Where paired n is small the estimate is unstable and should not be quoted on its own.",
        "The index date is the recorded start of the drug. For most patients it was entered retrospectively, so see the sensitivity tables before relying on any single figure.",
      ],
    },
    s7_data_quality: {
      coverage_funnel: buildCoverageFunnel(patients, conditionIndex, byMarker),
      labs: labQuality,
      identity,
      unit_heterogeneity: unitHeterogeneity,
      unmatched_drugs: buildUnmatchedDrugs(medRows),
      unmapped_diagnoses: conditionIndex.unmapped.slice(0, 100),
      legacy_tables: legacy,
      notes: [
        "The derived tables listed below are not read by this report. They were built once by hand-run scripts, have no scheduler, and are stale.",
        "Unmatched drug strings and unmapped diagnosis slugs are the feedback list. Classifying the high-frequency entries improves every downstream number.",
      ],
    },
    s8_worklists: buildWorklists(patients, conditionIndex, byMarker, cohorts, {
      asOf: reportDate,
      gaps: guidelineGaps,
    }),
  };

  report.meta.build_ms = Date.now() - startedAt;
  return report;
}

function summariseCohortSizes(cohorts) {
  const sizes = new Map();
  const quality = new Map();
  for (const c of cohorts) {
    sizes.set(c.cohort_key, (sizes.get(c.cohort_key) || 0) + 1);
    const q = quality.get(c.cohort_key) || {};
    q[c.index_quality] = (q[c.index_quality] || 0) + 1;
    quality.set(c.cohort_key, q);
  }
  return [...sizes.entries()]
    .map(([cohort, patients]) => ({ cohort, patients, index_quality: quality.get(cohort) }))
    .sort((a, b) => b.patients - a.patients);
}

export { OUTCOME_MARKERS };
