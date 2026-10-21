import "../loadEnv.js";
import pool from "../config/db.js";
import { cancelTestIn } from "../services/giniflow/testCancel.js";
import { storedBill, billedMachineLines } from "../services/giniflow/patientBill.js";
import { getMachines } from "../services/giniflow/machineCatalog.js";
import { refundCancelledTest } from "../services/billing/billingRequests.js";
import { REFUND_REASON_FOR_CANCEL } from "../../shared/testCancelReasons.js";

const [date, fileNo] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const apply = process.argv.includes("--apply");
const actorId = Number(process.argv.find((a) => a.startsWith("--actor="))?.split("=")[1]) || null;
if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "") || !fileNo || !actorId) {
  console.error(
    "Usage: node scripts/cancel-scribe-billed-machine-tests.mjs <YYYY-MM-DD> <file_no> --actor=<staff id> [--apply]",
  );
  process.exit(1);
}

const { rows: actors } = await pool.query(
  `SELECT id, name, role FROM doctors WHERE id = $1 AND is_active IS NOT FALSE`,
  [actorId],
);
if (!actors.length) {
  console.error(`No active staff account with id ${actorId}`);
  await pool.end();
  process.exit(1);
}
const actor = actors[0];
console.log(`Recorded as: ${actor.name} (${actor.role}, id ${actor.id})`);

const machines = await getMachines(pool);
const client = await pool.connect();
try {
  await client.query("BEGIN");
  const { rows: visits } = await client.query(
    `SELECT v.id, v.patient_id FROM giniflow_visits v JOIN patients p ON p.id = v.patient_id
      WHERE p.file_no = $1 AND v.visit_date = $2::date AND v.merged_into_visit_id IS NULL`,
    [fileNo, date],
  );
  if (visits.length !== 1) throw new Error(`${fileNo}: expected one visit, found ${visits.length}`);
  const visit = visits[0];
  const bill = await storedBill(visit.patient_id, date, client);
  if (bill?.status !== "billed") throw new Error(`${fileNo}: no billed HealthRay bill stored`);
  const billed = new Set(billedMachineLines(bill, machines).flatMap((l) => l.machines));
  const invoices = [...new Set(bill.items.map((i) => i.invoice).filter(Boolean))].join(", ");
  console.log(
    `${fileNo}: HealthRay ${invoices} machine tests [${[...billed].join(", ") || "none"}]`,
  );

  const { rows: orders } = await client.query(
    `SELECT o.id, o.sample_status, o.amount_paid,
            (SELECT string_agg(t.test_name, ', ') FROM giniflow_lab_order_tests t
              WHERE t.lab_order_id = o.id) AS tests,
            (SELECT string_agg(DISTINCT b.bill_no, ', ') FROM bill_lines l JOIN bills b ON b.id = l.bill_id
              WHERE l.lab_order_id = o.id AND l.is_live AND b.status = 'final') AS final_bill
       FROM giniflow_lab_orders o WHERE o.visit_id = $1 AND o.kind = 'machine'`,
    [visit.id],
  );
  const unbilled = orders.filter((o) => {
    const machine = machines.find((m) => m.name === o.tests || m.id === o.tests?.toLowerCase());
    return !machine || !billed.has(machine.id);
  });
  if (!unbilled.length) console.log("  every machine test is on the HealthRay bill; nothing to do");
  const lines = [];
  for (const o of unbilled) {
    if (o.sample_status !== "paid") {
      throw new Error(`${fileNo}: ${o.tests} is ${o.sample_status}; not touching it`);
    }
    const done = await cancelTestIn(client, {
      target: { orderId: o.id },
      reason: "billed_by_mistake",
      source: "reception",
      stationLabel: "reception",
      actorId: actor.id,
      actorRole: actor.role,
      note: `Not on HealthRay bill ${invoices}`,
      skipRefund: true,
    });
    lines.push(...(done.billedLines || []));
    console.log(
      `  cancelled ${o.tests} (paid ₹${o.amount_paid}, on ${o.final_bill || "no final bill"})`,
    );
  }
  if (lines.length) {
    const refunds = await refundCancelledTest(
      {
        lines,
        reasonCode: REFUND_REASON_FOR_CANCEL.billed_by_mistake,
        note: `Not on HealthRay bill ${invoices}`,
      },
      { actorId: actor.id, role: actor.role },
      client,
    );
    for (const r of refunds) {
      console.log(
        `  refund request ${r.status} on ${r.bill_no}: ${r.request_id} (${lines.length} line(s))`,
      );
    }
  }
  const { rows: steps } = await client.query(
    `SELECT string_agg(s.step_catalog_id || ':' || s.status, ', ' ORDER BY s.step_order) AS s
       FROM giniflow_visit_steps s LEFT JOIN flow_step_catalog c ON c.id = s.step_catalog_id
      WHERE s.visit_id = $1 AND COALESCE(c.machine, FALSE)`,
    [visit.id],
  );
  console.log(`  machine steps now: ${steps[0].s || "none"}`);
  if (apply) {
    await client.query("COMMIT");
    console.log("\nCommitted. Approve the refund requests on the Refunds board.");
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
