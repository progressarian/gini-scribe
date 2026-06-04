// ─────────────────────────────────────────────────────────────────────────────
// sync-followup-dates.mjs
//
// Backfills the clean `appointments.follow_up_date` column from the HealthRay
// follow-up date that the sync already stores in `biomarkers.followup`
// (HealthRay's `followup_days` field = "Next follow up is scheduled on <date>").
//
// Processes appointments in BATCHES OF 100 and updates the DB correctly.
// Idempotent & safe to re-run — only updates rows whose follow_up_date differs.
//
// Usage:
//   node sync-followup-dates.mjs            # process everything
//   node sync-followup-dates.mjs --dry-run  # show what would change, write nothing
// ─────────────────────────────────────────────────────────────────────────────

import "./server/loadEnv.js";
import pool from "./server/config/db.js";

const DRY_RUN = process.argv.includes("--dry-run");
const BATCH_SIZE = 100;

function isValidDate(s) {
  // Expect YYYY-MM-DD; reject junk so a bad value never corrupts the column
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

async function main() {
  console.log(`\n=== Follow-up date sync ${DRY_RUN ? "(DRY RUN)" : ""} ===`);

  // Candidate rows: have a synced HealthRay follow-up date in biomarkers.followup
  // that is missing from / different to the clean follow_up_date column.
  const { rows: candidates } = await pool.query(
    `SELECT id,
            file_no,
            (biomarkers->>'followup') AS hr_followup,
            follow_up_date::text       AS current_fu
     FROM appointments
     WHERE biomarkers->>'followup' IS NOT NULL
       AND biomarkers->>'followup' <> ''
     ORDER BY id`,
  );

  console.log(`Found ${candidates.length} appointments with a HealthRay follow-up date.\n`);
  if (!candidates.length) {
    await pool.end();
    return;
  }

  let updated = 0;
  let skipped = 0;
  let invalid = 0;
  let batchNo = 0;

  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE);
    batchNo++;

    // Build the rows to actually change in this batch
    const toUpdate = [];
    for (const row of batch) {
      const hr = (row.hr_followup || "").split("T")[0]; // tolerate timestamp form
      if (!isValidDate(hr)) {
        invalid++;
        continue;
      }
      if (row.current_fu === hr) {
        skipped++; // already correct
        continue;
      }
      toUpdate.push({ id: row.id, date: hr });
    }

    if (toUpdate.length && !DRY_RUN) {
      // One UPDATE per batch using unnest — correct & efficient
      const ids = toUpdate.map((r) => r.id);
      const dates = toUpdate.map((r) => r.date);
      await pool.query(
        `UPDATE appointments AS a
         SET follow_up_date = v.d::date,
             updated_at     = NOW()
         FROM (SELECT UNNEST($1::int[]) AS id, UNNEST($2::text[]) AS d) AS v
         WHERE a.id = v.id`,
        [ids, dates],
      );
    }

    updated += toUpdate.length;
    console.log(
      `Batch ${batchNo}: ${toUpdate.length} ${DRY_RUN ? "would update" : "updated"} ` +
        `(running total: ${updated} updated, ${skipped} already-ok, ${invalid} invalid)`,
    );
  }

  console.log(`\n=== Done ===`);
  console.log(`  Updated:      ${updated}`);
  console.log(`  Already OK:   ${skipped}`);
  console.log(`  Invalid date: ${invalid}`);
  console.log(`  Total seen:   ${candidates.length}`);
  if (DRY_RUN) console.log(`  (dry run — no rows were written)`);

  await pool.end();
}

main().catch((e) => {
  console.error("Sync failed:", e.message);
  process.exit(1);
});
