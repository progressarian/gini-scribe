// ── Revert the split-reassigned-uhids backfill run ──────────────────────────
//
// Undoes the patient-split backfill applied on 2026-07-14 09:52–09:55. For each
// split-out patient row created in that window, it moves EVERY row that
// references the split row (across all FK tables) back to the original patient,
// restores the original patient's file_no, and deletes the split row.
//
// It ONLY touches rows created in the backfill window — the 13 older multi-owner
// file_nos (April–June, from unrelated historical data messiness) are left
// alone. DRY-RUN by default; pass --apply to write. Each patient is reverted in
// its own transaction.
//
// NOTE: it cannot restore the pre-backfill patients.name (the backfill titleCased
// it and the original was not recorded). The name is left at its current value —
// cosmetic only; the row again represents the same person. All DATA moves are
// fully reverted.
//
// Usage (from gini-scribe/server):
//   node scripts/revert-backfill-splits.mjs           # dry-run
//   node scripts/revert-backfill-splits.mjs --apply   # execute

import "../loadEnv.js";
import pool from "../config/db.js";

const APPLY = process.argv.includes("--apply");
const WINDOW_START = "2026-07-14 09:50:00+00";
const WINDOW_END = "2026-07-14 10:10:00+00"; // generous upper bound for the run

async function fkTables() {
  const { rows } = await pool.query(
    `SELECT tc.table_name, kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
       JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
      WHERE tc.constraint_type='FOREIGN KEY' AND ccu.table_name='patients' AND ccu.column_name='id'`,
  );
  // flow_visits references patients via patient_db_id (already covered if FK exists).
  return rows.map((r) => ({ table: r.table_name, col: r.column_name }));
}

// Identify each backfill split row and its original (primary) patient.
async function findReverts() {
  const { rows } = await pool.query(
    `WITH spans AS (
       SELECT file_no, array_agg(DISTINCT patient_id ORDER BY patient_id) AS pids
         FROM appointments WHERE file_no LIKE 'P/_%' ESCAPE '/'
         GROUP BY file_no HAVING COUNT(DISTINCT patient_id) > 1
     ),
     split_rows AS (
       SELECT s.file_no, p.id AS split_id
         FROM spans s
         JOIN patients p ON p.id = ANY(s.pids)
        WHERE p.created_at >= $1 AND p.created_at < $2
     )
     SELECT sr.file_no, sr.split_id,
            (SELECT array_agg(DISTINCT a.patient_id)
               FROM appointments a
              WHERE a.file_no = sr.file_no AND a.patient_id <> sr.split_id) AS other_pids
       FROM split_rows sr
      ORDER BY sr.split_id`,
    [WINDOW_START, WINDOW_END],
  );
  return rows;
}

async function main() {
  console.log(`\n=== revert-backfill-splits — ${APPLY ? "APPLY (writing)" : "DRY-RUN"} ===\n`);
  const tables = await fkTables();
  const reverts = await findReverts();
  console.log(`Split rows to revert: ${reverts.length}\n`);

  const client = await pool.connect();
  let ok = 0;
  let skipped = 0;
  try {
    for (const r of reverts) {
      const others = (r.other_pids || []).filter((x) => x != null);
      const { rows: sp } = await client.query(`SELECT name, file_no FROM patients WHERE id = $1`, [
        r.split_id,
      ]);
      const splitName = sp[0]?.name;

      if (others.length !== 1) {
        console.log(
          `⚠ SKIP file_no=${r.file_no} split #${r.split_id} "${splitName}": ambiguous primary (candidates: ${others.join(", ") || "none"})`,
        );
        skipped++;
        continue;
      }
      const primary = others[0];
      const { rows: pr } = await client.query(`SELECT name, file_no FROM patients WHERE id = $1`, [
        primary,
      ]);

      console.log(
        `file_no=${r.file_no}: merge split #${r.split_id} "${splitName}" → primary #${primary} "${pr[0]?.name}"`,
      );

      // Count what will move, per table.
      const moveCounts = [];
      for (const t of tables) {
        const { rows: c } = await client.query(
          `SELECT COUNT(*)::int n FROM ${t.table} WHERE ${t.col} = $1`,
          [r.split_id],
        );
        if (c[0].n > 0) moveCounts.push(`${t.table}=${c[0].n}`);
      }
      console.log(`   moves: ${moveCounts.join(" ") || "(none)"}`);

      if (APPLY) {
        try {
          await client.query("BEGIN");
          for (const t of tables) {
            await client.query("SAVEPOINT mv");
            try {
              await client.query(`UPDATE ${t.table} SET ${t.col} = $1 WHERE ${t.col} = $2`, [
                primary,
                r.split_id,
              ]);
              await client.query("RELEASE SAVEPOINT mv");
            } catch (e2) {
              if (e2.code !== "23505") throw e2;
              // Merging into primary hit a per-patient unique constraint (the
              // primary already has the equivalent row). Move each row that can
              // move; delete the split's true duplicates. Requires an `id` PK.
              await client.query("ROLLBACK TO SAVEPOINT mv");
              const { rows: ids } = await client.query(
                `SELECT id FROM ${t.table} WHERE ${t.col} = $1`,
                [r.split_id],
              );
              let dropped = 0;
              for (const row of ids) {
                await client.query("SAVEPOINT rowmv");
                try {
                  await client.query(`UPDATE ${t.table} SET ${t.col} = $1 WHERE id = $2`, [
                    primary,
                    row.id,
                  ]);
                  await client.query("RELEASE SAVEPOINT rowmv");
                } catch (e3) {
                  if (e3.code !== "23505") throw e3;
                  await client.query("ROLLBACK TO SAVEPOINT rowmv");
                  await client.query(`DELETE FROM ${t.table} WHERE id = $1`, [row.id]);
                  await client.query("RELEASE SAVEPOINT rowmv");
                  dropped++;
                }
              }
              await client.query("RELEASE SAVEPOINT mv");
              console.log(`      ${t.table}: merged with ${dropped} duplicate(s) dropped`);
            }
          }
          // Remove the split row FIRST (frees its file_no), THEN restore the UHID
          // to the primary — file_no is unique among current owners.
          await client.query(`DELETE FROM patients WHERE id = $1`, [r.split_id]);
          await client.query(`UPDATE patients SET file_no = $1, updated_at = NOW() WHERE id = $2`, [
            r.file_no,
            primary,
          ]);
          await client.query("COMMIT");
          console.log(`   ✓ reverted, deleted #${r.split_id}`);
          ok++;
        } catch (e) {
          await client.query("ROLLBACK");
          console.error(`   ✗ FAILED #${r.split_id}: ${e.message} — rolled back`);
          skipped++;
        }
      }
    }
  } finally {
    client.release();
  }

  console.log(`\n=== TOTALS === reverted=${APPLY ? ok : "(dry-run)"} skipped=${skipped}`);
  if (!APPLY) console.log("DRY-RUN only. Re-run with --apply to write.");
  await pool.end();
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
