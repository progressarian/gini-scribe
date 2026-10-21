import "../loadEnv.js";
import pool from "../config/db.js";
import { cancelTestIn } from "../services/giniflow/testCancel.js";
import {
  storedBill,
  billedMachineLines,
  isLiveBillItem,
} from "../services/giniflow/patientBill.js";
import { getMachines } from "../services/giniflow/machineCatalog.js";
import { requestLineRefund, rejectRequest } from "../services/billing/billingRequests.js";
import { billCredits, discountFinalBill } from "../services/billing/creditNotes.js";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const [date, ...fileNos] = args;
const apply = process.argv.includes("--apply");
const actorId = Number(process.argv.find((a) => a.startsWith("--actor="))?.split("=")[1]) || null;
if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "") || !fileNos.length || !actorId) {
  console.error(
    "Usage: node scripts/correct-bills-to-healthray.mjs <YYYY-MM-DD> <file_no>... --actor=<staff id> [--apply]",
  );
  process.exit(1);
}

const rupees = (n) => `₹${Number(n).toFixed(2)}`;

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
const ctx = { actorId: actor.id, role: actor.role };
console.log(
  `${apply ? "APPLY" : "DRY RUN"} — recorded as ${actor.name} (${actor.role}, id ${actor.id})`,
);
const machines = await getMachines(pool);

async function correct(client, fileNo) {
  const { rows: visits } = await client.query(
    `SELECT v.id, v.patient_id, p.name FROM giniflow_visits v JOIN patients p ON p.id = v.patient_id
      WHERE p.file_no = $1 AND v.visit_date = $2::date AND v.merged_into_visit_id IS NULL`,
    [fileNo, date],
  );
  if (visits.length !== 1) throw new Error(`expected one visit, found ${visits.length}`);
  const visit = visits[0];
  const hr = await storedBill(visit.patient_id, date, client);
  if (hr?.status !== "billed") throw new Error("no HealthRay bill stored for that day");
  const live = hr.items.filter(isLiveBillItem);
  const hrTotal = live.reduce((sum, i) => sum + Number(i.amount || 0), 0);
  const invoices = [...new Set(hr.items.map((i) => i.invoice).filter(Boolean))].join(", ");
  const { rows: bills } = await client.query(
    `SELECT id, bill_no, patient_payable, paid_amount FROM bills
      WHERE visit_id = $1 AND bill_type = 'invoice' AND status = 'final'`,
    [visit.id],
  );
  if (bills.length !== 1) throw new Error(`expected one final Scribe bill, found ${bills.length}`);
  const bill = bills[0];
  console.log(
    `\n=== ${fileNo} ${visit.name}: ${bill.bill_no} paid ${rupees(bill.paid_amount)}; HealthRay ${invoices} ${rupees(hrTotal)} (${live.map((i) => `${i.desc} ${i.amount}`).join("; ")})`,
  );

  const billed = new Set(billedMachineLines(hr, machines).flatMap((l) => l.machines));
  const { rows: orders } = await client.query(
    `SELECT o.id, o.sample_status,
            (SELECT string_agg(t.test_name, ', ') FROM giniflow_lab_order_tests t
              WHERE t.lab_order_id = o.id) AS tests
       FROM giniflow_lab_orders o
      WHERE o.visit_id = $1 AND o.kind = 'machine'
        AND EXISTS (SELECT 1 FROM bill_lines l WHERE l.lab_order_id = o.id AND l.bill_id = $2 AND l.is_live)`,
    [visit.id, bill.id],
  );
  const lineIds = new Set();
  for (const o of orders) {
    const machine = machines.find((m) => m.name === o.tests || m.id === o.tests?.toLowerCase());
    if (machine && billed.has(machine.id)) continue;
    if (o.sample_status !== "paid")
      throw new Error(`${o.tests} is ${o.sample_status}; not touching it`);
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
    for (const line of done.billedLines || []) lineIds.add(line.line_id);
    console.log(`  cancelled ${o.tests}`);
  }

  const { rows: pending } = await client.query(
    `SELECT id, refund_lines FROM billing_requests
      WHERE bill_id = $1 AND kind = 'refund' AND status = 'pending'`,
    [bill.id],
  );
  for (const p of pending) for (const l of p.refund_lines || []) lineIds.add(l.line_id);
  const credits = await billCredits(client, { id: bill.id, bill_type: "invoice", status: "final" });
  for (const l of credits?.cancelled_not_refunded || []) lineIds.add(l.line_id);

  if (lineIds.size) {
    for (const p of pending) {
      await rejectRequest(
        p.id,
        { note: "Replaced by one refund request covering every cancelled test on this bill" },
        ctx,
        client,
      );
      console.log(`  replaced pending refund request ${p.id}`);
    }
    const request = await requestLineRefund(
      {
        line_ids: [...lineIds],
        reason_code: "billed_by_mistake",
        note: `Not on HealthRay bill ${invoices}; only the HealthRay amount was collected`,
        requested_mode: "cash",
      },
      ctx,
      client,
    );
    console.log(`  refund request ${request.id} raised for ${lineIds.size} line(s) (cash)`);
  }

  const { rows: lines } = await client.query(
    `SELECT l.id, l.source, l.bill_name, l.patient_payable,
            COALESCE((SELECT sum(x.patient_payable) FROM bill_lines x WHERE x.credited_line_id = l.id), 0) AS credited
       FROM bill_lines l WHERE l.bill_id = $1 ORDER BY l.line_no`,
    [bill.id],
  );
  const kept = lines
    .filter((l) => !lineIds.has(l.id))
    .reduce((sum, l) => sum + Number(l.patient_payable) - Number(l.credited), 0);
  const extra = Math.round((kept - hrTotal) * 100) / 100;
  if (extra > 0) {
    const consult = lines.find((l) => l.source === "visit" && !lineIds.has(l.id));
    if (!consult)
      throw new Error(`${rupees(extra)} above HealthRay but no consultation line to discount`);
    await discountFinalBill(
      bill.id,
      {
        kind: "flat",
        value: extra,
        line_id: consult.id,
        reason: `HealthRay bill ${invoices} charged ${rupees(hrTotal)}; only that was collected`,
      },
      ctx,
      client,
    );
    console.log(
      `  discount ${rupees(extra)} on "${consult.bill_name}" (credit note, paid back in cash)`,
    );
  }
  console.log(
    `  after: tests refund ${lineIds.size ? "requested" : "none"}, kept ${rupees(Math.min(kept, hrTotal))} = HealthRay ${rupees(hrTotal)}`,
  );
}

const client = await pool.connect();
let failed = 0;
for (const fileNo of fileNos) {
  try {
    await client.query("BEGIN");
    await correct(client, fileNo);
    await client.query(apply ? "COMMIT" : "ROLLBACK");
  } catch (e) {
    await client.query("ROLLBACK");
    failed++;
    console.error(`  ${fileNo}: not changed — ${e.message}`);
  }
}
client.release();
await pool.end();
console.log(
  apply
    ? `\nDone${failed ? `, ${failed} failed` : ""}. Approve the refund requests on the Refunds board, then pay back at the counter.`
    : "\nDry run, rolled back. Re-run with --apply to keep it.",
);
if (failed) process.exitCode = 1;
