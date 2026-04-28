/**
 * End-to-end smoke test for the Track → Genie → Scribe pipeline.
 *
 * Seeds one row in each of the 5 Genie Supabase tables (vitals with a
 * NULL source, activity_logs, symptom_logs, meal_logs, medication_logs)
 * for TEST_COMPANION_USER, then runs syncPatientLogsFromGenie and prints
 * the count per table. Each returned count should be >= 1.
 *
 * Re-runnable: each run appends a new row per table (they are logs, so
 * duplication is expected); the scribe-side ON CONFLICT(genie_id) keeps
 * the local mirror stable.
 *
 * Run:
 *   node server/scripts/test-track-sync.js
 *   node server/scripts/test-track-sync.js --file-no FOO
 */
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { createRequire } from "module";

const __dirname = dirname(fileURLToPath(import.meta.url));

const dotenv = await import("dotenv");
dotenv.config({ path: join(__dirname, "..", ".env") });

const { default: pool } = await import("../config/db.js");

const require = createRequire(import.meta.url);
const { createClient } = require("@supabase/supabase-js");
const { syncPatientLogsFromGenie, resolveGeniePatientId } = require("../genie-sync.cjs");

const fileNoIdx = process.argv.indexOf("--file-no");
const FILE_NO = fileNoIdx > -1 ? process.argv[fileNoIdx + 1] : "TEST_COMPANION_USER";

const GENIE_URL = process.env.GENIE_SUPABASE_URL;
const GENIE_KEY = process.env.GENIE_SUPABASE_SERVICE_KEY;

function todayStr() {
  return new Date().toISOString().split("T")[0];
}
function nowTime() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

