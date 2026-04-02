/**
 * One-time script: Backfill canonical_name on lab_results that are missing it.
 * Run: node server/scripts/backfill-canonical.js
 */
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, "..", ".env") });

const { default: pool } = await import("../config/db.js");
const { getCanonical } = await import("../utils/labCanonical.js");

async function run() {
  // Get all distinct test_names that have NULL canonical_name
  const { rows } = await pool.query(
    `SELECT DISTINCT test_name FROM lab_results WHERE canonical_name IS NULL AND test_name IS NOT NULL`,
  );
  console.log(`Found ${rows.length} distinct test names without canonical_name`);

  let updated = 0;
  for (const { test_name } of rows) {
    const canonical = getCanonical(test_name);
    if (canonical) {
      const r = await pool.query(
        `UPDATE lab_results SET canonical_name = $1 WHERE test_name = $2 AND canonical_name IS NULL`,
        [canonical, test_name],
      );
      console.log(`  ${test_name} → ${canonical} (${r.rowCount} rows)`);
      updated += r.rowCount;
    }
  }
  console.log(`\nDone! Updated ${updated} rows.`);
  await pool.end();
}

run();
