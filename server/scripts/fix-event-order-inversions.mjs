import "../loadEnv.js";
import pool from "../config/db.js";

const visitIds = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const apply = process.argv.includes("--apply");

if (!visitIds.length) {
  console.error("usage: node scripts/fix-event-order-inversions.mjs <visitId> [more] [--apply]");
  process.exit(1);
}

const run = async () => {
  for (const visitId of visitIds) {
    const { rows } = await pool.query(
      `SELECT seq, status, actor_role, occurred_at, meta
         FROM giniflow_visit_events WHERE visit_id = $1 ORDER BY seq`,
      [visitId],
    );
    if (!rows.length) {
      console.log(`${visitId}: no events`);
      continue;
    }

    const fixes = [];
    let high = rows[0].occurred_at;
    for (const row of rows.slice(1)) {
      if (row.occurred_at > high) {
        high = row.occurred_at;
        continue;
      }
      const corrected = new Date(high.getTime() + 1);
      fixes.push({ ...row, corrected });
      high = corrected;
    }

    console.log(`\n${visitId} — ${rows.length} event(s), ${fixes.length} out of order`);
    for (const row of rows) {
      const fix = fixes.find((f) => f.seq === row.seq);
      console.log(
        `  ${row.seq} ${row.status.padEnd(14)} ${String(row.actor_role).padEnd(10)} ` +
          `${row.occurred_at.toISOString()}${fix ? `  ->  ${fix.corrected.toISOString()}` : ""}`,
      );
    }

    if (!apply || !fixes.length) continue;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const fix of fixes) {
        await client.query(
          `UPDATE giniflow_visit_events
              SET occurred_at = $2,
                  meta = COALESCE(meta, '{}'::jsonb)
                         || jsonb_build_object('original_occurred_at', $3::text,
                                               'corrected_reason', 'event_order_inversion')
            WHERE visit_id = $1 AND seq = $4`,
          [visitId, fix.corrected, fix.occurred_at.toISOString(), fix.seq],
        );
      }
      await client.query("COMMIT");
      console.log(`  applied: ${fixes.length} event(s) corrected`);
    } catch (e) {
      await client.query("ROLLBACK");
      console.error(`  FAILED, rolled back: ${e.message}`);
    } finally {
      client.release();
    }
  }
  await pool.end();
};

run();
