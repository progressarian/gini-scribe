// Closes past-day visits the floor never closed. The rule lives in
// services/giniflow/staleVisits.js, which the nightly cron runs too.
//
//   node scripts/close-stale-giniflow-visits.mjs           # dry run
//   node scripts/close-stale-giniflow-visits.mjs --apply
//
// ⚠️ DATABASE_URL is production.

import "../loadEnv.js";
import pool from "../config/db.js";
import { sweepStaleVisits } from "../services/giniflow/staleVisits.js";

const apply = process.argv.includes("--apply");

const { found, changed, changes } = await sweepStaleVisits({ apply, source: "manual-sweep" });

const byReason = {};
for (const r of changes) {
  const key = `${r.current_status} → ${r.to}`;
  byReason[key] = (byReason[key] || 0) + 1;
}
console.table(byReason);
console.log(`${found} stale visits · ${changed} correctable`);
console.log(apply ? `Applied ${changed} corrections.` : "\nDry run. Re-run with --apply to write.");
await pool.end();
