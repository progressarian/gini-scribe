import "../loadEnv.js";
import pg from "pg";

const VISIT_ID = "88d93731-9f32-4cac-a17b-a5a696ac8720";
const MACHINE_STEPS = ["abi", "vpt", "fundus"];

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL.replace(/[?&]sslmode=[^&]*/g, ""),
  ssl: { rejectUnauthorized: false },
});
await client.connect();
try {
  await client.query("BEGIN");
  await client.query(`SELECT id FROM giniflow_visits WHERE id = $1 FOR UPDATE`, [VISIT_ID]);
  const orders = await client.query(
    `DELETE FROM giniflow_lab_orders o
      WHERE o.visit_id = $1 AND o.kind = 'machine'
        AND o.sample_status IN ('ordered', 'payment_pending', 'paid')
        AND NOT EXISTS (SELECT 1 FROM giniflow_lab_order_events e
                         WHERE e.lab_order_id = o.id AND e.track = 'sample' AND e.status <> 'paid')
      RETURNING o.id`,
    [VISIT_ID],
  );
  const steps = await client.query(
    `DELETE FROM giniflow_visit_steps
      WHERE visit_id = $1 AND step_catalog_id = ANY($2) AND status = 'pending'
      RETURNING step_catalog_id`,
    [VISIT_ID, MACHINE_STEPS],
  );
  if (orders.rowCount !== 3 || steps.rowCount !== 3) {
    throw new Error(`expected 3 orders and 3 steps, got ${orders.rowCount} and ${steps.rowCount}`);
  }
  await client.query("COMMIT");
  console.log(
    "removed",
    orders.rows.map((r) => r.id),
    steps.rows.map((r) => r.step_catalog_id),
  );
} catch (e) {
  await client.query("ROLLBACK");
  console.error("rolled back:", e.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
