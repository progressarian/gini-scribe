import "../loadEnv.js";
import pool from "../config/db.js";
import { derivePaymentStatus, paise, rupeesFromPaise } from "../../shared/labPayment.js";
import { writeOrderMoney } from "../services/billing/payments.js";
import { writeAudit } from "../services/billing/audit.js";

const [billNo, ...orderIds] = process.argv.slice(2).filter((arg) => arg !== "--write");
const write = process.argv.includes("--write");
if (!billNo || !orderIds.length) {
  console.error("Usage: node scripts/settle-package-orders.mjs <bill_no> <order_id>... [--write]");
  process.exit(1);
}
const ctx = { role: "reception", actorId: null };

const client = await pool.connect();
try {
  await client.query("BEGIN");
  const { rows: bills } = await client.query(
    `SELECT id, bill_no, visit_id, status, paid_amount, patient_payable FROM bills
      WHERE bill_no = $1 AND bill_type = 'invoice' FOR UPDATE`,
    [billNo],
  );
  const bill = bills[0];
  if (!bill || bill.status !== "final") throw new Error(`${billNo} is not a final invoice`);
  if (paise(bill.paid_amount) < paise(bill.patient_payable))
    throw new Error(`${billNo} is not fully paid`);
  for (const orderId of orderIds) {
    const { rows } = await client.query(
      `SELECT id, visit_id, version, amount_total, amount_paid, amount_claimed, claim_state, payment_status
         FROM giniflow_lab_orders WHERE id = $1 FOR UPDATE`,
      [orderId],
    );
    const order = rows[0];
    if (!order || order.visit_id !== bill.visit_id)
      throw new Error(`${orderId} is not on ${billNo}'s visit`);
    if (order.payment_status !== "pending" || paise(order.amount_paid) > 0) {
      console.log(`${orderId}: already ${order.payment_status}, skipped`);
      continue;
    }
    const after = {
      amountTotal: order.amount_total,
      amountPaid: rupeesFromPaise(paise(order.amount_total)),
      amountClaimed: rupeesFromPaise(0),
      claimState: order.claim_state,
    };
    const before = {
      amount_paid: order.amount_paid,
      amount_claimed: order.amount_claimed,
      claim_state: order.claim_state,
    };
    const written = {
      amount_paid: after.amountPaid,
      amount_claimed: after.amountClaimed,
      claim_state: after.claimState,
    };
    const done = await writeOrderMoney(client, order, after, derivePaymentStatus(after), ctx, {
      bill_id: bill.id,
      bill_no: bill.bill_no,
      before,
      after: written,
      bill_claim: rupeesFromPaise(0),
      reason: "paid on the bill as a package line",
    });
    await writeAudit(client, {
      entity: "giniflow_lab_orders",
      entityId: order.id,
      action: "update",
      before: { ...before, payment_status: order.payment_status },
      after: { ...written, payment_status: done.payment_status, bill_no: bill.bill_no },
    });
    console.log(
      `${orderId}: ${order.payment_status} -> ${done.payment_status}, paid ${after.amountPaid}`,
    );
  }
  await client.query(write ? "COMMIT" : "ROLLBACK");
  console.log(write ? "Committed" : "Dry run rolled back");
} catch (error) {
  await client.query("ROLLBACK");
  console.error(error.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
