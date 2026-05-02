/**
 * Single-patient dry-run of the visit_status backfill against the test
 * companion patient (file_no = 'TEST_COMPANION_USER'). Prints before/after
 * snapshots so you can eyeball the bucketing without touching the rest of
 * the 13.7k patients.
 *
 * Run: node server/scripts/backfill-medication-visit-status-test.js
 *
 * The logic — find the patient's max last_prescribed_date across active
 * meds, mark everything matching it (or rows with NULL) as 'current', and
 * everything older as 'previous' — is exactly what the frontend used to
 * compute at render time. After this script you should see the same
 * "Prev Visit (N)" count on /visit/<pid> as `previous` row count below.
 */
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { createRequire } from "module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dotenv = await import("dotenv");
dotenv.config({ path: join(__dirname, "..", ".env") });

const { default: pool } = await import("../config/db.js");
const { markMedicationVisitStatus } = await import("../services/medication/visitStatus.js");
const require = createRequire(import.meta.url);
const { syncMedicationsToGenie } = require("../genie-sync.cjs");

const FILE_NO = "TEST_COMPANION_USER";

// 1. Resolve patient_id from file_no.
const { rows: patientRows } = await pool.query(
  `SELECT id, name, file_no FROM patients WHERE file_no = $1 LIMIT 1`,
  [FILE_NO],
);
if (!patientRows[0]) {
  console.error(`Patient with file_no='${FILE_NO}' not found. Aborting.`);
  await pool.end();
  process.exit(1);
}
const pid = patientRows[0].id;
console.log(`Test patient: id=${pid} name=${patientRows[0].name} file_no=${FILE_NO}`);

// 2. BEFORE snapshot.
console.log("\n── BEFORE ──");
const before = await pool.query(
  `SELECT id, name, dose, last_prescribed_date::text AS last_prescribed_date,
          is_active, visit_status
     FROM medications
    WHERE patient_id = $1
    ORDER BY is_active DESC, last_prescribed_date DESC NULLS LAST, id`,
  [pid],
);
console.table(before.rows);
const beforeCounts = before.rows.reduce(
  (acc, m) => {
    if (!m.is_active) acc.stopped += 1;
    else if (m.visit_status === "previous") acc.previous += 1;
    else acc.current += 1;
    return acc;
  },
  { current: 0, previous: 0, stopped: 0 },
);
console.log("Counts:", beforeCounts);

// 3. Show the latest last_prescribed_date — same anchor the helper uses.
const { rows: anchorRows } = await pool.query(
  `SELECT MAX(last_prescribed_date)::text AS latest
     FROM medications
    WHERE patient_id = $1 AND is_active = true`,
  [pid],
);
console.log(`Latest last_prescribed_date among active meds: ${anchorRows[0].latest}`);

// 4. Stamp visit_status on the scribe side.
console.log("\n── Stamping visit_status (scribe Postgres / Supabase) ──");
await markMedicationVisitStatus(pid);
console.log("✓ markMedicationVisitStatus done");

// 5. Push to genie.
console.log("\n── Pushing to genie via gini_sync_medication ──");
const pushRes = await syncMedicationsToGenie(pid, pool);
console.log(
  `✓ pushed=${pushRes?.pushed || 0} total=${pushRes?.total || 0} ` +
    `errors=${pushRes?.errors?.length || 0}`,
);
if (pushRes?.errors?.length) {
  for (const e of pushRes.errors.slice(0, 5)) {
    console.warn(`  - ${e.name}: ${e.error}`);
  }
}

// 6. AFTER snapshot.
console.log("\n── AFTER ──");
const after = await pool.query(
  `SELECT id, name, dose, last_prescribed_date::text AS last_prescribed_date,
          is_active, visit_status
     FROM medications
    WHERE patient_id = $1
    ORDER BY is_active DESC, last_prescribed_date DESC NULLS LAST, id`,
  [pid],
);
console.table(after.rows);
const afterCounts = after.rows.reduce(
  (acc, m) => {
    if (!m.is_active) acc.stopped += 1;
    else if (m.visit_status === "previous") acc.previous += 1;
    else acc.current += 1;
    return acc;
  },
  { current: 0, previous: 0, stopped: 0 },
);
console.log("Counts:", afterCounts);

console.log(
  `\nDone. If 'previous' count looks right, run the full backfill:\n` +
    `  node server/scripts/backfill-medication-visit-status.js`,
);
await pool.end();
