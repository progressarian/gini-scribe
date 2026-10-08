import "../loadEnv.js";
import pool from "../config/db.js";
import { cancelTestIn } from "../services/giniflow/testCancel.js";
import { NOT_ON_BILL_REASON } from "../../shared/testCancelReasons.js";

const DAY = "2026-10-08";
const GNI = "GNI-00120";
const REAL = "P_182105";
const MISENTERED_WEIGHT = 66;
const NOTE =
  "Duplicate GNI-00120 chart of P_182105. Cleared at reception 13:02 but not on either HealthRay bill (OPD/2627-16185, OPD/2627-16203) — refund if collected.";
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
      refundAmount: Number(o.amount_paid) || 0,
      note: NOTE,
    });
    console.log(
      `  cancelled ${o.tests} (${o.payment_status} ₹${o.amount_paid}, refund due if collected)`,
    );
  }
  const moved = await client.query(
    `UPDATE giniflow_test_cancellations SET visit_id = $2, patient_id = $3
      WHERE visit_id = $1 RETURNING test_name, reason, amount_paid`,
    [gni.id, real.id, real.patient_id],
  );
  console.log(`Moved ${moved.rowCount} cancellation record(s) to ${REAL} visit ${real.id}`);

  const wrong = await client.query(
    `DELETE FROM giniflow_vitals WHERE visit_id = $1 AND weight = $2
     RETURNING id, weight, height, bp_sys, bp_dia`,
    [real.id, MISENTERED_WEIGHT],
  );
  console.log(
    `Removed ${wrong.rowCount} mis-entered vitals row(s) from ${REAL} (Dr Singla's reading):`,
    wrong.rows,
  );
  const right = await client.query(
    `UPDATE giniflow_vitals SET visit_id = $2, patient_id = $3
      WHERE visit_id = $1 RETURNING id, weight, height, bp_sys, bp_dia`,
    [gni.id, real.id, real.patient_id],
  );
  console.log(`Moved ${right.rowCount} vitals row(s) from ${GNI} to ${REAL}:`, right.rows);
  if (wrong.rowCount !== 1 || right.rowCount !== 1) {
    throw new Error("Expected exactly one wrong and one right vitals row; nothing changed");
  }
  const dupe = await client.query(
    `DELETE FROM vitals WHERE patient_id = $1 AND source = 'giniflow'
        AND recorded_at::date = $2::date
        AND EXISTS (SELECT 1 FROM vitals h WHERE h.patient_id = $3 AND h.source = 'healthray'
                     AND h.recorded_at::date = $2::date AND h.weight = vitals.weight)
     RETURNING id`,
    [gni.patient_id, DAY, real.patient_id],
  );
  console.log(
    `Removed ${dupe.rowCount} chart vitals row(s) on ${GNI} already on ${REAL} from HealthRay`,
  );

  if (apply) {
    await client.query("COMMIT");
    console.log(
      `\nCommitted. Now remove the duplicate chart:\n  node scripts/fix-obt-shell-duplicates.mjs ${GNI}=${REAL} --allow-phone-mismatch --apply`,
    );
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
