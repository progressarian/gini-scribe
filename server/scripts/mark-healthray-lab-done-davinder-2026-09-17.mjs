import "../loadEnv.js";
import pool from "../config/db.js";

const VISIT_ID = "bff4da89-1003-4190-b94c-ea960dd91ddf";
const ORDER_ID = "92517aee-11f4-46ae-aedb-71688cc2a02d";
const COLLECTED_AT = "2026-09-17T12:19:28Z";
const REPORTED_AT = "2026-09-17T12:39:15Z";
const META = JSON.stringify({ source: "healthray", case_no: "20037" });

const client = await pool.connect();
try {
  await client.query("BEGIN");
  const order = await client.query(
    `UPDATE giniflow_lab_orders
        SET sample_status = 'uploaded', uploaded_at = $2, version = version + 1, updated_at = NOW()
      WHERE id = $1 AND visit_id = $3 AND payment_status = 'paid' AND sample_status = 'paid'
      RETURNING id`,
    [ORDER_ID, REPORTED_AT, VISIT_ID],
  );
  if (order.rowCount !== 1)
    throw new Error("order is no longer paid and undrawn — nothing changed");
  await client.query(
    `INSERT INTO giniflow_lab_order_events (lab_order_id, track, status, actor_role, actor_id, occurred_at, meta)
     VALUES ($1, 'sample', 'sample_collected', 'system', NULL, $2, $4::jsonb),
            ($1, 'sample', 'sample_received', 'system', NULL, $2, $4::jsonb),
            ($1, 'sample', 'uploaded', 'system', NULL, $3, $4::jsonb)`,
    [ORDER_ID, COLLECTED_AT, REPORTED_AT, META],
  );
  const step = await client.query(
    `UPDATE giniflow_visit_steps
        SET status = 'done', started_at = COALESCE(started_at, $2), completed_at = $2
      WHERE visit_id = $1 AND step_catalog_id = 'blood_sample' AND status <> 'done'
      RETURNING id`,
    [VISIT_ID, COLLECTED_AT],
  );
  await client.query("COMMIT");
  console.log(
    `Davinder Singh Lamba P_181251: order ${ORDER_ID} → uploaded; blood sample step updated: ${step.rowCount}`,
  );
} catch (e) {
  await client.query("ROLLBACK");
  console.error("rolled back:", e.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
