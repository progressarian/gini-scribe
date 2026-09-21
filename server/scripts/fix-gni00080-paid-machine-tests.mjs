import "../loadEnv.js";
import pool from "../config/db.js";
import { cancelTestIn } from "../services/giniflow/testCancel.js";
import { NOT_ON_BILL_REASON } from "../../shared/testCancelReasons.js";

const DAY = "2026-09-21";
const GNI = "GNI-00080";
const REAL = "P_181841";
const NOTE =
  "Duplicate GNI-00080 chart of P_181841. The ₹1,500 cleared at 10:21 was the consultation (HealthRay OPD/2627-14566), not these tests; neither HealthRay bill has ABI/VPT/Fundus.";
const apply = process.argv.includes("--apply");

const visitOf = async (client, fileNo) => {
  const { rows } = await client.query(
    `SELECT v.id, v.patient_id FROM giniflow_visits v JOIN patients p ON p.id = v.patient_id
      WHERE p.file_no = $1 AND v.visit_date = $2::date AND v.merged_into_visit_id IS NULL`,
    [fileNo, DAY],
  );
  if (rows.length !== 1)
    throw new Error(`Expected one ${fileNo} visit on ${DAY}, found ${rows.length}`);
  return rows[0];
};

const client = await pool.connect();
try {
  await client.query("BEGIN");
  const gni = await visitOf(client, GNI);
  const real = await visitOf(client, REAL);
  const { rows: orders } = await client.query(
    `SELECT o.id, o.kind, o.payment_status, o.sample_status, o.amount_paid,
            (SELECT string_agg(test_name, ', ') FROM giniflow_lab_order_tests t WHERE t.lab_order_id = o.id) AS tests
       FROM giniflow_lab_orders o WHERE o.visit_id = $1`,
    [gni.id],
  );
  console.log(`${GNI} visit ${gni.id}: ${orders.length} order(s)`);
  for (const o of orders) {
    if (o.kind !== "machine" || !/^(ABI|VPT|Fundus)$/.test(o.tests)) {
      throw new Error(`Unexpected order ${o.id} (${o.kind}: ${o.tests}); nothing changed`);
    }
    await cancelTestIn(client, {
      target: { orderId: o.id },
      reason: NOT_ON_BILL_REASON,
      source: "healthray",
      actorRole: "system",
      refundAmount: 0,
      note: NOTE,
    });
    console.log(`  cancelled ${o.tests} (${o.payment_status} ₹${o.amount_paid}, refund ₹0)`);
  }
  const moved = await client.query(
    `UPDATE giniflow_test_cancellations SET visit_id = $2, patient_id = $3
      WHERE visit_id = $1 RETURNING test_name, reason, amount_paid`,
    [gni.id, real.id, real.patient_id],
  );
  console.log(`Moved ${moved.rowCount} cancellation record(s) to ${REAL} visit ${real.id}:`);
  for (const r of moved.rows) console.log(`  ${r.test_name} — ${r.reason}, paid ₹${r.amount_paid}`);

  if (apply) {
    await client.query("COMMIT");
    console.log("\nCommitted. Now remove the duplicate chart with fix-obt-shell-duplicates.mjs.");
  } else {
    await client.query("ROLLBACK");
    console.log("\nDry run, rolled back. Re-run with --apply to keep it.");
  }
} catch (e) {
  await client.query("ROLLBACK");
  console.error(e.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
