import "../loadEnv.js";
import pool from "../config/db.js";

const fileNo = process.argv[2];
if (!fileNo) {
  console.error("usage: node scripts/diag-bill-prefill.mjs <file_no>");
  process.exit(1);
}

const client = await pool.connect();
try {
  await client.query("BEGIN READ ONLY");
  const show = async (label, sql, params) =>
    console.log(label, JSON.stringify((await client.query(sql, params)).rows, null, 1));

  const visit = (
    await client.query(
      `SELECT v.id, v.patient_id, v.appointment_id, v.assigned_doctor_id, v.assigned_sd_id,
              v.current_status, v.visit_date::text, a.visit_type, a.doctor_name, a.doctor_id
         FROM giniflow_visits v
         JOIN patients p ON p.id = v.patient_id
         LEFT JOIN appointments a ON a.id = v.appointment_id
        WHERE p.file_no = $1
        ORDER BY v.visit_date DESC
        LIMIT 1`,
      [fileNo],
    )
  ).rows[0];
  if (!visit) throw new Error("No Gini Flow visit for that file no");
  console.log("visit", visit);

  await show(
    "steps",
    `SELECT step_order, step_catalog_id, status, assigned_staff_name FROM giniflow_visit_steps
      WHERE visit_id = $1 ORDER BY step_order`,
    [visit.id],
  );
  await show(
    "orders",
    `SELECT o.id, o.kind, o.payment_status, o.amount_total, o.amount_paid, o.claim_state,
            o.sample_status,
            (SELECT json_agg(json_build_object('test', t.test_name, 'status', t.status,
                                               'price', t.price))
               FROM giniflow_lab_order_tests t WHERE t.lab_order_id = o.id) AS tests
       FROM giniflow_lab_orders o WHERE o.visit_id = $1`,
    [visit.id],
  );
  await show("bills", `SELECT id, status, bill_type, created_at FROM bills WHERE visit_id = $1`, [
    visit.id,
  ]);
  await show(
    "bill lines",
    `SELECT bill_id, source, service_item_id, is_live FROM bill_lines WHERE visit_id = $1`,
    [visit.id],
  );
  await show(
    "healthray bill",
    `SELECT status, items FROM giniflow_patient_bills
      WHERE patient_id = $1 AND bill_date = $2::date`,
    [visit.patient_id, visit.visit_date],
  );
  await show(
    "service items for the tests",
    `SELECT c.id AS catalog_id, c.test_name, i.id AS item_id, i.is_active, i.base_price
       FROM giniflow_test_catalog c
       LEFT JOIN service_items i ON i.test_catalog_id = c.id
      WHERE lower(c.test_name) IN ('abi', 'abi test', 'vpt', 'fundus')`,
  );
  await show(
    "consultation items for the visit's doctors",
    `SELECT id, name, visit_type, doctor_id FROM service_items
      WHERE kind = 'consultation' AND is_active AND doctor_id = ANY($1::int[])`,
    [[visit.assigned_doctor_id, visit.assigned_sd_id, visit.doctor_id].filter(Boolean)],
  );
  await show(
    "bill audit",
    `SELECT at, entity, action, before ->> 'service_item_id' AS item_before,
            after ->> 'service_item_id' AS item_after, after ->> 'reason' AS reason,
            before ->> 'source' AS source
       FROM billing_audit
      WHERE (before ->> 'visit_id' = $1 OR after ->> 'visit_id' = $1)
      ORDER BY at`,
    [visit.id],
  );
  await client.query("ROLLBACK");
} catch (e) {
  await client.query("ROLLBACK");
  console.error(e.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
