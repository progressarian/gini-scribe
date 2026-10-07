import "../loadEnv.js";
import pool from "../config/db.js";

process.env.SCRIBE_BILL_AUTO_CANCEL = "1";
const { reconcileTestSteps } = await import("../services/giniflow/patientBill.js");
const { getMachines } = await import("../services/giniflow/machineCatalog.js");

const fileNo = process.argv[2];
const date = process.argv[3];
if (!fileNo || !date) {
  console.error("usage: node scripts/cancel-not-on-bill-visit.mjs <file_no> <YYYY-MM-DD>");
  process.exit(1);
}

const client = await pool.connect();
try {
  await client.query("BEGIN");
  const { rows: visits } = await client.query(
    `SELECT v.id, v.patient_id FROM giniflow_visits v JOIN patients p ON p.id = v.patient_id
      WHERE p.file_no = $1 AND v.visit_date = $2::date AND v.merged_into_visit_id IS NULL
      FOR NO KEY UPDATE OF v`,
    [fileNo, date],
  );
  if (visits.length !== 1) throw new Error(`Expected one visit, found ${visits.length}`);
  const visit = visits[0];
  await client.query(`SELECT id FROM bills WHERE visit_id = $1 ORDER BY id FOR UPDATE`, [visit.id]);
  const { rows: bills } = await client.query(
    `SELECT status, items FROM giniflow_patient_bills WHERE patient_id = $1 AND bill_date = $2::date`,
    [visit.patient_id, date],
  );
  if (bills[0]?.status !== "billed") throw new Error("No HealthRay bill read for this visit");
  const result = await reconcileTestSteps(client, visit.id, bills[0], await getMachines(client));
  console.log(result);
  if (result.failed.length) throw new Error("Some cancellations failed — nothing was changed");
  await client.query("COMMIT");
  const { rows: cancelled } = await client.query(
    `SELECT test_name, reason, refund_amount FROM giniflow_test_cancellations
      WHERE visit_id = $1 ORDER BY test_name`,
    [visit.id],
  );
  console.log("cancellations", cancelled);
} catch (e) {
  await client.query("ROLLBACK");
  console.error(e.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
