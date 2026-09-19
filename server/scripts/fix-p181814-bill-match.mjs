import "../loadEnv.js";
import pool from "../config/db.js";
import { getMachines } from "../services/giniflow/machineCatalog.js";
import {
  billedLabLines,
  billedMachineLines,
  storedBill,
} from "../services/giniflow/patientBill.js";
import { syncBillingForVisitId } from "../services/giniflow/machineSync.js";
import { fetchPatientTransactions } from "../services/healthray/client.js";
import { transactionsToBilling } from "../services/healthray/billingExtractor.js";
import { machineForTest } from "../../shared/machineStages.js";
import { writeAudit } from "../services/billing/audit.js";

const FILE_NO = "P_181814";
const VISIT_DATE = "2026-09-19";
const BILL_NO = "OPD/2627-14455";
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
if (!/MUKESH\s+BHATRA/i.test(visit.name)) {
  console.error(`Refusing: ${FILE_NO} on ${VISIT_DATE} is "${visit.name}", not Mukesh Bhatra`);
  process.exit(1);
}

const { rows: hr } = await pool.query(
  `SELECT healthray_id, healthray_patient_id FROM appointments
    WHERE patient_id = $1 AND appointment_date = $2::date AND healthray_patient_id IS NOT NULL
    ORDER BY id DESC LIMIT 1`,
  [visit.patient_id, VISIT_DATE],
);
if (!hr.length) {
  console.error("Refusing: no HealthRay appointment for this patient today");
  process.exit(1);
}

const machines = await getMachines(pool);
const liveBill = transactionsToBilling(await fetchPatientTransactions(hr[0].healthray_patient_id), {
  appointmentId: hr[0].healthray_id,
  date: VISIT_DATE,
  wholeDay: true,
})?.billing;
if (!liveBill) {
  console.error("Refusing: HealthRay returned no bill for today");
  process.exit(1);
}
const bill = { status: "billed", items: liveBill.items };

console.log(`${visit.name} (${FILE_NO}) · ${VISIT_DATE} · ${visit.current_status}`);
console.log("HealthRay bill lines:");
for (const i of liveBill.items) {
  console.log(
    `  [${i.category}] ${i.desc} ₹${i.amount}${i.refunded ? ` (refunded ₹${i.refunded})` : ""}${i.cancelled ? " CANCELLED" : ""}`,
  );
}
console.log(
  "Lab lines Scribe will raise:",
  billedLabLines(bill).map((l) => `${l.name} ₹${l.amount}`),
);

const findLine = (b) =>
  billedMachineLines(b, machines).find(
    (l) => l.name.replace(/\s/g, "").toLowerCase() === COMBINED_LINE.toLowerCase(),
  );
const line = findLine(bill);
if (!line || Number(line.amount) !== COMBINED_AMOUNT || line.machines.length !== 3) {
  console.error(`Refusing: bill has no ${COMBINED_LINE} line at ₹${COMBINED_AMOUNT}`, line);
  process.exit(1);
}

const loadPlan = async () => {
  const { rows: orders } = await pool.query(
    `SELECT o.id, o.payment_status, o.sample_status, o.amount_total, o.amount_paid,
            o.amount_claimed, COALESCE(o.claim_state, 'none') AS claim_state, o.version,
            t.id AS test_id, t.test_name, t.price
       FROM giniflow_lab_orders o
       JOIN giniflow_lab_order_tests t ON t.lab_order_id = o.id
      WHERE o.visit_id = $1 AND o.kind = 'machine' AND o.urgency = 'today'`,
    [visit.id],
  );
  return orders
    .map((o) => ({ ...o, machineId: machineForTest(machines, o.test_name)?.id }))
    .filter((o) => line.machines.includes(o.machineId))
    .map((o) => ({ ...o, share: line.amountOf[o.machineId] }));
};

const plan = await loadPlan();
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

console.log(`Bill ${BILL_NO}: "${line.name}" ₹${line.amount}`);
for (const o of plan) {
  console.log(
    `  ${o.test_name}: total ₹${o.amount_total} → ₹${o.share}, paid ₹${o.amount_paid} → ₹${o.share} (${o.payment_status}/${o.sample_status})`,
  );
}
console.log(
  `Machine tests total ₹${plan.reduce((s, o) => s + Number(o.amount_total), 0)} → ₹${line.amount}`,
);

if (!apply) {
  console.log("Dry run — re-run with --apply.");
  await pool.end();
  process.exit(0);
}

const synced = await syncBillingForVisitId(visit.id, pool);
console.log("Bill sync:", JSON.stringify(synced));
if (synced.blocked) {
  console.error("HealthRay blocked the bill sync — nothing repriced");
  await pool.end();
  process.exit(1);
}
const stored = await storedBill(visit.patient_id, VISIT_DATE);
if (!findLine(stored)) {
  console.error("Refusing: the stored bill does not carry the combined line after the sync");
  await pool.end();
  process.exit(1);
}

const client = await pool.connect();
try {
  await client.query("BEGIN");
  for (const o of await loadPlan()) {
    if (Number(o.amount_total) === Number(o.share)) continue;
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
  console.log("Corrected.");
} catch (e) {
  await client.query("ROLLBACK");
  console.error("Rolled back:", e.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
