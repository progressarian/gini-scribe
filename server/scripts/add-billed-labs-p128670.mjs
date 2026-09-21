import "../loadEnv.js";
import pool from "../config/db.js";
import { raiseOrdersFromSteps } from "../services/giniflow/journey.js";

const FILE_NO = "P_128670";
const DAY = "2026-09-21";
const INVOICE = "OPD/2627-14544";
const BILLED = [
  { name: "Glucose Fasting", amount: 50 },
  { name: "HBA1C", amount: 350 },
  { name: "CREATININE", amount: 100 },
  { name: "Microalbumin/Creatinine Ratio", amount: 500 },
  { name: "LIPID PROFILE", amount: 450 },
  { name: "Hemoglobin (Hb)", amount: 150 },
];
const OFF_FLOOR = ["booked", "confirmed", "no_show", "cancelled", "dispensed", "exited"];
const apply = process.argv.includes("--apply");

const showSteps = async (db, visitId, label) => {
  const { rows } = await db.query(
    `SELECT step_order, step_catalog_id, status, source FROM giniflow_visit_steps
      WHERE visit_id = $1 ORDER BY step_order`,
    [visitId],
  );
  console.log(`\n${label}:`);
  for (const s of rows)
    console.log(`  ${s.step_order}. ${s.step_catalog_id} — ${s.status} (${s.source})`);
};

const client = await pool.connect();
try {
  await client.query("BEGIN");
  const { rows: visits } = await client.query(
    `SELECT v.id, v.current_status, p.name FROM giniflow_visits v
       JOIN patients p ON p.id = v.patient_id
      WHERE p.file_no = $1 AND v.visit_date = $2::date AND v.merged_into_visit_id IS NULL
      FOR UPDATE OF v`,
    [FILE_NO, DAY],
  );
  if (visits.length !== 1)
    throw new Error(`Expected one visit for ${FILE_NO} on ${DAY}, found ${visits.length}`);
  const visit = visits[0];
  console.log(`${visit.name} (${FILE_NO}) visit ${visit.id}, status ${visit.current_status}`);
  if (OFF_FLOOR.includes(visit.current_status)) {
    throw new Error(`Visit is ${visit.current_status}, not on the floor; nothing changed`);
  }

  const { rows: labOrders } = await client.query(
    `SELECT o.id, array_agg(t.test_name) AS tests FROM giniflow_lab_orders o
       JOIN giniflow_lab_order_tests t ON t.lab_order_id = o.id
      WHERE o.visit_id = $1 AND o.kind = 'lab' GROUP BY o.id`,
    [visit.id],
  );
  if (labOrders.length) {
    console.log("Lab order(s) already on the visit; nothing changed:");
    for (const o of labOrders) console.log(`  #${o.id}: ${o.tests.join(", ")}`);
    await client.query("ROLLBACK");
    process.exit(0);
  }

  await showSteps(client, visit.id, "Steps before");
  console.log(
    `\nWill raise one unpaid lab order from ${INVOICE}: ${BILLED.map((t) => `${t.name} ₹${t.amount}`).join(", ")}`,
  );
  const raised = await raiseOrdersFromSteps(client, visit.id, [
    { catalogId: "blood_sample", billedIn: "healthray", billedTests: BILLED },
  ]);
  console.log(`Lab order #${raised.labOrderId}: ${raised.labTests.join(", ")}`);
  await showSteps(client, visit.id, "Steps after");

  if (apply) {
    await client.query("COMMIT");
    console.log("\nCommitted.");
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
