import "../loadEnv.js";
import pool from "../config/db.js";
import { getMachines } from "../services/giniflow/machineCatalog.js";
import { billedMachineLines, storedBill } from "../services/giniflow/patientBill.js";
import { machineForTest } from "../../shared/machineStages.js";
import { writeAudit } from "../services/billing/audit.js";

const FILE_NO = "P_181807";
const VISIT_DATE = "2026-09-18";
const BILL_NO = "OPD/2627-14412";
const COMBINED_LINE = "ABI,VPT,Fundus";
const COMBINED_AMOUNT = 800;
const apply = process.argv.includes("--apply");

const { rows: visits } = await pool.query(
  `SELECT v.id, v.patient_id, v.current_status, p.name
     FROM giniflow_visits v JOIN patients p ON p.id = v.patient_id
    WHERE p.file_no = $1 AND v.visit_date = $2::date AND v.merged_into_visit_id IS NULL`,
  [FILE_NO, VISIT_DATE],
);
if (visits.length !== 1) {
  console.error(`Expected one visit on ${VISIT_DATE} for ${FILE_NO}, found ${visits.length}`);
  process.exit(1);
}
const visit = visits[0];
if (!/ANU\s+SACHDEVA/i.test(visit.name)) {
  console.error(`Refusing: ${FILE_NO} on ${VISIT_DATE} is "${visit.name}", not Anu Sachdeva`);
  process.exit(1);
}

const bill = await storedBill(visit.patient_id, VISIT_DATE);
const machines = await getMachines(pool);
const line = billedMachineLines(bill, machines).find(
  (l) => l.name.replace(/\s/g, "").toLowerCase() === COMBINED_LINE.toLowerCase(),
);
if (!line || Number(line.amount) !== COMBINED_AMOUNT || line.machines.length !== 3) {
  console.error(`Refusing: stored bill has no ${COMBINED_LINE} line at ₹${COMBINED_AMOUNT}`, line);
  process.exit(1);
}

const { rows: orders } = await pool.query(
  `SELECT o.id, o.payment_status, o.sample_status, o.amount_total, o.amount_paid,
          o.amount_claimed, COALESCE(o.claim_state, 'none') AS claim_state, o.version,
          t.id AS test_id, t.test_name, t.price
     FROM giniflow_lab_orders o
     JOIN giniflow_lab_order_tests t ON t.lab_order_id = o.id
    WHERE o.visit_id = $1 AND o.kind = 'machine' AND o.urgency = 'today'`,
  [visit.id],
);

const plan = orders
  .map((o) => ({ ...o, machineId: machineForTest(machines, o.test_name)?.id }))
  .filter((o) => line.machines.includes(o.machineId))
  .map((o) => ({ ...o, share: line.amountOf[o.machineId] }));

if (plan.length !== line.machines.length || new Set(plan.map((o) => o.id)).size !== plan.length) {
  console.error("Refusing: expected one single-test order per machine on the line", plan);
  process.exit(1);
}
const unsafe = plan.filter(
  (o) =>
    o.claim_state !== "none" ||
    Number(o.amount_claimed || 0) > 0 ||
    Number(o.amount_paid) !== Number(o.amount_total) ||
    Number(o.price) !== Number(o.amount_total),
);
if (unsafe.length) {
  console.error("Refusing: these orders are not a plain full cash payment —", unsafe);
  process.exit(1);
}

console.log(`${visit.name} (${FILE_NO}) · ${VISIT_DATE} · ${visit.current_status}`);
console.log(`Bill ${BILL_NO}: "${line.name}" ₹${line.amount}`);
for (const o of plan) {
  console.log(
    `  ${o.test_name}: total ₹${o.amount_total} → ₹${o.share}, paid ₹${o.amount_paid} → ₹${o.share} (${o.payment_status}/${o.sample_status})`,
  );
}
const before = plan.reduce((s, o) => s + Number(o.amount_total), 0);
console.log(`Machine tests total ₹${before} → ₹${line.amount}`);
if (plan.every((o) => Number(o.amount_total) === Number(o.share))) {
  console.log("Already corrected — nothing to do.");
  await pool.end();
  process.exit(0);
}
if (!apply) {
  console.log("Dry run — re-run with --apply.");
  await pool.end();
  process.exit(0);
}

const client = await pool.connect();
try {
  await client.query("BEGIN");
  for (const o of plan) {
    const { rowCount } = await client.query(
      `UPDATE giniflow_lab_orders
          SET amount_total = $2, amount_paid = $2, version = version + 1, updated_at = NOW()
        WHERE id = $1 AND version = $3`,
      [o.id, o.share, o.version],
    );
    if (rowCount !== 1) throw new Error(`Order ${o.id} changed while the script ran`);
    await client.query(`UPDATE giniflow_lab_order_tests SET price = $2 WHERE id = $1`, [
      o.test_id,
      o.share,
    ]);
    await writeAudit(client, {
      entity: "giniflow_lab_order",
      entityId: o.id,
      action: "update",
      before: { test: o.test_name, amount_total: o.amount_total, amount_paid: o.amount_paid },
      after: {
        test: o.test_name,
        amount_total: o.share,
        amount_paid: o.share,
        reason: `Repriced to HealthRay bill ${BILL_NO}: "${line.name}" ₹${line.amount} split across ${plan.length} tests; catalogue placeholder ₹${o.amount_total} had been used`,
      },
    });
  }
  await client.query("COMMIT");
  console.log(`Corrected ${plan.length} order(s).`);
} catch (e) {
  await client.query("ROLLBACK");
  console.error("Rolled back:", e.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
