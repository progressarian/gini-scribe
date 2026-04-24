/**
 * End-to-end smoke test for the Scribe -> Genie push path for medications
 * and labs (the conditions path was already working; this verifies that the
 * newly-added syncMedicationsToGenie / syncLabsToGenie helpers behave the
 * same way as syncDiagnosesToGenie).
 *
 * Steps:
 *   1. Find TEST_COMPANION_USER in scribe Postgres
 *   2. Link / resolve the Genie patient UUID
 *   3. Insert one medication row and one lab_results row into scribe Postgres
 *   4. Invoke syncMedicationsToGenie and syncLabsToGenie
 *   5. Query Supabase to confirm the rows appear with source='scribe'
 *
 * Run:
 *   node server/scripts/test-scribe-push-sync.js
 *   node server/scripts/test-scribe-push-sync.js --file-no FOO
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
const {
  syncMedicationsToGenie,
  syncLabsToGenie,
  syncAppointmentToGenie,
  syncCareTeamToGenie,
  resolveGeniePatientId,
} = require("../genie-sync.cjs");

const fileNoIdx = process.argv.indexOf("--file-no");
const FILE_NO = fileNoIdx > -1 ? process.argv[fileNoIdx + 1] : "TEST_COMPANION_USER";

const GENIE_URL = process.env.GENIE_SUPABASE_URL;
const GENIE_KEY = process.env.GENIE_SUPABASE_SERVICE_KEY;

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

  // 1. Seed a medication in scribe Postgres (upsert by partial-unique index).
  const medName = "Metformin SyncTest";
  const med = await pool.query(
    `INSERT INTO medications (patient_id, name, pharmacy_match, dose, frequency, timing, route, is_active, started_date, source)
     VALUES ($1,$2,UPPER($2),$3,$4,$5,'Oral',true,CURRENT_DATE,'visit')
     ON CONFLICT (patient_id, UPPER(COALESCE(pharmacy_match, name))) WHERE is_active = true
     DO UPDATE SET dose = EXCLUDED.dose, frequency = EXCLUDED.frequency,
                   timing = EXCLUDED.timing, updated_at = NOW()
     RETURNING id, name, dose, frequency, timing`,
    [scribePatient.id, medName, "500mg", "BID", "After meals"],
  );
  console.log(`Seeded medication: id=${med.rows[0].id} name=${med.rows[0].name}`);

  // 2. Seed a lab in scribe Postgres.
  const labTest = "HbA1cSyncTest";
  const lab = await pool.query(
    `INSERT INTO lab_results (patient_id, test_name, canonical_name, result, unit, test_date, source)
     VALUES ($1,$2,$3,$4,$5,CURRENT_DATE,'manual')
     RETURNING id, test_name, result, unit, test_date`,
    [scribePatient.id, labTest, labTest.toLowerCase(), 6.8, "%"],
  );
  console.log(`Seeded lab: id=${lab.rows[0].id} name=${lab.rows[0].test_name}`);

  // 3. Invoke the new push helpers.
  console.log("\n--- syncMedicationsToGenie ---");
  const medRes = await syncMedicationsToGenie(scribePatient.id, pool);
  console.log(JSON.stringify(medRes, null, 2));

  console.log("\n--- syncLabsToGenie ---");
  const labRes = await syncLabsToGenie(scribePatient.id, pool);
  console.log(JSON.stringify(labRes, null, 2));

  // 4. Read back from Supabase to confirm rows landed with source='scribe'.
  const expectedMedSid = `gini-med-${med.rows[0].id}`;
  const expectedLabSid = `gini-lab-${lab.rows[0].id}`;

  const { data: remoteMeds, error: rmErr } = await genie
    .from("medications")
    .select("source_id, name, dose, timing, notes, is_active, source")
    .eq("patient_id", genieId)
    .eq("source_id", expectedMedSid);
  if (rmErr) console.error("Supabase read medications failed:", rmErr.message);
  else {
    console.log(`\nSupabase medications (source='scribe') rows: ${remoteMeds.length}`);
    for (const m of remoteMeds) console.log(" ", m);
  }

  const { data: remoteLabs, error: rlErr } = await genie
    .from("lab_results")
    .select("source_id, test_name, value, unit, status, source, test_date")
    .eq("patient_id", genieId)
    .eq("source_id", expectedLabSid);
  if (rlErr) console.error("Supabase read lab_results failed:", rlErr.message);
  else {
    console.log(`\nSupabase lab_results (source='scribe') rows: ${remoteLabs.length}`);
    for (const l of remoteLabs) console.log(" ", l);
  }

  const medHit = (remoteMeds || []).some((r) => r.source_id === expectedMedSid);
  const labHit = (remoteLabs || []).some((r) => r.source_id === expectedLabSid);

  // 5. Seed a scribe appointment + reassign doctor, then verify push.
  const apptDate = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString().split("T")[0];
  const testDoctor = "Dr. SyncTest";
  const appt = await pool.query(
    `INSERT INTO appointments (patient_id, patient_name, file_no, phone, doctor_name, appointment_date, time_slot, visit_type, status)
     VALUES ($1,$2,$3,$4,$5,$6::date,'10:00','OPD','scheduled') RETURNING id, appointment_date, doctor_name`,
    [
      scribePatient.id,
      scribePatient.name,
      scribePatient.file_no,
      scribePatient.phone,
      testDoctor,
      apptDate,
    ],
  );
  console.log(
    `\nSeeded appointment: id=${appt.rows[0].id} date=${appt.rows[0].appointment_date} doctor=${appt.rows[0].doctor_name}`,
  );

  console.log("\n--- syncAppointmentToGenie ---");
  const apptRes = await syncAppointmentToGenie(scribePatient.id, pool);
  console.log(JSON.stringify(apptRes, null, 2));

  console.log("\n--- syncCareTeamToGenie ---");
  const ctRes = await syncCareTeamToGenie(scribePatient.id, pool);
  console.log(JSON.stringify(ctRes, null, 2));

  // Genie appointments are upserted by (patient_id, source_id). We push the
  // "next upcoming" row, so that's what we expect landed.
  const expectedApptSid = `gini-appt-${appt.rows[0].id}`;
  const { data: remoteAppts, error: raErr } = await genie
    .from("appointments")
    .select("source_id, appointment_date, doctor_name, status, source")
    .eq("patient_id", genieId)
    .eq("source_id", expectedApptSid);
  if (raErr) console.error("Supabase read appointments failed:", raErr.message);
  else {
    console.log(`\nSupabase appointments matching source_id: ${remoteAppts.length}`);
    for (const a of remoteAppts) console.log(" ", a);
  }
  const apptHit = (remoteAppts || []).some((r) => r.source_id === expectedApptSid);

  // gini_sync_care_team updates patients.doctor_name (no separate table row).
  const { data: remotePatient, error: rpErr } = await genie
    .from("patients")
    .select("id, doctor_name")
    .eq("id", genieId)
    .maybeSingle();
  if (rpErr) console.error("Supabase read patient doctor failed:", rpErr.message);
  else console.log(`\nGenie patient.doctor_name: ${remotePatient?.doctor_name}`);
  const ctHit = remotePatient?.doctor_name === testDoctor;

  console.log("\n=== RESULT ===");
  console.log(`Medication (${expectedMedSid}) landed on Genie: ${medHit ? "YES" : "NO"}`);
  console.log(`Lab        (${expectedLabSid}) landed on Genie: ${labHit ? "YES" : "NO"}`);
  console.log(`Appointment(${expectedApptSid}) landed on Genie: ${apptHit ? "YES" : "NO"}`);
  console.log(`Care team doctor_name on Genie: ${ctHit ? "YES" : "NO"}`);

  if (!medHit || !labHit || !apptHit || !ctHit) process.exitCode = 1;
}

run()
  .catch((err) => {
    console.error("Fatal:", err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
