/**
 * One-time script: Fix opd_vitals JSONB entries that have string-with-units
 * values like "137 mmHg", "91 cm", "21.6%" — convert to clean numbers.
 *
 * Run: node server/scripts/fix-opd-vitals-strings.js
 */
import { fileURLToPath } from "url";
import { dirname, join } from "path";
const __dirname = dirname(fileURLToPath(import.meta.url));

const dotenv = await import("dotenv");
dotenv.config({ path: join(__dirname, "..", ".env") });

const { default: pool } = await import("../config/db.js");

const VITAL_KEYS = ["bpSys", "bpDia", "weight", "height", "bmi", "waist", "bodyFat"];

async function run() {
  const client = await pool.connect();
  try {
    // Find appointments where any vital key contains non-numeric characters
    const { rows } = await client.query(`
      SELECT id, opd_vitals
      FROM appointments
      WHERE opd_vitals IS NOT NULL
        AND opd_vitals != '{}'::jsonb
        AND (
          opd_vitals->>'bpSys' ~ '[^0-9.\\-]'
          OR opd_vitals->>'bpDia' ~ '[^0-9.\\-]'
          OR opd_vitals->>'weight' ~ '[^0-9.\\-]'
          OR opd_vitals->>'height' ~ '[^0-9.\\-]'
          OR opd_vitals->>'bmi' ~ '[^0-9.\\-]'
          OR opd_vitals->>'waist' ~ '[^0-9.\\-]'
          OR opd_vitals->>'bodyFat' ~ '[^0-9.\\-]'
        )
    `);

    console.log(`Found ${rows.length} appointments with string-formatted vitals\n`);

    if (rows.length === 0) {
      console.log("Nothing to fix!");
      return;
    }

    await client.query("BEGIN");

    let fixed = 0;
    for (const row of rows) {
      const vitals = row.opd_vitals;
      const patch = {};
      let changed = false;

      for (const key of VITAL_KEYS) {
        const val = vitals[key];
        if (val != null && typeof val === "string" && /[^0-9.\-]/.test(val)) {
          const num = parseFloat(val);
          if (!isNaN(num)) {
            patch[key] = num;
            changed = true;
            console.log(`  Appt ${row.id}: ${key} "${val}" -> ${num}`);
          }
        }
      }

      if (changed) {
        await client.query(
          `UPDATE appointments SET opd_vitals = opd_vitals || $1::jsonb WHERE id = $2`,
          [JSON.stringify(patch), row.id],
        );
        fixed++;
      }
    }

    await client.query("COMMIT");
    console.log(`\nDone! Fixed ${fixed} appointments.`);
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
