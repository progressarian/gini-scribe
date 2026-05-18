#!/usr/bin/env node
// ============================================================================
// verify-genie-import.mjs
//
// End-to-end smoke test for the app→hospital patient import. Creates a
// throwaway patient in the genie (app) DB, seeds rows in every
// patient-data table we care about, calls scribe's
// /api/patients/convert-from-genie, then asserts each destination table
// in scribe Postgres received the expected rows. Re-runs the import once
// to check idempotency. Cleans up at the end (best-effort).
//
// Usage:
//   node scripts/verify-genie-import.mjs
//   node scripts/verify-genie-import.mjs --api http://localhost:3001
//
// Reads from server/.env: GENIE_SUPABASE_URL, GENIE_SUPABASE_SERVICE_KEY,
// DATABASE_URL.
// ============================================================================

import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Load server/.env if present (script lives one level up from server/).
const ENV_PATH = join(__dirname, "..", "server", ".env");
if (existsSync(ENV_PATH)) {
  for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*"?([^"\n]*)"?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const API = (() => {
  const arg = process.argv.findIndex((a) => a === "--api");
  if (arg !== -1 && process.argv[arg + 1]) return process.argv[arg + 1];
  return process.env.SCRIBE_API || "http://localhost:3001";
})();

const C = {
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

// ── Setup ──────────────────────────────────────────────────────────────────

const TEST_PHONE = `+9199${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
const TEST_NAME = "Genie Import Smoke Test";

console.log(C.cyan(`\n🔬 Genie→Hospital import smoke test`));
console.log(C.dim(`   test phone: ${TEST_PHONE}`));
console.log(C.dim(`   scribe API: ${API}\n`));

const genieUrl = process.env.GENIE_SUPABASE_URL;
const genieKey = process.env.GENIE_SUPABASE_SERVICE_KEY;
const dbUrl = process.env.DATABASE_URL;
if (!genieUrl || !genieKey) die("Missing GENIE_SUPABASE_URL / GENIE_SUPABASE_SERVICE_KEY in server/.env");
if (!dbUrl) die("Missing DATABASE_URL in server/.env");

const genie = createClient(genieUrl, genieKey);
const pool = new pg.Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

const results = [];
function pass(label, detail = "") {
  results.push({ ok: true, label, detail });
  console.log(`  ${C.green("✓")} ${label}${detail ? C.dim(`  ${detail}`) : ""}`);
}
function fail(label, detail = "") {
  results.push({ ok: false, label, detail });
  console.log(`  ${C.red("✗")} ${label}${detail ? C.red(`  ${detail}`) : ""}`);
}
function info(label) {
  console.log(`  ${C.cyan("→")} ${label}`);
}
function die(msg) {
  console.error(C.red(`\nFATAL: ${msg}\n`));
  process.exit(2);
}

// ── Test data ──────────────────────────────────────────────────────────────

let geniePatientId;
let scribePatientId;

async function createAppPatient() {
  info("seeding app DB");
  const { data, error } = await genie
    .from("patients")
    .insert({
      phone: TEST_PHONE,
      name: TEST_NAME,
      dob: "1990-01-15",
      sex: "Male",
      program_type: "standard",
    })
    .select("*")
    .single();
  if (error) die(`Could not create app patient: ${error.message}`);
  geniePatientId = data.id;
  pass("app patient row created", `genie_id=${geniePatientId}`);
}

async function seedAppData() {
  const today = new Date().toISOString().slice(0, 10);

  // 2 vitals
  await genie.from("vitals").insert([
    {
      patient_id: geniePatientId,
      recorded_date: today,
      reading_time: "08:00",
      bp_systolic: 132,
      bp_diastolic: 84,
      rbs: 145,
      meal_type: "Fasting",
      weight_kg: 78,
    },
    {
      patient_id: geniePatientId,
      recorded_date: today,
      reading_time: "20:00",
      rbs: 168,
      meal_type: "After dinner",
    },
  ]);

  // 3 labs
  await genie.from("lab_results").insert([
    { patient_id: geniePatientId, test_name: "HbA1c", value: 7.4, unit: "%", test_date: today, lab_name: "Lipid Panel" },
    { patient_id: geniePatientId, test_name: "LDL", value: 118, unit: "mg/dL", test_date: today },
    { patient_id: geniePatientId, test_name: "TSH", value: 2.1, unit: "uIU/mL", test_date: today },
  ]);

  // 1 medication
  await genie.from("medications").insert({
    patient_id: geniePatientId,
    name: "Metformin",
    dose: "500mg",
    timing: "BD",
    is_active: true,
    start_date: today,
  });

  // 1 condition
  await genie.from("conditions").insert({
    patient_id: geniePatientId,
    name: "Type 2 Diabetes",
    status: "Uncontrolled",
    diagnosed_year: 2020,
  });

  // 2 meal logs (genie uses log_date/log_time, not logged_at)
  await genie.from("meal_logs").insert([
    {
      patient_id: geniePatientId,
      meal_type: "breakfast",
      description: "Poha + tea",
      calories: 380,
      protein_g: 9,
      carbs_g: 62,
      fat_g: 10,
      log_date: today,
      log_time: "08:00",
    },
    {
      patient_id: geniePatientId,
      meal_type: "lunch",
      description: "Roti + dal + sabzi",
      calories: 620,
      protein_g: 22,
      carbs_g: 90,
      fat_g: 18,
      log_date: today,
      log_time: "13:00",
    },
  ]);

  // 2 activity logs
  await genie.from("activity_logs").insert([
    { patient_id: geniePatientId, activity_type: "Exercise", value: "Walk", duration_minutes: 30, log_date: today, log_time: "07:00" },
    { patient_id: geniePatientId, activity_type: "Mood", value: "Good", mood_score: 4, log_date: today, log_time: "21:00" },
  ]);

  // 1 symptom log
  await genie.from("symptom_logs").insert({
    patient_id: geniePatientId,
    symptom: "Fatigue",
    severity: 3,
    body_area: "general",
    log_date: today,
    log_time: "15:00",
  });

  // 2 medication logs (adherence)
  // Note: medication_id is a UUID foreign key in some schemas — pass null safely.
  await genie.from("medication_logs").insert([
    { patient_id: geniePatientId, log_date: today, dose_time: "morning", status: "taken" },
    { patient_id: geniePatientId, log_date: today, dose_time: "night", status: "taken" },
  ]);

  // patient_reported_side_effects: table doesn't exist in app DB schema yet;
  // skip seed + drop from expected counts. (Add to plan as follow-up if the
  // app starts logging side effects to its own DB.)

  // Documents seed is intentionally skipped here — the app-DB schema for
  // documents is loose and the file URL copy is a known follow-up. See the
  // plan's "Out of scope" section.

  pass("app patient seeded with sample data");
}

// ── Import call ────────────────────────────────────────────────────────────
// We import the service module directly instead of going through the HTTP
// endpoint (which is gated by requireAuth and would need a doctor JWT).

const { convertGeniePatientById } = await import(
  join(__dirname, "..", "server", "services", "genieImport.js")
);

async function callImport({ allowAlreadyMigrated = false } = {}) {
  info("convertGeniePatientById()");
  const body = await convertGeniePatientById(geniePatientId);
  if (!body.ok) {
    if (allowAlreadyMigrated && body.reason === "already_migrated") return body;
    die(`Import failed: ${JSON.stringify(body)}`);
  }
  if (body.scribePatientId) scribePatientId = body.scribePatientId;
  return body;
}

// ── Assertions ─────────────────────────────────────────────────────────────

const expected = {
  patient_vitals_log: 2,
  lab_results: 3,
  medications: 1,
  diagnoses: 1,
  meal_logs: 2,
  patient_meal_log: 2,
  patient_activity_log: 2,
  patient_symptom_log: 1,
  patient_med_log: 2,
};

async function assertCounts(label) {
  console.log(C.cyan(`\n  ${label}`));
  for (const [table, want] of Object.entries(expected)) {
    const got = await pool
      .query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE patient_id=$1`, [scribePatientId])
      .then((r) => r.rows[0].n)
      .catch((e) => `err: ${e.message}`);
    if (got === want) pass(`${table.padEnd(34)} ${got}/${want} rows`);
    else fail(`${table.padEnd(34)} ${got}/${want} rows`);
  }
}

