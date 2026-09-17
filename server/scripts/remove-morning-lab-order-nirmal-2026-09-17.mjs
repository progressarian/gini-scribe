import "../loadEnv.js";
import pool from "../config/db.js";

const VISIT_ID = "ceaf0ac4-8b03-4455-aea6-97d124bf5cb6";
const ORDER_ID = "f9ff6884-ea96-4176-9e60-101bf46da067";

const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query(`SELECT id FROM giniflow_visits WHERE id = $1 FOR UPDATE`, [VISIT_ID]);
  const orders = await client.query(
    `DELETE FROM giniflow_lab_orders o
      WHERE o.id = $1 AND o.visit_id = $2
        AND o.sample_status IN ('ordered', 'payment_pending', 'paid')
        AND NOT EXISTS (SELECT 1 FROM giniflow_lab_order_events e
                         WHERE e.lab_order_id = o.id AND e.track = 'sample'
                           AND e.status <> 'paid')
      RETURNING o.id`,
    [ORDER_ID, VISIT_ID],
  );
  const steps = await client.query(
    `DELETE FROM giniflow_visit_steps
      WHERE visit_id = $1
        AND step_catalog_id IN ('lab_billing', 'blood_sample')
        AND status <> 'in_progress'
      RETURNING step_catalog_id`,
    [VISIT_ID],
  );
  if (orders.rowCount !== 1 || steps.rowCount !== 2) {
    throw new Error(`expected 1 order and 2 steps, got ${orders.rowCount} and ${steps.rowCount}`);
  }
  await client.query("COMMIT");
  console.log(
    "Nirmal Singh P_145090: removed order",
    ORDER_ID,
    "and steps",
    steps.rows.map((r) => r.step_catalog_id),
  );
} catch (e) {
  await client.query("ROLLBACK");
  console.error("rolled back:", e.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
