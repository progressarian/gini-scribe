/**
 * One-off backfill: populate lab_results.panel_name for existing lab_healthray
 * rows using the category already present in lab_cases.raw_detail_json.
 *
 * Idempotent — only writes when panel_name IS NULL.
 *
 * Run:
 *   node server/scripts/backfill-lab-panel-names.js
 *   node server/scripts/backfill-lab-panel-names.js --dry-run
 */
import { fileURLToPath } from "url";
import { dirname, join } from "path";
const __dirname = dirname(fileURLToPath(import.meta.url));

const dotenv = await import("dotenv");
dotenv.config({ path: join(__dirname, "..", ".env") });

const { default: pool } = await import("../config/db.js");
const { parseLabCaseResults } = await import("../services/lab/labHealthrayParser.js");

const dryRun = process.argv.includes("--dry-run");
console.log(`Backfill lab panel_names — dry-run=${dryRun}`);

const { rows: cases } = await pool.query(
  `SELECT case_no, patient_id, case_date, raw_detail_json
     FROM lab_cases
    WHERE raw_detail_json IS NOT NULL
      AND patient_id IS NOT NULL
      AND results_synced = TRUE
    ORDER BY case_date DESC`,
);

console.log(`Found ${cases.length} synced cases to inspect`);

let touched = 0;
for (const c of cases) {
  const results = parseLabCaseResults(c.raw_detail_json);
  if (!results.length) continue;
  const caseDate =
    typeof c.case_date === "string"
      ? c.case_date.slice(0, 10)
      : c.case_date?.toISOString().slice(0, 10) || null;
  if (!caseDate) continue;

  for (const r of results) {
    if (!r.category || !r.canonicalName) continue;
    if (dryRun) continue;
    const { rowCount } = await pool.query(
      `UPDATE lab_results
          SET panel_name = $1
        WHERE patient_id = $2
          AND canonical_name = $3
          AND test_date::date = $4::date
          AND source = 'lab_healthray'
          AND panel_name IS NULL`,
      [r.category, c.patient_id, r.canonicalName, caseDate],
    );
    touched += rowCount;
  }
}

console.log(`Updated ${touched} lab_results rows`);
await pool.end();
