/**
 * One-time script: Remove duplicate medication rows and add a unique partial index
 * to prevent future duplicates.
 *
 * Run: node server/scripts/dedup-medications.js
 */
import { fileURLToPath } from "url";
import { dirname, join } from "path";
const __dirname = dirname(fileURLToPath(import.meta.url));

// Must load env BEFORE importing db.js (ES module imports are hoisted)
const dotenv = await import("dotenv");
dotenv.config({ path: join(__dirname, "..", ".env") });

const { default: pool } = await import("../config/db.js");

async function run() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 0. Ensure updated_at column exists
    await client.query(
      "ALTER TABLE medications ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()",
    );

    // 1. Count before
    const before = await client.query("SELECT COUNT(*) FROM medications");
    console.log(`Total medication rows BEFORE: ${before.rows[0].count}`);

    // 2. Delete duplicate active rows — keep only the most recent per (patient_id, name)
    const delActive = await client.query(`
      DELETE FROM medications a
      USING medications b
      WHERE a.patient_id = b.patient_id
        AND UPPER(COALESCE(a.pharmacy_match, a.name)) = UPPER(COALESCE(b.pharmacy_match, b.name))
        AND a.is_active = true AND b.is_active = true
        AND a.id < b.id
    `);
    console.log(`Deleted ${delActive.rowCount} duplicate ACTIVE rows`);

    // 3. Delete duplicate inactive rows — keep only the most recent per (patient_id, name)
    const delInactive = await client.query(`
      DELETE FROM medications a
      USING medications b
      WHERE a.patient_id = b.patient_id
        AND UPPER(COALESCE(a.pharmacy_match, a.name)) = UPPER(COALESCE(b.pharmacy_match, b.name))
        AND a.is_active = false AND b.is_active = false
        AND a.id < b.id
    `);
    console.log(`Deleted ${delInactive.rowCount} duplicate INACTIVE rows`);

    // 4. Count after
    const after = await client.query("SELECT COUNT(*) FROM medications");
    console.log(`Total medication rows AFTER: ${after.rows[0].count}`);

    // 5. Create unique partial index for active medications
    //    This prevents future duplicates at the database level.
    await client.query(`
      DROP INDEX IF EXISTS medications_patient_active_name_uniq
    `);
    await client.query(`
      CREATE UNIQUE INDEX medications_patient_active_name_uniq
      ON medications (patient_id, UPPER(COALESCE(pharmacy_match, name)))
      WHERE is_active = true
    `);
    console.log("Created unique index: medications_patient_active_name_uniq");

    // 6. Create unique partial index for inactive medications
    await client.query(`
      DROP INDEX IF EXISTS medications_patient_inactive_name_uniq
    `);
    await client.query(`
      CREATE UNIQUE INDEX medications_patient_inactive_name_uniq
      ON medications (patient_id, UPPER(COALESCE(pharmacy_match, name)))
      WHERE is_active = false
    `);
    console.log("Created unique index: medications_patient_inactive_name_uniq");

    await client.query("COMMIT");
    console.log("\nDone! Duplicates removed and indexes created.");
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
