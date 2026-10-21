import "../loadEnv.js";
import pool from "../config/db.js";
import { storedBill, isLiveBillItem } from "../services/giniflow/patientBill.js";
import { discountFinalBill } from "../services/billing/creditNotes.js";
import {
  addLineIn,
  finaliseBill,
  openDraftIn,
  readBill,
  setBillDiscount,
} from "../services/billing/bills.js";
import { clearInHealthray } from "../services/billing/payments.js";
import { approveRequest, createRepeatRequest } from "../services/billing/billingRequests.js";

const [date, fileNo] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const apply = process.argv.includes("--apply");
const actorId = Number(process.argv.find((a) => a.startsWith("--actor="))?.split("=")[1]) || null;
if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "") || !fileNo || !actorId) {
  console.error(
    "Usage: node scripts/reissue-bill-paid-in-healthray.mjs <YYYY-MM-DD> <file_no> --actor=<staff id> [--apply]",
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

const client = await pool.connect();
try {
  await client.query("BEGIN");
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
  const hrConsult = live.filter((i) => i.category === "consultation");
  if (live.length !== hrConsult.length || hrConsult.length !== 1) {
    throw new Error("the HealthRay bill is not a single consultation; reissue it by hand");
  }
  const hrAmount = Number(hrConsult[0].amount);
  const invoice = hrConsult[0].invoice || hr.invoiceNo || "the HealthRay bill";

  const { rows: olds } = await client.query(
    `SELECT id, bill_no FROM bills
      WHERE visit_id = $1 AND bill_type = 'invoice' AND status = 'final'`,
    [visit.id],
  );
  if (olds.length !== 1) throw new Error(`expected one final Scribe bill, found ${olds.length}`);
  const old = olds[0];
  const { rows: consults } = await client.query(
    `SELECT l.id, l.bill_name, l.service_item_id, l.doctor_id, l.patient_payable,
            l.patient_payable - COALESCE((SELECT sum(x.patient_payable) FROM bill_lines x
                                           WHERE x.credited_line_id = l.id), 0) AS left_amount
       FROM bill_lines l WHERE l.bill_id = $1 AND l.source = 'visit'`,
    [old.id],
  );
  if (consults.length !== 1) throw new Error(`expected one consultation line on ${old.bill_no}`);
  const consult = consults[0];
  console.log(
    `${fileNo} ${visit.name}: ${old.bill_no} "${consult.bill_name}" ${rupees(consult.patient_payable)}, ${rupees(consult.left_amount)} still on it; HealthRay ${invoice} ${rupees(hrAmount)}`,
  );

  if (Number(consult.left_amount) > 0) {
    await discountFinalBill(
      old.id,
      {
        kind: "flat",
        value: Number(consult.left_amount),
        line_id: consult.id,
        reason: `Test entry: nothing was collected at the Scribe counter; ${rupees(hrAmount)} was paid in HealthRay ${invoice}. Reissued as a new bill.`,
      },
      ctx,
      client,
    );
    console.log(
      `  ${old.bill_no}: remaining ${rupees(consult.left_amount)} credited (paid back in cash)`,
    );
  }

  const repeat = await createRepeatRequest(
    {
      service_item_id: consult.service_item_id,
      visit_id: visit.id,
      bill_id: old.id,
      reason: `${old.bill_no} was a test entry and is fully credited; reissuing the consultation as paid in HealthRay ${invoice}`,
    },
    ctx,
    client,
  );
  await approveRequest(repeat.id, { note: "Reissue of a test bill" }, ctx, client);
  console.log(`  approval to bill "${consult.bill_name}" again: ${repeat.id}`);

  let draft = await openDraftIn(client, visit.id, ctx);
  await addLineIn(
    client,
    draft,
    { item_id: consult.service_item_id, source: "visit", doctor_id: consult.doctor_id },
    ctx,
  );
  draft = await readBill(draft.id, client);
  const priced = Number(draft.totals.payable) / 100;
  if (priced > hrAmount) {
    draft = await setBillDiscount(
      draft.id,
      {
        kind: "flat",
        value: Math.round((priced - hrAmount) * 100) / 100,
        reason: `HealthRay ${invoice} charged ${rupees(hrAmount)}`,
      },
      ctx,
      client,
    );
  }
  if (Number(draft.totals.payable) / 100 !== hrAmount) {
    throw new Error(
      `new bill comes to ${rupees(Number(draft.totals.payable) / 100)}, not ${rupees(hrAmount)}`,
    );
  }
  const paid = await clearInHealthray(draft.id, { version: draft.version }, ctx, client);
  const final = await finaliseBill(draft.id, { version: paid.version }, ctx, client);
  console.log(
    `  new bill ${final.bill_no}: "${consult.bill_name}" ${rupees(hrAmount)}, Paid in HealthRay`,
  );

  if (apply) {
    await client.query("COMMIT");
    console.log(
      `\nCommitted. ${old.bill_no}: approve its refund request and pay back its credit notes in cash at the counter.`,
    );
  } else {
    await client.query("ROLLBACK");
    console.log("\nDry run, rolled back. Re-run with --apply to keep it.");
  }
} catch (e) {
  await client.query("ROLLBACK");
  console.error(`Not changed: ${e.message}`);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
