/**
 * Create a dummy test patient for Companion / capture testing.
 *
 * Marked with file_no = "TEST_COMPANION_USER" and phone = "+919999999001"
 * so delete-test-patient.js can find and remove it.
 *
 * Idempotent — if the patient already exists in gini-scribe, prints the id.
 * After the local insert we also mirror the patient into MyHealth Genie so
 * the phone-OTP login on the mobile side resolves to a `gini_patient` row.
 *
 * Run:
 *   node server/scripts/create-test-patient.js
 */
import { fileURLToPath } from "url";
import { dirname, join } from "path";
const __dirname = dirname(fileURLToPath(import.meta.url));

const dotenv = await import("dotenv");
dotenv.config({ path: join(__dirname, "..", ".env") });

const { default: pool } = await import("../config/db.js");

const { createRequire } = await import("module");
const require = createRequire(import.meta.url);
let syncPatientToGenie = null;
try {
  syncPatientToGenie = require("../genie-sync.cjs").syncPatientToGenie;
} catch (e) {
  console.warn("[create-test-patient] genie-sync.cjs not loaded:", e.message);
}

const TEST = {
  name: "Test Patient (Companion)",
  phone: "+919999999001",
  file_no: "TEST_COMPANION_USER",
  dob: "1985-06-15",
  age: 40,
  sex: "Male",
  email: "test-companion@example.com",
  blood_group: "O+",
  address: "Test Address — safe to delete",
  notes: "DUMMY PATIENT — created by scripts/create-test-patient.js",
};

async function mirrorToGenie(row) {
  if (!syncPatientToGenie) {
    console.log("(Skipped MyHealth Genie mirror — GENIE_SUPABASE_URL/KEY not set?)");
    return;
  }
  const r = await syncPatientToGenie(row);
  if (r?.synced) {
    console.log(`Mirrored to MyHealth Genie: mhgPatientId=${r.mhgPatientId}`);
  } else {
    console.warn(`MyHealth Genie mirror failed: ${r?.reason || "unknown"}`);
  }
}

async function run() {
  const client = await pool.connect();
  try {
    const existing = await client.query(
      "SELECT id, name, file_no, phone, dob, sex, blood_group FROM patients WHERE file_no = $1",
      [TEST.file_no],
    );
    if (existing.rows.length > 0) {
      const p = existing.rows[0];
      console.log(`Already exists: id=${p.id}  file_no=${p.file_no}  name=${p.name}`);
      console.log();
      console.log(`  /companion/capture/${p.id}`);
      console.log(`  /companion/multi-capture/${p.id}`);
      console.log(`  /companion/record/${p.id}`);
      console.log();
      await mirrorToGenie(p);
      return;
    }

    const r = await client.query(
      `INSERT INTO patients (name, phone, file_no, dob, age, sex, email, blood_group, address, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id, name, file_no, phone, dob, sex, blood_group`,
      [
        TEST.name,
        TEST.phone,
        TEST.file_no,
        TEST.dob,
        TEST.age,
        TEST.sex,
        TEST.email,
        TEST.blood_group,
        TEST.address,
        TEST.notes,
      ],
    );
    const p = r.rows[0];
    console.log(`Created: id=${p.id}  file_no=${p.file_no}  name=${p.name}`);
    console.log();
    console.log("Test URLs:");
    console.log(`  /companion/capture/${p.id}`);
    console.log(`  /companion/multi-capture/${p.id}`);
    console.log(`  /companion/record/${p.id}`);
    console.log();
    await mirrorToGenie(p);
    console.log();
    console.log(`To wipe when done:`);
    console.log(`  node server/scripts/delete-test-patient.js --apply`);
  } catch (e) {
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
