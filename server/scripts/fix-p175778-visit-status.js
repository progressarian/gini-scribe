/**
 * One-off repair for patient P_175778 (id=2282) after the earlier backfill
 * runs flipped the wrong rows. Sets visit_status to its known-correct value
 * for each of the 7 active healthray:243047815 medications and re-pushes to
 * Genie.
 *
 * Run: node server/scripts/fix-p175778-visit-status.js
 */
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { createRequire } from "module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dotenv = await import("dotenv");
dotenv.config({ path: join(__dirname, "..", ".env") });

const { default: pool } = await import("../config/db.js");
const require = createRequire(import.meta.url);
const { syncMedicationsToGenie } = require("../genie-sync.cjs");

const PATIENT_ID = 2282;

// Ground truth derived from the latest HealthRay extraction at
// 2026-05-01T15:13Z (5 meds). The two left over from the earlier 10:34Z
// extraction are the actual stale ones.
const PREVIOUS_IDS = [419413, 419415]; // Cospiaq M, Aktiv D
const CURRENT_IDS = [358198, 358199, 420244, 420245, 1271130];

const before = await pool.query(
  `SELECT id, name, dose, visit_status FROM medications
    WHERE patient_id = $1 AND id = ANY($2::int[])
    ORDER BY id`,
  [PATIENT_ID, [...PREVIOUS_IDS, ...CURRENT_IDS]],
);
console.log("Before:");
for (const r of before.rows) {
  console.log(`  [${r.id}] ${r.name} ${r.dose || ""}  status=${r.visit_status}`);
}

await pool.query(
  `UPDATE medications SET visit_status = 'previous'
    WHERE patient_id = $1 AND id = ANY($2::int[])`,
  [PATIENT_ID, PREVIOUS_IDS],
);
await pool.query(
  `UPDATE medications SET visit_status = 'current'
    WHERE patient_id = $1 AND id = ANY($2::int[])`,
  [PATIENT_ID, CURRENT_IDS],
);

const after = await pool.query(
  `SELECT id, name, dose, visit_status FROM medications
    WHERE patient_id = $1 AND id = ANY($2::int[])
    ORDER BY visit_status, id`,
  [PATIENT_ID, [...PREVIOUS_IDS, ...CURRENT_IDS]],
);
console.log("\nAfter:");
for (const r of after.rows) {
  console.log(`  [${r.id}] ${r.name} ${r.dose || ""}  status=${r.visit_status}`);
}

console.log("\nPushing to Genie…");
const res = await syncMedicationsToGenie(PATIENT_ID, pool);
console.log(
  `  pushed=${res?.pushed || 0} total=${res?.total || 0} errors=${res?.errors?.length || 0}`,
);
if (res?.errors?.length) {
  for (const e of res.errors) console.log(`    ! ${e.name}: ${e.error}`);
}

await pool.end();
