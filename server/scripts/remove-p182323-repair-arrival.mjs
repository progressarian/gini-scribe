import "../loadEnv.js";
import pool from "../config/db.js";

const VISIT_ID = "be4b3ef4-bffb-49cc-ab22-5e13e6527f88";
const commit = process.argv.includes("--commit");

const events = async (db) =>
  (
    await db.query(
      `SELECT status, actor_role,
              to_char(occurred_at AT TIME ZONE 'Asia/Kolkata', 'HH24:MI:SS') AS at, meta->>'reason' AS reason
         FROM giniflow_visit_events WHERE visit_id = $1 ORDER BY occurred_at, seq`,
      [VISIT_ID],
    )
  ).rows.map((e) => `${e.at} ${e.status} (${e.actor_role}${e.reason ? `, ${e.reason}` : ""})`);

const client = await pool.connect();
try {
  await client.query("BEGIN");
  console.log("before:", await events(client));
  const removed = await client.query(
    `DELETE FROM giniflow_visit_events
      WHERE visit_id = $1 AND status = 'checked_in' AND actor_role = 'admin'
        AND actor_id = 13 AND meta->>'reason' = 'arrived_for_appointment'
        AND occurred_at::date = '2026-10-27'`,
    [VISIT_ID],
  );
  if (removed.rowCount !== 1) throw new Error(`expected 1 repair event, found ${removed.rowCount}`);
  console.log("after:", await events(client));
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
