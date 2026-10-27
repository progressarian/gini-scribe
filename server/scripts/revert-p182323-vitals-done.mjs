import "../loadEnv.js";
import pool from "../config/db.js";

const VISIT_ID = "be4b3ef4-bffb-49cc-ab22-5e13e6527f88";
const REASON = "vitals_recorded_in_healthray";
const commit = process.argv.includes("--commit");

const show = async (db) => {
  const { rows } = await db.query(
    `SELECT s.step_order, s.step_name, s.status, v.current_status,
            to_char(s.completed_at AT TIME ZONE 'Asia/Kolkata', 'HH24:MI') AS at
       FROM giniflow_visit_steps s JOIN giniflow_visits v ON v.id = s.visit_id
      WHERE s.visit_id = $1 ORDER BY s.step_order`,
    [VISIT_ID],
  );
  console.log(`status: ${rows[0]?.current_status}`);
  for (const r of rows)
    console.log(`  ${r.step_order}. ${r.step_name} — ${r.status}${r.at ? ` ${r.at}` : ""}`);
};

const client = await pool.connect();
try {
  await client.query("BEGIN");
  const { rows: visit } = await client.query(
    `SELECT current_status FROM giniflow_visits WHERE id = $1 FOR UPDATE`,
    [VISIT_ID],
  );
  const { rows: later } = await client.query(
    `SELECT e.status, e.meta FROM giniflow_visit_events e
      WHERE e.visit_id = $1
        AND e.occurred_at >= (SELECT occurred_at FROM giniflow_visit_events
                               WHERE visit_id = $1 AND meta->>'reason' = $2)
      ORDER BY e.occurred_at`,
    [VISIT_ID, REASON],
  );
  console.log("events from the mark-done on:", later.map((e) => e.status));
  if (visit[0].current_status !== "sd_pending" || later.length !== 1)
    throw new Error("The patient has moved since the mark-done — stop and recheck");
  const removed = await client.query(
    `DELETE FROM giniflow_visit_events WHERE visit_id = $1 AND meta->>'reason' = $2`,
    [VISIT_ID, REASON],
  );
  await client.query(
    `UPDATE giniflow_visits SET current_status = 'checked_in', updated_at = NOW() WHERE id = $1`,
    [VISIT_ID],
  );
  const step = await client.query(
    `UPDATE giniflow_visit_steps SET status = 'pending', started_at = NULL, completed_at = NULL
      WHERE visit_id = $1 AND step_catalog_id = 'vitals' AND status = 'done'`,
    [VISIT_ID],
  );
  console.log(`event removed: ${removed.rowCount}, vitals step reset: ${step.rowCount}`);
  await show(client);
  await client.query(commit ? "COMMIT" : "ROLLBACK");
  console.log(commit ? "committed" : "dry run — rolled back (pass --commit to write)");
} catch (e) {
  await client.query("ROLLBACK").catch(() => {});
  console.error(e.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
