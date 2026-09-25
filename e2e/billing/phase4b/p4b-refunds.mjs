import { getPool, one, query } from "../../helpers/db.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { desk, extraVisit, payRule } from "../phase4/p4-bills-fixture.mjs";

const bills = await import("../../../server/services/billing/bills.js");
const payments = await import("../../../server/services/billing/payments.js");
const shifts = await import("../../../server/services/billing/cashShifts.js");
const requests = await import("../../../server/services/billing/billingRequests.js");

export const db = getPool();

export const admin = { actorId: USERS.admin.id, ip: "10.9.40.9", role: USERS.admin.role };

export const DESK_USERS = [USERS.reception.id];

export const closeOpenShifts = () =>
  query(
    `UPDATE cash_shifts
        SET closed_at = NOW(), expected_cash = 0, counted_cash = 0, difference = 0
      WHERE closed_at IS NULL AND user_id = ANY($1::int[])`,
    [DESK_USERS],
  );

export async function dropShifts() {
  await closeOpenShifts();
  await query(
    `DELETE FROM cash_shifts s WHERE s.user_id = ANY($1::int[])
        AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.shift_id = s.id)`,
    [DESK_USERS],
  ).catch(() => {});
}

export async function openDeskShift(openingCash = 0) {
  await closeOpenShifts();
  return shifts.openShift({ opening_cash: openingCash }, desk, db);
}

export async function prepareCategory(ids) {
  await query(`UPDATE patient_schemes SET allow_pay_later = TRUE WHERE code = $1`, [ids.pensioner]);
  await payRule(ids, ids.pensioner, { name: "pensioner pays", patient_pays: "full" });
}

export async function draftWith(ids, label, lines, { category = ids.pensioner, codes = [] } = {}) {
  const { visit } = await extraVisit(ids, label);
  const draft = await bills.openDraft(visit, desk, db);
  for (const line of lines) {
    const added = await bills.addLine(draft.id, { item_id: line.item }, desk, db);
    if (line.quantity && line.quantity !== 1) {
      const saved = added.lines.find((l) => l.service_item_id === line.item);
      await bills.changeQuantity(draft.id, saved.id, { quantity: line.quantity }, desk, db);
    }
  }
  await bills.setCategory(draft.id, { category }, desk, db);
  for (const code of codes) await bills.addCode(draft.id, { code }, desk, db);
  return { visit, bill: await bills.readBill(draft.id, db) };
}

export const inCash = (bill) => [{ mode: "cash", amount: bill.totals.payable / 100 }];

export async function finalBill(ids, label, lines, { pay = [], payLater = false, ...rest } = {}) {
  const { visit, bill: draft } = await draftWith(ids, label, lines, rest);
  let version = draft.version;
  const taking = typeof pay === "function" ? pay(draft) : pay;
  if (taking.length) {
    const taken = await payments.takePayments(draft.id, { version, payments: taking }, desk, db);
    version = taken.version;
  }
  const bill = await bills.finaliseBill(draft.id, { version, pay_later: payLater }, desk, db);
  return { visit, bill };
}

export async function payOn(billId, pay) {
  const bill = await bills.readBill(billId, db);
  return payments.takePayments(billId, { version: bill.version, payments: pay }, desk, db);
}

export const lineFor = (bill, item) => bill.lines.find((line) => line.service_item_id === item);

export async function askRefund(billId, lines, extra = {}) {
  return requests.createRefundRequest(
    {
      bill_id: billId,
      ...(lines === "whole" ? { whole_bill: true } : { lines }),
      reason: "The patient asked for the money back",
      ...extra,
    },
    desk,
    db,
  );
}

export async function refundApproved(billId, lines, { ask = {}, decide = {} } = {}) {
  const request = await askRefund(billId, lines, ask);
  return requests.approveRequest(request.id, decide, admin, db);
}

export const billRow = (id) =>
  one(
    `SELECT id, bill_no, bill_type, status, original_bill_id, actual_amount, discount_amount,
            tax_amount, patient_payable, claim_amount, adjustment_amount, round_off, paid_amount,
            claim_status, version
       FROM bills WHERE id = $1`,
    [id],
  );

export const linesOf = (billId) =>
  query(
    `SELECT id, line_no, is_live, credited_line_id, service_item_id, lab_order_id, quantity,
            actual_amount, discount, listed_discount, payable_discount, bill_discount, taxable,
            cgst, sgst, patient_payable, claim_amount, adjustment_amount
       FROM bill_lines WHERE bill_id = $1 ORDER BY line_no`,
    [billId],
  ).then((r) => r.rows);

export const paiseOf = (value) => Math.round(Number(value) * 100);

export const auditActions = (entity, id) =>
  query(`SELECT action FROM billing_audit WHERE entity = $1 AND entity_id = $2 ORDER BY id`, [
    entity,
    String(id),
  ]).then((r) => r.rows.map((row) => row.action));
