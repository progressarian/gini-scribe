import "../loadEnv.js";
import pool from "../config/db.js";
import { linkOrderToFinalBills } from "../services/billing/visitLines.js";

const APPLY = process.argv.includes("--apply");
const daysArg = process.argv.find((arg) => arg.startsWith("--days="));
const DAYS = Number(daysArg?.split("=")[1] ?? 30);
const ctx = { actorId: null, ip: null, role: "system" };

const { rows: stuck } = await pool.query(
  `SELECT o.id, o.visit_id, gv.visit_date::text AS day, p.file_no, p.name,
          array_agg(t.test_name ORDER BY t.test_name) AS tests
     FROM giniflow_lab_orders o
     JOIN giniflow_visits gv ON gv.id = o.visit_id
     JOIN patients p ON p.id = gv.patient_id
     JOIN giniflow_lab_order_tests t ON t.lab_order_id = o.id
    WHERE o.urgency = 'today' AND o.payment_status = 'pending'
      AND gv.visit_date >= (now() AT TIME ZONE 'Asia/Kolkata')::date - $1::int
      AND NOT EXISTS (SELECT 1 FROM bill_lines bl WHERE bl.lab_order_id = o.id)
      AND EXISTS (SELECT 1 FROM bill_lines l JOIN bills b ON b.id = l.bill_id
                    JOIN service_items si ON si.id = l.service_item_id
                   WHERE l.visit_id = o.visit_id AND l.is_live AND l.lab_order_id IS NULL
                     AND si.kind = 'test' AND b.status = 'final' AND b.bill_type = 'invoice')
    GROUP BY o.id, gv.visit_date, p.file_no, p.name
    ORDER BY gv.visit_date, o.created_at`,
  [DAYS],
);

console.log(`${stuck.length} unpaid test orders with tests on a final bill (last ${DAYS} days)`);

let fixed = 0;
for (const order of stuck) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await linkOrderToFinalBills(
      order.visit_id,
      { labOrderId: order.id, testNames: order.tests },
      ctx,
      client,
    );
    const { rows } = await client.query(
      `SELECT payment_status, sample_status FROM giniflow_lab_orders WHERE id = $1`,
      [order.id],
    );
    await client.query(APPLY ? "COMMIT" : "ROLLBACK");
    if (rows[0].payment_status !== "pending") fixed += 1;
    console.log(
      `${order.day} ${order.file_no} ${order.name}: linked ${result.linked.length}/${order.tests.length}` +
        ` -> ${rows[0].payment_status} / ${rows[0].sample_status}`,
    );
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(`stopped at order ${order.id}: ${error.message}`);
    process.exitCode = 1;
    break;
  } finally {
    client.release();
  }
}

console.log(
  `${APPLY ? "Applied" : "Dry run (rolled back)"}: ${fixed} orders ${APPLY ? "paid" : "would be paid"}`,
);
await pool.end();
