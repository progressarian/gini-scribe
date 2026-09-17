import "../loadEnv.js";
import pool from "../config/db.js";

const TARGETS = [
  {
    patient: "Sudha Malik P_43200",
    visitId: "6f0b742e-6777-47a5-a297-223711edb89c",
    orderId: "0476e08b-89d2-44da-9b7f-9472605359cc",
  },
  {
    patient: "Randhir Singh P_84630",
    visitId: "86a0a082-2153-485d-aee0-598ace6309c5",
    orderId: "15397f4d-b794-4683-afcf-c04d40fc8958",
  },
];

const client = await pool.connect();
try {
  await client.query("BEGIN");
  for (const t of TARGETS) {
    await client.query(`SELECT id FROM giniflow_visits WHERE id = $1 FOR UPDATE`, [t.visitId]);
    const orders = await client.query(
      `DELETE FROM giniflow_lab_orders o
        WHERE o.id = $1 AND o.visit_id = $2
          AND o.sample_status IN ('ordered', 'payment_pending', 'paid')
          AND NOT EXISTS (SELECT 1 FROM giniflow_lab_order_events e
                           WHERE e.lab_order_id = o.id AND e.track = 'sample'
                             AND e.status <> 'paid')
        RETURNING o.id`,
      [t.orderId, t.visitId],
    );
    const steps = await client.query(
      `DELETE FROM giniflow_visit_steps
        WHERE visit_id = $1 AND source = 'auto'
          AND step_catalog_id IN ('lab_billing', 'blood_sample')
          AND status <> 'in_progress'
        RETURNING step_catalog_id`,
      [t.visitId],
    );
    if (orders.rowCount !== 1 || steps.rowCount !== 2) {
      throw new Error(
        `${t.patient}: expected 1 order and 2 steps, got ${orders.rowCount} and ${steps.rowCount}`,
      );
    }
    console.log(
      `${t.patient}: removed order ${t.orderId} and steps`,
      steps.rows.map((r) => r.step_catalog_id),
    );
  }
  await client.query("COMMIT");
} catch (e) {
  await client.query("ROLLBACK");
  console.error("rolled back:", e.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
