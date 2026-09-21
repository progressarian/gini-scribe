import "../loadEnv.js";
import pool from "../config/db.js";
import { cancelTestIn } from "../services/giniflow/testCancel.js";
import { NOT_ON_BILL_REASON } from "../../shared/testCancelReasons.js";
import { storedBill, billedMachineLines } from "../services/giniflow/patientBill.js";
import { getMachines } from "../services/giniflow/machineCatalog.js";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const [date, ...fileNos] = args;
const apply = process.argv.includes("--apply");
if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "") || !fileNos.length) {
  console.error(
    "Usage: node scripts/cancel-unbilled-paid-machine-tests.mjs <YYYY-MM-DD> <file_no>... [--apply]",
  );
  process.exit(1);
}

const machines = await getMachines(pool);
const client = await pool.connect();
try {
  await client.query("BEGIN");
  for (const fileNo of fileNos) {
    const { rows: visits } = await client.query(
      `SELECT v.id, v.patient_id FROM giniflow_visits v JOIN patients p ON p.id = v.patient_id
        WHERE p.file_no = $1 AND v.visit_date = $2::date AND v.merged_into_visit_id IS NULL`,
      [fileNo, date],
    );
    if (visits.length !== 1)
      throw new Error(`${fileNo}: expected one visit, found ${visits.length}`);
    const visit = visits[0];
    const bill = await storedBill(visit.patient_id, date, client);
    if (bill?.status !== "billed") throw new Error(`${fileNo}: no billed HealthRay bill stored`);
    const billed = new Set(billedMachineLines(bill, machines).flatMap((l) => l.machines));
    const invoices = [...new Set(bill.items.map((i) => i.invoice).filter(Boolean))].join(", ");

    const { rows: orders } = await client.query(
      `SELECT o.id, o.payment_status, o.sample_status, o.amount_paid,
              (SELECT string_agg(t.test_name, ', ') FROM giniflow_lab_order_tests t
                WHERE t.lab_order_id = o.id) AS tests
         FROM giniflow_lab_orders o WHERE o.visit_id = $1 AND o.kind = 'machine'`,
      [visit.id],
    );
    const unbilled = orders.filter((o) => {
      const machine = machines.find((m) => m.name === o.tests || m.id === o.tests?.toLowerCase());
      return !machine || !billed.has(machine.id);
    });
    console.log(
      `${fileNo}: bill ${invoices} has machine tests [${[...billed].join(", ") || "none"}]`,
    );
    for (const o of unbilled) {
      if (o.sample_status !== "paid" && o.sample_status !== "payment_pending") {
        throw new Error(`${fileNo}: ${o.tests} is already ${o.sample_status}; not touching it`);
      }
      await cancelTestIn(client, {
        target: { orderId: o.id },
        reason: NOT_ON_BILL_REASON,
        source: "healthray",
        actorRole: "system",
        refundAmount: 0,
        note: `Payment cleared at reception by mistake; HealthRay bill ${invoices} has no ${o.tests}. No money collected for it.`,
      });
      console.log(`  cancelled ${o.tests} (${o.payment_status} ₹${o.amount_paid}, refund ₹0)`);
    }
    const { rows: steps } = await client.query(
      `SELECT string_agg(s.step_catalog_id || ':' || s.status, ', ' ORDER BY s.step_order) AS s
         FROM giniflow_visit_steps s LEFT JOIN flow_step_catalog c ON c.id = s.step_catalog_id
        WHERE s.visit_id = $1 AND COALESCE(c.machine, FALSE)`,
      [visit.id],
    );
    console.log(`  machine steps now: ${steps[0].s || "none"}`);
  }
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
