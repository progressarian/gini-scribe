import "../loadEnv.js";
import { cronPool } from "../config/db.js";
import { getPatientBase } from "../services/analytics/patientBase.js";
import {
  buildRegistry,
  buildRetentionCurve,
  getAttendance,
  getIntervals,
  getVisitVolume,
} from "../services/analytics/registry.js";
import {
  buildComorbidityMatrix,
  buildComplicationProfile,
  buildConditionIndex,
  buildPrevalence,
  getDiagnosisRows,
} from "../services/analytics/conditions.js";

const asOf = process.argv[2] || new Date().toISOString().slice(0, 10);

let t = Date.now();
const patients = await getPatientBase(cronPool, { asOf });
console.log(`getPatientBase: ${Date.now() - t}ms, ${patients.length} patients\n`);

const registry = buildRegistry(patients, { asOf });
console.log("KPIs:", JSON.stringify(registry.kpis, null, 2));
console.log("\nRecency:");
for (const r of registry.recency) console.log(`  ${r.band.padEnd(24)} ${String(r.patients).padStart(6)}  ${r.share_pct}%`);
console.log("\nVisit distribution:");
for (const r of registry.visit_distribution) console.log(`  ${r.bucket.padEnd(14)} ${String(r.patients).padStart(6)}  ${r.share_pct}%`);
console.log("\nGrowth (last 6 quarters):");
for (const g of registry.growth.slice(-6)) console.log(`  ${g.quarter}  new=${String(g.new_patients).padStart(5)}  cumulative=${g.cumulative}`);
console.log(`\nunknown age: ${registry.unknown_age_patients}`);
console.log("Demographics:");
for (const d of registry.demographics) console.log(`  ${d.age_band.padEnd(10)} M=${String(d.male).padStart(5)} F=${String(d.female).padStart(5)} U=${String(d.unspecified).padStart(5)} total=${d.total}`);

t = Date.now();
const dx = await getDiagnosisRows(cronPool);
const index = buildConditionIndex(dx);
console.log(`\ngetDiagnosisRows: ${Date.now() - t}ms, ${dx.length} rows`);

const prevalence = buildPrevalence(patients, index);
console.log("\nPrevalence:");
console.log(`${"condition".padEnd(36)}${"pts".padStart(7)}${"panel%".padStart(9)}${"contin".padStart(8)}${"contin%".padStart(9)}`);
for (const p of prevalence) {
  console.log(`${p.condition.padEnd(36)}${String(p.patients).padStart(7)}${String(p.share_of_panel_pct).padStart(9)}${String(p.continuing).padStart(8)}${String(p.continuing_pct).padStart(9)}`);
}

console.log(`\nUnmapped diagnosis slugs (top 15 of ${index.unmapped.length}):`);
for (const u of index.unmapped.slice(0, 15)) console.log(`  ${u.slug.padEnd(36)} patients=${u.patients}`);

const comorbid = buildComorbidityMatrix(patients, index);
console.log("\nCondition burden:");
for (const b of comorbid.burden) console.log(`  ${b.bucket.padEnd(18)} ${String(b.patients).padStart(6)}  ${b.share_pct}%`);

const comps = buildComplicationProfile(patients, index);
console.log(`\nComplications among diabetics (crude denom ${comps.diabetic_denominator}, adjusted denom varies):`);
for (const c of comps.rows) {
  console.log(
    `  ${c.complication.padEnd(34)} n=${String(c.patients_affected).padStart(5)} crude=${String(c.crude_rate_pct).padStart(5)}%  adjusted=${String(c.adjusted_rate_pct).padStart(5)}% (denom ${c.eligible_denominator}, from ${c.capture_start})`,
  );
}
console.log(`  ANY complication: ${comps.any_complication}/${comps.eligible_denominator} (${comps.any_complication_pct}%) from ${comps.capture_start}`);

const attendance = await getAttendance(cronPool, { asOf });
console.log(`\nNo-show rate: ${attendance.no_show_rate_pct}%`);
for (const s of attendance.by_status) console.log(`  ${s.status.padEnd(14)} ${s.appointments}`);

const intervals = await getIntervals(cronPool, { asOf });
console.log(`\nVisit interval days: ${JSON.stringify(intervals.intervals)}`);

const volume = await getVisitVolume(cronPool, { asOf });
console.log(`\nVisit volume months: ${volume.length}, last 3:`, volume.slice(-3));

const retention = buildRetentionCurve(patients, { asOf });
console.log("\nRetention by first-visit cohort (first 8):");
for (const r of retention.slice(0, 8)) console.log(`  ${r.cohort}  n=${String(r.size).padStart(5)}  180d=${r.retained_180d_pct}%  365d=${r.retained_365d_pct}%  active=${r.still_active_pct}%`);

await cronPool.end();
