/**
 * Delete the Companion test patient (file_no = "TEST_COMPANION_USER") and
 * ALL related rows (documents, labs, meds, vitals, consultations, etc).
 *
 * Unlike wipe-patient-data.js, this also removes the patients row itself.
 * After the local delete we also wipe the mirrored patient in MyHealth
 * Genie — including child rows (medications, labs, conditions, goals,
 * appointments, vitals, timeline, care_team, conversations, messages,
 * alerts) — before dropping the patients row on the Genie side so no
 * orphaned test data is left behind on either database.
 *
 * NOTE: files uploaded to Supabase storage from documents.storage_path are
 * NOT deleted here — they become orphaned. Test data volume is low so this
 * is intentional; clean the bucket manually if needed.
 *
 * Run:
 *   node server/scripts/delete-test-patient.js              # dry-run
 *   node server/scripts/delete-test-patient.js --apply      # commit
 *   node server/scripts/delete-test-patient.js --file-no FOO --apply   # override
 */
import { fileURLToPath } from "url";
import { dirname, join } from "path";
const __dirname = dirname(fileURLToPath(import.meta.url));

const dotenv = await import("dotenv");
dotenv.config({ path: join(__dirname, "..", ".env") });

const { default: pool } = await import("../config/db.js");

const { createRequire } = await import("module");
const require = createRequire(import.meta.url);
let deletePatientFromGenie = null;
let resolveGeniePatientId = null;
let getGenieDb = null;
try {
  const mod = require("../genie-sync.cjs");
  deletePatientFromGenie = mod.deletePatientFromGenie;
  resolveGeniePatientId = mod.resolveGeniePatientId;
  getGenieDb = mod.getGenieDb;
} catch (e) {
  console.warn("[delete-test-patient] genie-sync.cjs not loaded:", e.message);
}

const APPLY = process.argv.includes("--apply");
const fileNoFlagIdx = process.argv.indexOf("--file-no");
const FILE_NO = fileNoFlagIdx > -1 ? process.argv[fileNoFlagIdx + 1] : "TEST_COMPANION_USER";

// Delete children first. Any table not present in this DB is skipped.
const CHILD_TABLES = [
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
  "patient_medications_genie",
  "patient_conditions_genie",
  "consultations",
  "appointments",
];

// MyHealth Genie (Supabase) child tables keyed on `patient_id` (genie UUID).
// Order doesn't strictly matter because they're independent, but we drop
// conversations last so patient_messages rows are cleared first.
const GENIE_CHILD_TABLES = [
  "medications",
  "lab_results",
  "conditions",
  "goals",
  "appointments",
  "vitals",
  "timeline_events",
  "care_team",
  "alert_channel",
  "patient_messages",
  "conversations",
];

async function dropGenieChildren(giniPatientId) {
  if (!getGenieDb || !resolveGeniePatientId) {
    console.log("(Skipped Genie child cleanup — helpers not loaded)");
    return;
  }
  const db = getGenieDb();
  if (!db) {
    console.log("(Skipped Genie child cleanup — GENIE_SUPABASE_URL/KEY not set)");
    return;
  }
  const genieUUID = await resolveGeniePatientId(giniPatientId);
  if (!genieUUID) {
    console.log(`(No Genie patient for gini_patient_id=${giniPatientId}; nothing to clean)`);
    return;
  }

  let total = 0;
  for (const t of GENIE_CHILD_TABLES) {
    try {
      const { data, error } = await db.from(t).delete().eq("patient_id", genieUUID).select("id");
      if (error) {
        console.warn(`  ${t.padEnd(24)} — skip (${error.message})`);
        continue;
      }
      const n = data?.length || 0;
      console.log(`  genie.${t.padEnd(18)} deleted ${n}`);
      total += n;
    } catch (e) {
      console.warn(`  ${t.padEnd(24)} — skip (${e.message})`);
    }
  }
  console.log(`  genie children total    ${total}`);
}

async function dropFromGenie(giniPatientId) {
  if (!deletePatientFromGenie) {
    console.log("(Skipped MyHealth Genie patient row — helper not loaded)");
    return;
  }
  const r = await deletePatientFromGenie(giniPatientId);
  if (r?.deleted) {
    console.log(`MyHealth Genie patient row removed (gini_patient_id=${giniPatientId})`);
  } else if (r?.count === 0) {
    console.log(`No MyHealth Genie patient row was present for gini_patient_id=${giniPatientId}`);
  } else {
    console.warn(`MyHealth Genie cleanup failed: ${r?.reason || "unknown"}`);
  }
}

async function run() {
  const client = await pool.connect();
  try {
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

    console.log("Rows to delete (Scribe):");
    let total = 0;
    for (const t of CHILD_TABLES) {
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
    console.log(`  ${"patients".padEnd(24)} 1`);
    console.log(`  ${"TOTAL".padEnd(24)} ${total + 1}`);
    console.log();
    console.log("Also removes, on the MyHealth Genie (Supabase) side:");
    console.log(`  child rows in: ${GENIE_CHILD_TABLES.join(", ")}`);
    console.log(`  the mirrored patients row (gini_patient_id = ${patient.id})`);
    console.log();

    if (!APPLY) {
      console.log("Dry-run — no changes committed. Re-run with --apply to delete.");
      return;
    }

    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '10s'");
    let deleted = 0;
    for (const t of CHILD_TABLES) {
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

    const pDel = await client.query("DELETE FROM patients WHERE id = $1", [patient.id]);
    console.log(`  ${"patients".padEnd(24)} deleted ${pDel.rowCount}`);
    deleted += pDel.rowCount;

    await client.query("COMMIT");
    console.log(`\nDone — ${deleted} rows removed from Scribe (patient + children).`);

    // Mirror the delete to MyHealth Genie only after the Scribe-side commit
    // succeeds. Failures there are surfaced but do not fail the script.
    console.log("\nCleaning MyHealth Genie child rows…");
    await dropGenieChildren(patient.id);
    console.log();
    await dropFromGenie(patient.id);
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
