// One-shot recovery for lab cases whose PDF download was prematurely written
// off as "unavailable". Background: the old gate flipped pdf_unavailable=TRUE
// the moment HealthRay returned "No Report Found" — which it does for any
// case whose tests aren't all reported yet. Combined with the old caller
// trusting results_synced=TRUE after a single numeric write, hundreds of
// cases got marked unavailable forever even though their reports finalised
// hours later.
//
// What this does:
//   1. Clears pdf_unavailable=TRUE on every row that still has no PDF.
//      The new gate (countAllInhouseResults inside isLabCasePrintable) will
//      re-decide on live HealthRay detail per case, so this won't hammer
//      genuinely-empty cases — they'll just be re-marked unavailable.
//   2. Runs backfillLabPdfs() which now refreshes detail for every row and
//      only downloads when every in-house test has a result.
//
// Usage:
//   node server/scripts/recover-stuck-lab-pdfs.js          # dry-run report
//   node server/scripts/recover-stuck-lab-pdfs.js --apply  # clear + backfill

import "dotenv/config";

const apply = process.argv.includes("--apply");

const { default: pool } = await import("../config/db.js");
const { backfillLabPdfs } = await import("../services/cron/labSync.js");

async function main() {
  const before = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE pdf_unavailable = TRUE AND pdf_storage_path IS NULL) AS unavail_no_pdf,
      COUNT(*) FILTER (WHERE pdf_storage_path IS NULL
                         AND COALESCE(retry_abandoned, FALSE) = FALSE
                         AND COALESCE(pdf_unavailable, FALSE) = FALSE
                         AND patient_id IS NOT NULL) AS already_eligible
    FROM lab_cases
  `);

  console.log("Before:");
  console.log(`  pdf_unavailable + no PDF: ${before.rows[0].unavail_no_pdf}`);
  console.log(`  already eligible for backfill: ${before.rows[0].already_eligible}`);

  if (!apply) {
    console.log("\n(dry run — re-run with --apply to clear flags and download)");
    await pool.end();
    return;
  }

  // Clear the bogus flag. We're intentionally broad: the new gate refuses
  // to download a case that isn't fully reported, so re-triggering this on
  // a genuinely-empty case is harmless — it'll skip with reason
  // "partial-results (0/N)" and we won't even open Puppeteer for it.
  const cleared = await pool.query(
    `UPDATE lab_cases
     SET pdf_unavailable = FALSE
     WHERE pdf_unavailable = TRUE AND pdf_storage_path IS NULL`,
  );
  console.log(`\nCleared pdf_unavailable on ${cleared.rowCount} rows.`);

  console.log("Running backfillLabPdfs… (this can take a while — Puppeteer is throttled)");
  const result = await backfillLabPdfs({ concurrency: 2 });
  console.log("\nBackfill result:", result);

  await pool.end();
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
