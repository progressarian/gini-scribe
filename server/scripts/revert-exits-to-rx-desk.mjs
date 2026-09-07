import "../loadEnv.js";
import pool from "../config/db.js";

const APPLY = process.argv.includes("--apply");

const TARGETS_SQL = `
  SELECT v.id AS visit_id, p.name, v.current_status,
         rec.occurred_at AS recovered_at,
         (SELECT count(*)::int FROM giniflow_visit_events e
           WHERE e.visit_id = v.id
             AND e.occurred_at >= rec.occurred_at
             AND e.status IN ('rx_pending', 'with_rx')) AS events_to_remove
    FROM giniflow_visits v
    JOIN patients p ON p.id = v.patient_id
    JOIN LATERAL (
      SELECT occurred_at FROM giniflow_visit_events e
       WHERE e.visit_id = v.id AND e.meta->>'source' = 'recover-exits-to-rx-desk'
       ORDER BY e.occurred_at LIMIT 1
    ) rec ON TRUE
   ORDER BY p.name`;

const { rows: targets } = await pool.query(TARGETS_SQL);

console.log(`${APPLY ? "APPLY" : "DRY RUN"} — ${targets.length} visit(s) to put back to exited\n`);
console.table(
  targets.map((t) => ({
    name: t.name.slice(0, 24),
    now: t.current_status,
    events_to_remove: t.events_to_remove,
  })),
);

if (!targets.length) {
  console.log("Nothing to revert.");
  await pool.end();
  process.exit(0);
}

if (!APPLY) {
  console.log("\nNothing written. Re-run with --apply.");
  await pool.end();
  process.exit(0);
}

let reverted = 0;
let failed = 0;

for (const t of targets) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `DELETE FROM giniflow_visit_events
        WHERE visit_id = $1
          AND occurred_at >= $2
          AND status IN ('rx_pending', 'with_rx')`,
      [t.visit_id, t.recovered_at],
    );

    await client.query(
      `UPDATE giniflow_visits
          SET current_status = 'exited', queue_position = NULL, queue_column = NULL,
              updated_at = NOW()
        WHERE id = $1`,
      [t.visit_id],
    );

    await client.query("COMMIT");
    reverted += 1;
  } catch (e) {
    await client.query("ROLLBACK");
    failed += 1;
    console.error(`  ${t.name}: ${e.message}`);
  } finally {
    client.release();
  }
}

console.log(`\nreverted ${reverted}, failed ${failed}`);
await pool.end();
