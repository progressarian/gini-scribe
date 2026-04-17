/**
 * One-time script: Remove duplicate vitals rows.
 *
 * Three passes:
 *   1. Appointment-linked: keep newest per (patient_id, appointment_id)
 *   2. Consultation-linked: keep newest per (patient_id, consultation_id)
 *   3. Orphan identical: keep newest per (patient_id, date, same values)
 *
 * Run: node server/scripts/dedup-vitals.js
 */
import { fileURLToPath } from "url";
import { dirname, join } from "path";
const __dirname = dirname(fileURLToPath(import.meta.url));

const dotenv = await import("dotenv");
dotenv.config({ path: join(__dirname, "..", ".env") });

const { default: pool } = await import("../config/db.js");

async function run() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 0. Count before
    const before = await client.query("SELECT COUNT(*) FROM vitals");
    console.log(`Total vitals rows BEFORE: ${before.rows[0].count}`);

    // 1. Dedup appointment-linked rows — keep newest per (patient_id, appointment_id)
    const del1 = await client.query(`
      DELETE FROM vitals a
      USING vitals b
      WHERE a.patient_id = b.patient_id
        AND a.appointment_id = b.appointment_id
        AND a.appointment_id IS NOT NULL
        AND a.id < b.id
    `);
    console.log(`Pass 1 — appointment-linked duplicates removed: ${del1.rowCount}`);

    // 2. Dedup consultation-linked rows (no appointment) — keep newest per (patient_id, consultation_id)
    const del2 = await client.query(`
      DELETE FROM vitals a
      USING vitals b
      WHERE a.patient_id = b.patient_id
        AND a.consultation_id = b.consultation_id
        AND a.consultation_id IS NOT NULL
        AND a.appointment_id IS NULL AND b.appointment_id IS NULL
        AND a.id < b.id
    `);
    console.log(`Pass 2 — consultation-linked duplicates removed: ${del2.rowCount}`);

    // 3. Dedup orphan rows (no appointment, no consultation) — identical values on same date
    const del3 = await client.query(`
      DELETE FROM vitals a
      USING vitals b
      WHERE a.patient_id = b.patient_id
        AND a.appointment_id IS NULL AND b.appointment_id IS NULL
        AND a.consultation_id IS NULL AND b.consultation_id IS NULL
        AND a.recorded_at::date = b.recorded_at::date
        AND COALESCE(a.bp_sys, -1) = COALESCE(b.bp_sys, -1)
        AND COALESCE(a.bp_dia, -1) = COALESCE(b.bp_dia, -1)
        AND COALESCE(a.weight, -1) = COALESCE(b.weight, -1)
        AND COALESCE(a.height, -1) = COALESCE(b.height, -1)
        AND COALESCE(a.bmi, -1) = COALESCE(b.bmi, -1)
        AND a.id < b.id
    `);
    console.log(`Pass 3 — orphan identical duplicates removed: ${del3.rowCount}`);

    // 4. Count after
    const after = await client.query("SELECT COUNT(*) FROM vitals");
    console.log(`\nTotal vitals rows AFTER: ${after.rows[0].count}`);
    console.log(`Total removed: ${Number(before.rows[0].count) - Number(after.rows[0].count)}`);

    await client.query("COMMIT");
    console.log("\nDone! Duplicate vitals removed.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Error:", err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

run();