async function run() {
  if (!GENIE_URL || !GENIE_KEY) {
    console.error("GENIE_SUPABASE_URL / GENIE_SUPABASE_SERVICE_KEY not set in server/.env");
    process.exitCode = 1;
    return;
  }

  const p = await pool.query("SELECT id, name, file_no, phone FROM patients WHERE file_no = $1", [
    FILE_NO,
  ]);
  if (p.rows.length === 0) {
    console.error(`No local patient with file_no=${FILE_NO}. Run create-test-patient.js first.`);
    process.exitCode = 1;
    return;
  }
  const scribePatient = p.rows[0];
  console.log(`Scribe patient: id=${scribePatient.id} name=${scribePatient.name}`);

  const genie = createClient(GENIE_URL, GENIE_KEY);

  // Link/create the Genie-side patient so resolveGeniePatientId can find it.
  const { error: linkErr } = await genie.rpc("gini_link_patient", {
    p_gini_id: String(scribePatient.id),
    p_name: scribePatient.name,
    p_phone: scribePatient.phone,
    p_dob: null,
    p_sex: null,
    p_blood_group: null,
    p_uhid: scribePatient.file_no,
  });
  if (linkErr) {
    console.error("gini_link_patient failed:", linkErr.message);
    process.exitCode = 1;
    return;
  }

  const genieId = await resolveGeniePatientId(scribePatient.id);
  if (!genieId) {
    console.error("resolveGeniePatientId returned null after linking.");
    process.exitCode = 1;
    return;
  }
  console.log(`Genie patient UUID: ${genieId}`);

  // Ensure a medication exists for medication_logs to reference.
  const { data: existingMed } = await genie
    .from("medications")
    .select("id")
    .eq("patient_id", genieId)
    .limit(1)
    .maybeSingle();
  let medId = existingMed?.id;
  if (!medId) {
    const { data: newMed, error: medErr } = await genie
      .from("medications")
      .insert({
        patient_id: genieId,
        name: "Test Med (Track Sync)",
        dose: "10mg",
        is_active: true,
      })
      .select("id")
      .single();
    if (medErr) {
      console.error("insert medication failed:", medErr.message);
      process.exitCode = 1;
      return;
    }
    medId = newMed.id;
  }
  console.log(`Medication id: ${medId}`);

  const today = todayStr();
  const t = nowTime();

  const seeds = [
    [
      "vitals",
      {
        patient_id: genieId,
        recorded_date: today,
        reading_time: t,
        bp_systolic: 120,
        bp_diastolic: 80,
        pulse: 72,
        // source intentionally omitted — verifies the NULL-source sync fix
      },
    ],
    [
      "activity_logs",
      {
        patient_id: genieId,
        activity_type: "Exercise",
        value: "Walk",
        value2: "30",
        context: "TEST_TRACK_SYNC",
        duration_minutes: 30,
        log_date: today,
        log_time: t,
      },
    ],
    [
      "symptom_logs",
      {
        patient_id: genieId,
        symptom: "Test Headache",
        severity: 3,
        body_area: "Head",
        context: "TEST_TRACK_SYNC",
        follow_up_needed: false,
        log_date: today,
        log_time: t,
      },
    ],
    [
      "meal_logs",
      {
        patient_id: genieId,
        meal_type: "Snack",
        description: "TEST_TRACK_SYNC apple",
        calories: 95,
        protein_g: 0.5,
        carbs_g: 25,
        fat_g: 0.3,
        log_date: today,
      },
    ],
    [
      "medication_logs",
      {
        patient_id: genieId,
        medication_id: medId,
        log_date: today,
        dose_time: t,
        status: "taken",
      },
    ],
    [
      "lab_results",
      {
        patient_id: genieId,
        test_name: "HbA1c",
        value: 6.7,
        unit: "%",
        reference_range: "<5.7",
        status: "high",
        lab_name: "Self-logged",
        test_date: today,
        source: "patient", // pull filter is .eq("source","patient")
      },
    ],
  ];

  for (const [table, row] of seeds) {
    const { error } = await genie.from(table).insert(row);
    if (error) {
      console.error(`insert into ${table} failed:`, error.message);
      process.exitCode = 1;
      return;
    }
    console.log(`seeded ${table}`);
  }

  console.log("\nRunning syncPatientLogsFromGenie…");
  const result = await syncPatientLogsFromGenie(scribePatient.id, pool);
  console.log(JSON.stringify(result, null, 2));

  if (!result.synced) {
    console.error("\nSync failed — see reason above.");
    process.exitCode = 1;
    return;
  }

  console.log("\nLocal mirror counts (patient_*_log):");
  const tables = [
    "patient_vitals_log",
    "patient_activity_log",
    "patient_symptom_log",
    "patient_med_log",
    "patient_meal_log",
  ];
  for (const t of tables) {
    const r = await pool.query(`SELECT COUNT(*)::int AS c FROM ${t} WHERE patient_id = $1`, [
      scribePatient.id,
    ]);
    console.log(`  ${t.padEnd(22)} ${r.rows[0].c}`);
  }

  // Verify the patient-app lab landed in scribe lab_results via the new
  // genie_id pull path (added 2026-04-28). source='patient_app' is the
  // tag genie-sync.cjs writes for these rows.
  const labCheck = await pool.query(
    `SELECT id, genie_id, test_name, result, source
       FROM lab_results
      WHERE patient_id = $1 AND source = 'patient_app'
      ORDER BY created_at DESC LIMIT 5`,
    [scribePatient.id],
  );
  console.log(`\nlab_results (source='patient_app') for this patient: ${labCheck.rows.length}`);
  labCheck.rows.forEach((r) =>
    console.log(`  test=${r.test_name} result=${r.result} genie_id=${r.genie_id}`),
  );
  if (labCheck.rows.length === 0) {
    console.error("FAIL: no lab_results landed in scribe — check upsertFailures.labs above");
    process.exitCode = 1;
  }

  if (result.upsertFailures && Object.values(result.upsertFailures).some((v) => v > 0)) {
    console.error("\nUpsert failures detected:", result.upsertFailures);
    process.exitCode = 1;
  }
}

try {
  await run();
} finally {
  await pool.end();
}
