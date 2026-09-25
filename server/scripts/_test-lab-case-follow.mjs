import "../loadEnv.js";
import pool from "../config/db.js";
import { healthrayCaseTestNames } from "../services/giniflow/journey.js";
import { followHealthrayCases } from "../services/giniflow/labCaseReconcile.js";

const apply = process.argv.includes("--apply");
const fileNos = process.argv.slice(2).filter((a) => a.startsWith("P_"));
for (const fileNo of fileNos) {
  const { rows } = await pool.query(
    `SELECT v.id, v.visit_date::text AS d, v.current_status, v.results_status
       FROM giniflow_visits v JOIN patients p ON p.id = v.patient_id
      WHERE p.file_no = $1 ORDER BY v.visit_date DESC LIMIT 1`,
    [fileNo],
  );
  const v = rows[0];
  const t0 = Date.now();
  const caseTests = await healthrayCaseTestNames(pool, v.id);
  console.log(`\n${fileNo} ${v.d} — ${caseTests.length} HealthRay case test(s), lookup ${Date.now() - t0} ms`);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r = await followHealthrayCases(client, v.id);
    const orders = await client.query(
      `SELECT o.sample_status, (SELECT array_agg(test_name) FROM giniflow_lab_order_tests t WHERE t.lab_order_id = o.id) tests
         FROM giniflow_lab_orders o WHERE o.visit_id = $1 AND o.kind = 'lab' ORDER BY o.created_at`,
      [v.id],
    );
    const after = await client.query(`SELECT current_status, results_status FROM giniflow_visits WHERE id = $1`, [v.id]);
    const steps = await client.query(
      `SELECT step_catalog_id, status FROM giniflow_visit_steps WHERE visit_id = $1 AND step_catalog_id IN ('lab_billing','blood_sample')`,
      [v.id],
    );
    console.log("  result:", JSON.stringify(r));
    for (const o of orders.rows) console.log("  order:", o.sample_status, JSON.stringify(o.tests));
    console.log("  visit:", v.results_status, "→", after.rows[0].results_status, "| steps:", JSON.stringify(steps.rows));
    await client.query(apply ? "COMMIT" : "ROLLBACK");
    console.log(apply ? "  APPLIED" : "  (dry run — rolled back)");
  } catch (e) {
    await client.query("ROLLBACK");
    console.log("  error:", e.message);
  } finally {
    client.release();
  }
}
await pool.end();
