/**
 * Wipe all data for a dummy patient — keeps ONLY the row in `patients`.
 *
 * Looks up patient by file_no, prints per-table row counts, then (with --apply)
 * deletes in FK-safe order inside one transaction.
 *
 * Run:
 *   node server/scripts/wipe-patient-data.js --file-no P_178787            # dry-run
 *   node server/scripts/wipe-patient-data.js --file-no P_178787 --apply    # commit
 */
import { fileURLToPath } from "url";
import { dirname, join } from "path";
const __dirname = dirname(fileURLToPath(import.meta.url));

const dotenv = await import("dotenv");
dotenv.config({ path: join(__dirname, "..", ".env") });

const { default: pool } = await import("../config/db.js");

const APPLY = process.argv.includes("--apply");
const fileNoFlagIdx = process.argv.indexOf("--file-no");
const FILE_NO = fileNoFlagIdx > -1 ? process.argv[fileNoFlagIdx + 1] : null;
if (!FILE_NO) {
  console.error("Usage: node server/scripts/wipe-patient-data.js --file-no <FILE_NO> [--apply]");
  process.exit(1);
}

// Delete order — children first. Each table scoped by patient_id.
// (Every table here has a patient_id column; FK cascades would be simpler
// but the schema uses plain REFERENCES without ON DELETE CASCADE.)
const TABLES = [
  "active_visits",
  "visit_symptoms",
  "referrals",
  "lab_cases",
  "vitals",
  "diagnoses",
  "medications",
  "lab_results",
  "documents",
  "goals",
  "complications",
  "patient_vitals_log",
  "patient_activity_log",
  "patient_symptom_log",
  "patient_med_log",
  "patient_meal_log",
  "consultations",
  "appointments",
];

async function run() {
  const client = await pool.connect();
  try {
    // 1. Locate patient
    const pRes = await client.query("SELECT id, name, file_no FROM patients WHERE file_no = $1", [
      FILE_NO,
    ]);
    if (pRes.rows.length === 0) {
      console.error(`No patient found with file_no=${FILE_NO}`);
      process.exitCode = 1;
      return;
    }
    if (pRes.rows.length > 1) {
      console.error(`Ambiguous: ${pRes.rows.length} patients with file_no=${FILE_NO}. Aborting.`);
      console.error(pRes.rows);
      process.exitCode = 1;
      return;
    }
    const patient = pRes.rows[0];
    console.log(`Patient: id=${patient.id}  file_no=${patient.file_no}  name=${patient.name}`);
    console.log();

    // 2. Per-table counts (safe — no writes)
    console.log("Rows to delete:");
    let total = 0;
    for (const t of TABLES) {
      const r = await client
        .query(`SELECT COUNT(*)::int AS c FROM ${t} WHERE patient_id = $1`, [patient.id])
        .catch((e) => {
          console.warn(`  ${t.padEnd(24)} — skip (${e.message})`);
          return null;
        });
      if (!r) continue;
      console.log(`  ${t.padEnd(24)} ${r.rows[0].c}`);
      total += r.rows[0].c;
    }
    console.log(`  ${"TOTAL".padEnd(24)} ${total}`);
    console.log();

    if (!APPLY) {
      console.log("Dry-run — no changes committed. Re-run with --apply to delete.");
      return;
    }

    // 3. Delete in FK-safe order, inside one transaction
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '10s'");
    let deleted = 0;
    for (const t of TABLES) {
      const r = await client
        .query(`DELETE FROM ${t} WHERE patient_id = $1`, [patient.id])
        .catch((e) => {
          console.warn(`  ${t.padEnd(24)} — skip (${e.message})`);
          return null;
        });
      if (!r) continue;
      console.log(`  ${t.padEnd(24)} deleted ${r.rowCount}`);
      deleted += r.rowCount;
    }
    await client.query("COMMIT");
    console.log(`\nDone — ${deleted} rows removed. Patient row kept (id=${patient.id}).`);
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Error:", e.message);
    process.exitCode = 1;
  } finally {
    client.release();
  }
}

try {
  await run();
} finally {
  await pool.end();
}
