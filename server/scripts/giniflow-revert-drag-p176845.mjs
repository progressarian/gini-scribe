// One-off: revert a mis-dropped board drag for P_176845 (Rakesh Kaliya,
// 2026-09-01) — dragged "With doctor" → "At pharmacy" at 09:37 IST.
//
// Gini Flow's event log is append-only and the chain has no backward
// transition, so a mis-drop cannot be corrected by a further event: there is
// nothing forward that means "that did not happen". Removing the single
// erroneous row and restoring the status its predecessor left behind is the only
// way to make the log describe what actually happened — the patient is still
// with the doctor, and their doctor timer should still be running from 09:11.
//
// Guarded three ways, so it can only ever do this one thing:
//   * the event must still be the board_drag row we inspected
//   * it must still be the visit's LATEST event — if the patient has moved on
//     since, reverting would rewrite newer history, so it refuses
//   * everything is one transaction; any failure leaves the row untouched
//
// Running it a second time is a no-op ("nothing done").
//
//   node scripts/giniflow-revert-drag-p176845.mjs   (from server/)
import "../loadEnv.js";
import pool from "../config/db.js";

const EVENT_ID = "fa0b8300-cbb7-4b7d-86fb-45080b1a54f3";
const VISIT_ID = "3d133132-e69b-4f27-ad14-dc1941fc7f1d";

const client = await pool.connect();
try {
  await client.query("BEGIN");

  const { rows: target } = await client.query(
    `SELECT id, status, meta FROM giniflow_visit_events
      WHERE id = $1 AND visit_id = $2 AND meta->>'source' = 'board_drag'
      FOR UPDATE`,
    [EVENT_ID, VISIT_ID],
  );
  if (!target.length) throw new Error("The drag event is not there — nothing done.");

  const { rows: latest } = await client.query(
    `SELECT id FROM giniflow_visit_events WHERE visit_id = $1
      ORDER BY occurred_at DESC, id DESC LIMIT 1`,
    [VISIT_ID],
  );
  if (latest[0].id !== EVENT_ID) {
    throw new Error("The patient has moved on since — reverting would rewrite newer history.");
  }

  const { rows: prior } = await client.query(
    `SELECT status, occurred_at FROM giniflow_visit_events
      WHERE visit_id = $1 AND id <> $2 ORDER BY occurred_at DESC, id DESC LIMIT 1`,
    [VISIT_ID, EVENT_ID],
  );
  if (!prior.length) throw new Error("No prior event to restore to — nothing done.");

  await client.query(`DELETE FROM giniflow_visit_events WHERE id = $1`, [EVENT_ID]);
  await client.query(
    `UPDATE giniflow_visits
        SET current_status = $2, updated_at = NOW()
      WHERE id = $1`,
    [VISIT_ID, prior[0].status],
  );

  await client.query("COMMIT");
  console.log(`reverted to ${prior[0].status} (as at ${prior[0].occurred_at.toISOString()})`);
} catch (e) {
  await client.query("ROLLBACK");
  console.error("NOT reverted:", e.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
