import "../loadEnv.js";
import pool from "../config/db.js";

process.env.SCRIBE_BILL_AUTO_CANCEL = "dry";
const { reconcileTestSteps, billedStepIds } = await import("../services/giniflow/patientBill.js");
const { getMachines } = await import("../services/giniflow/machineCatalog.js");
const { machineForTest } = await import("../../shared/machineStages.js");

const fileNo = process.argv[2];
const date = process.argv[3];
if (!fileNo || !date) {
  console.error("usage: node scripts/diag-not-on-bill-visit.mjs <file_no> <YYYY-MM-DD>");
  process.exit(1);
}

const client = await pool.connect();
try {
  await client.query("BEGIN READ ONLY");
  const { rows: visits } = await client.query(
    `SELECT v.id, v.patient_id, v.visit_date::text, v.current_status, v.machine_scan_at
       FROM giniflow_visits v JOIN patients p ON p.id = v.patient_id
      WHERE p.file_no = $1 AND v.visit_date = $2::date`,
    [fileNo, date],
  );
  console.log("visits", visits);
  const machines = await getMachines(client);
  for (const v of visits) {
    const { rows: orders } = await client.query(
      `SELECT o.id, o.kind, o.payment_status, o.sample_status, o.amount_total, o.amount_paid,
              COALESCE(o.claim_state, 'none') AS claim_state, o.created_at,
              o.created_at = (SELECT min(s.created_at) FROM giniflow_visit_steps s
                               WHERE s.visit_id = o.visit_id
                                 AND s.source IN ('template', 'added')) AS from_checkin,
              EXISTS (SELECT 1 FROM giniflow_lab_order_events e
                       WHERE e.lab_order_id = o.id AND e.track = 'sample'
                         AND e.status NOT IN ('ordered', 'payment_pending', 'paid')) AS started,
              EXISTS (SELECT 1 FROM giniflow_lab_order_events e
                       WHERE e.lab_order_id = o.id AND e.track = 'payment' AND e.status = 'paid'
                         AND COALESCE((e.meta->>'notOnBill')::boolean, FALSE)) AS cleared_before_bill,
              (SELECT json_agg(t.test_name) FROM giniflow_lab_order_tests t
                WHERE t.lab_order_id = o.id) AS tests,
              (SELECT json_agg(json_build_object('track', e.track, 'status', e.status,
                        'at', e.occurred_at, 'meta', e.meta) ORDER BY e.occurred_at)
                 FROM giniflow_lab_order_events e WHERE e.lab_order_id = o.id) AS events
         FROM giniflow_lab_orders o WHERE o.visit_id = $1 ORDER BY o.created_at`,
      [v.id],
    );
    console.log("orders", JSON.stringify(orders, null, 2));
    const { rows: steps } = await client.query(
      `SELECT step_catalog_id, status, source, created_at FROM giniflow_visit_steps
        WHERE visit_id = $1 ORDER BY created_at`,
      [v.id],
    );
    console.log("steps", steps);
    const { rows: billRows } = await client.query(
      `SELECT status, read_at, items FROM giniflow_patient_bills
        WHERE patient_id = $1 AND bill_date = $2::date`,
      [v.patient_id, date],
    );
    console.log("healthray bill", JSON.stringify(billRows, null, 2));
    const bill = billRows[0];
    if (bill) {
      console.log("billed machine ids", [...billedStepIds(bill, machines, { includeDead: true })]);
      for (const o of orders)
        console.log(
          "order machine",
          o.tests,
          (o.tests || []).map((n) => machineForTest(machines, n)?.id),
        );
      console.log("dry run", await reconcileTestSteps(client, v.id, bill, machines));
    }
  }
  const { rows: cancelled } = await client.query(
    `SELECT test_name, reason, source, refund_amount FROM giniflow_test_cancellations
      WHERE visit_date = $2::date AND patient_id = (SELECT id FROM patients WHERE file_no = $1)`,
    [fileNo, date],
  );
  console.log("cancellations", JSON.stringify(cancelled, null, 2));
  await client.query("ROLLBACK");
} finally {
  client.release();
  await pool.end();
}
