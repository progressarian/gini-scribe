import "../loadEnv.js";
import pool from "../config/db.js";

const VISIT_ID = "8df30c0f-0d62-4ce1-9d93-fe71c14c898d";
const ORDER_ID = "04874d3d-5a2e-4ea3-95d6-e3eb858bd565";

const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query(`SELECT id FROM giniflow_visits WHERE id = $1 FOR UPDATE`, [VISIT_ID]);
  const { rows: snapshot } = await client.query(
    `SELECT o.*, (SELECT json_agg(t) FROM giniflow_lab_order_tests t WHERE t.lab_order_id = o.id) AS tests
       FROM giniflow_lab_orders o WHERE o.id = $1`,
    [ORDER_ID],
  );
  console.log("snapshot:", JSON.stringify(snapshot[0]));
  const orders = await client.query(
    `DELETE FROM giniflow_lab_orders o
      WHERE o.id = $1 AND o.visit_id = $2 AND o.kind = 'machine'
        AND NOT EXISTS (SELECT 1 FROM giniflow_lab_order_events e
                         WHERE e.lab_order_id = o.id AND e.track = 'sample' AND e.status <> 'paid')
      RETURNING o.id`,
    [ORDER_ID, VISIT_ID],
  );
  const steps = await client.query(
    `DELETE FROM giniflow_visit_steps
      WHERE visit_id = $1 AND step_catalog_id = 'vpt' AND status = 'pending'
      RETURNING id`,
    [VISIT_ID],
  );
  if (orders.rowCount !== 1 || steps.rowCount !== 1) {
    throw new Error(`expected 1 order and 1 step, got ${orders.rowCount} and ${steps.rowCount}`);
  }
  await client.query("COMMIT");
  console.log("Renu Bala P_181797: refunded VPT order and step removed");
} catch (e) {
  await client.query("ROLLBACK");
  console.error("rolled back:", e.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