// ── Cleanup ────────────────────────────────────────────────────────────────

async function cleanup() {
  info("cleaning up test rows");
  if (scribePatientId) {
    const tables = [
      "patient_vitals_log",
      "lab_results",
      "medications",
      "diagnoses",
      "meal_logs",
      "patient_meal_log",
      "patient_activity_log",
      "patient_symptom_log",
      "patient_med_log",
      "patient_reported_side_effects",
      "documents",
      "auth_sessions",
    ];
    for (const t of tables) {
      await pool
        .query(
          t === "auth_sessions"
            ? `DELETE FROM auth_sessions WHERE patient_ref=$1`
            : `DELETE FROM ${t} WHERE patient_id=$1`,
          [t === "auth_sessions" ? String(scribePatientId) : scribePatientId],
        )
        .catch(() => {});
    }
    await pool.query("DELETE FROM patients WHERE id=$1", [scribePatientId]).catch(() => {});
  }
  if (geniePatientId) {
    for (const t of [
      "vitals",
      "lab_results",
      "medications",
      "conditions",
      "meal_logs",
      "activity_logs",
      "symptom_logs",
      "medication_logs",
      "patient_reported_side_effects",
      "patient_documents",
    ]) {
      await genie.from(t).delete().eq("patient_id", geniePatientId).then(() => {}).catch(() => {});
    }
    await genie.from("patients").delete().eq("id", geniePatientId).then(() => {}).catch(() => {});
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

(async () => {
  try {
    await createAppPatient();
    await seedAppData();
    const first = await callImport();
    pass(`import returned scribe patient_id=${first.scribePatientId}`);

    await assertCounts("First import — row counts");

    info("re-running import to check idempotency");
    // Need to flip migrated_to_gini back so the convert function will run a
    // second time and exercise the dedup path.
    await genie
      .from("patients")
      .update({ migrated_to_gini: false })
      .eq("id", geniePatientId);
    const second = await callImport({ allowAlreadyMigrated: true });
    info(`second call → ${second.ok ? "ok (re-import permitted)" : `rejected: ${second.reason}`}`);

    await assertCounts("After re-run — row counts (must be identical)");

    await cleanup();
    pass("cleanup complete");

    const passed = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok).length;
    console.log(
      `\n${failed === 0 ? C.green("PASS") : C.red("FAIL")} — ${passed} ok, ${failed} failed.\n`,
    );
    await pool.end();
    process.exit(failed === 0 ? 0 : 1);
  } catch (e) {
    console.error(C.red(`\nUnhandled error: ${e.stack || e.message}\n`));
    try {
      await cleanup();
    } catch {}
    await pool.end().catch(() => {});
    process.exit(2);
  }
})();
