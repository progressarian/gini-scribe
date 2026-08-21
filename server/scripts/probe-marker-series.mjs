import "../loadEnv.js";
import { cronPool } from "../config/db.js";
import { getMarkerCoverage, getMarkerSummary } from "../services/analytics/markerSeries.js";
import { MARKERS } from "../services/analytics/constants.js";

const asOf = process.argv[2] || new Date().toISOString().slice(0, 10);
console.log(`as of ${asOf}\n`);

let t = Date.now();
const coverage = await getMarkerCoverage(cronPool, { asOf });
console.log(`getMarkerCoverage: ${Date.now() - t}ms, ${coverage.length} markers\n`);
console.log(
  `${"marker".padEnd(12)}${"readings".padStart(10)}${"patients".padStart(10)}${"paired".padStart(9)}${"current".padStart(9)}`,
);
for (const r of coverage.sort((a, b) => Number(b.patients_any) - Number(a.patients_any))) {
  console.log(
    `${r.marker.padEnd(12)}${String(r.readings).padStart(10)}${String(r.patients_any).padStart(10)}${String(r.patients_paired).padStart(9)}${String(r.patients_current).padStart(9)}`,
  );
}

t = Date.now();
const summary = await getMarkerSummary(cronPool, { asOf });
console.log(`\ngetMarkerSummary: ${Date.now() - t}ms, ${summary.length} rows`);

const a1c = summary.filter((r) => r.marker === "hba1c");
console.log(`hba1c summary rows: ${a1c.length}`);
const sample = a1c.filter((r) => Number(r.n) >= 3).slice(0, 3);
for (const s of sample) {
  console.log(
    `  patient ${s.patient_id}: n=${s.n} first=${s.first_val}@${s.first_date} prev=${s.prev_val}@${s.prev_date} last=${s.last_val}@${s.last_date}`,
  );
}

const outOfRange = summary.filter((r) => {
  const spec = MARKERS[r.marker];
  return r.last_val < spec.min || r.last_val > spec.max;
});
console.log(`\nvalues outside plausibility clamp (must be 0): ${outOfRange.length}`);

await cronPool.end();
