import "../loadEnv.js";
import { cronPool } from "../config/db.js";
import { getPatientBase } from "../services/analytics/patientBase.js";
import { buildConditionIndex, getDiagnosisRows } from "../services/analytics/conditions.js";
import { getMarkerSummary } from "../services/analytics/markerSeries.js";
import { indexSummary } from "../services/analytics/biomarkers.js";
import {
  buildDiabetesRegimenMix,
  buildGuidelineGaps,
  buildTreatmentLandscape,
  getMedicationRows,
} from "../services/analytics/treatment.js";
import {
  buildDrugCohorts,
  buildPersistenceByCohort,
  buildIndexSensitivity,
  buildTitrationLadder,
  computeOutcomes,
  summariseOutcomes,
} from "../services/analytics/drugOutcomes.js";

const asOf = process.argv[2] || new Date().toISOString().slice(0, 10);

let t = Date.now();
const [patients, dx, medRows, summary] = await Promise.all([
  getPatientBase(cronPool, { asOf }),
  getDiagnosisRows(cronPool),
  getMedicationRows(cronPool, { asOf }),
  getMarkerSummary(cronPool, { asOf }),
]);
console.log(`load: ${Date.now() - t}ms  patients=${patients.length} meds=${medRows.length}`);
const index = buildConditionIndex(dx);
const byMarker = indexSummary(summary);

const landscape = buildTreatmentLandscape(medRows, patients);
console.log(`\nTreatment landscape (denominator ${landscape.denominator}):`);
for (const c of landscape.classes.slice(0, 14)) {
  console.log(`  ${c.drug_class.padEnd(32)} ever=${String(c.patients_ever).padStart(6)} active=${String(c.patients_active).padStart(6)} panel=${c.share_of_panel_pct}%`);
}

const regimen = buildDiabetesRegimenMix(medRows, index, patients);
console.log(`\nDiabetes regimen mix (denominator ${regimen.denominator}):`);
for (const c of regimen.per_class) console.log(`  ${c.drug_class.padEnd(32)} ${String(c.patients).padStart(6)}  ${c.share_of_diabetics_pct}%`);
console.log("  Intensity:");
for (const i of regimen.intensity) console.log(`    ${i.bucket.padEnd(34)} ${String(i.patients).padStart(6)}  ${i.share_pct}%`);

const gaps = buildGuidelineGaps(medRows, byMarker, index, patients);
console.log("\nGuideline gaps:");
for (const g of gaps) console.log(`  ${g.gap.padEnd(58)} ${String(g.patients_with_gap).padStart(5)}/${String(g.eligible_patients).padEnd(6)} ${g.gap_rate_pct}%`);

t = Date.now();
const cohorts = buildDrugCohorts(medRows, patients, { asOf });
console.log(`\nbuildDrugCohorts: ${cohorts.length} cohort memberships`);

const outcomes = await computeOutcomes(cronPool, cohorts, { asOf });
console.log(`computeOutcomes: ${Date.now() - t}ms`);

const summarised = summariseOutcomes(cohorts, outcomes);

const MOL = ["semaglutide_inj", "tirzepatide", "semaglutide_oral", "liraglutide", "dulaglutide", "glp1"];
console.log("\nHbA1c outcomes at 6 months:");
console.log(`${"cohort".padEnd(20)}${"n".padStart(6)}${"base".padStart(8)}${"follow".padStart(8)}${"change".padStart(8)}${"<7%".padStart(8)}${"drop>=1".padStart(9)}`);
for (const r of summarised.filter((x) => x.marker === "hba1c" && x.window === "m6" && MOL.includes(x.cohort))) {
  console.log(`${r.cohort.padEnd(20)}${String(r.paired_n).padStart(6)}${String(r.baseline.mean).padStart(8)}${String(r.followup.mean).padStart(8)}${String(r.change.mean).padStart(8)}${String(r.reached_under_7_rate).padStart(8)}${String(r.drop_ge_1pct_rate).padStart(9)}`);
}

console.log("\nWeight outcomes at 6 months:");
console.log(`${"cohort".padEnd(20)}${"n".padStart(6)}${"base".padStart(8)}${"change".padStart(8)}${"pct".padStart(8)}${">=5%".padStart(8)}${">=10%".padStart(8)}${">=15%".padStart(8)}`);
for (const r of summarised.filter((x) => x.marker === "weight" && x.window === "m6" && MOL.includes(x.cohort))) {
  console.log(`${r.cohort.padEnd(20)}${String(r.paired_n).padStart(6)}${String(r.baseline.mean).padStart(8)}${String(r.change.mean).padStart(8)}${String(r.pct_change.mean).padStart(8)}${String(r.loss_ge_5pct_rate).padStart(8)}${String(r.loss_ge_10pct_rate).padStart(8)}${String(r.loss_ge_15pct_rate).padStart(8)}`);
}

console.log("\nComparator arms, HbA1c at 6 months:");
for (const r of summarised.filter((x) => x.marker === "hba1c" && x.window === "m6" && ["sglt2i", "dpp4i", "sulfonylurea", "insulin", "biguanide"].includes(x.cohort))) {
  console.log(`  ${r.cohort.padEnd(16)} n=${String(r.paired_n).padStart(5)} base=${r.baseline.mean} change=${r.change.mean} reached<7=${r.reached_under_7_rate}%`);
}

const persistence = buildPersistenceByCohort(cohorts, { asOf });
console.log("\nPersistence:");
for (const p of persistence.filter((x) => MOL.includes(x.cohort))) {
  console.log(`  ${p.cohort.padEnd(20)} n=${String(p.patients).padStart(5)} active=${String(p.still_on_drug_pct).padStart(5)}% medianDays=${p.time_on_drug_days.median}`);
}

const ladder = buildTitrationLadder(medRows, "tirzepatide");
console.log(`\nTirzepatide titration (patients with dose data ${ladder.patients_with_dose_data}):`);
for (const d of ladder.doses) console.log(`  ${String(d.dose_mg).padStart(6)} mg  patients=${d.patients}`);
for (const e of ladder.escalation) console.log(`  ${e.bucket.padEnd(28)} ${e.patients}`);

const sens = buildIndexSensitivity(cohorts, outcomes, {
  cohortKeys: ["semaglutide_inj", "tirzepatide", "glp1"],
  marker: "weight",
  window: "m6",
});
console.log("\nIndex-date sensitivity (weight, 6 months):");
console.log(`${"cohort".padEnd(18)}${"stratum".padEnd(20)}${"n".padStart(6)}${"meanKg".padStart(9)}${"mean%".padStart(8)}${">=5%".padStart(8)}`);
for (const r of sens.rows) {
  console.log(`${r.cohort.padEnd(18)}${r.stratum.padEnd(20)}${String(r.paired_n).padStart(6)}${String(r.mean_change).padStart(9)}${String(r.mean_pct_change).padStart(8)}${String(r.responder_rate_pct).padStart(8)}`);
}

await cronPool.end();
