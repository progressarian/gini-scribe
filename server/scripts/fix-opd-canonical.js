/**
 * One-time: Fix OPD lab_results rows that have lowercase canonical_name values.
 * Run: node server/scripts/fix-opd-canonical.js
 */
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), "..", ".env") });

const { default: pool } = await import("../config/db.js");

const FIXES = {
  hba1c: "HbA1c",
  fasting_glucose: "FBS",
  ldl: "LDL",
  triglycerides: "Triglycerides",
  uacr: "UACR",
  creatinine: "Creatinine",
  tsh: "TSH",
  hemoglobin: "Haemoglobin",
};

let total = 0;
for (const [old, correct] of Object.entries(FIXES)) {
  const r = await pool.query(
    `UPDATE lab_results SET canonical_name = $1 WHERE canonical_name = $2`,
    [correct, old],
  );
  if (r.rowCount > 0) {
    console.log(`  ${old} → ${correct}: ${r.rowCount} rows`);
    total += r.rowCount;
  }
}
console.log(`Done. Fixed ${total} rows.`);
await pool.end();
