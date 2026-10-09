import { test, expect } from "@playwright/test";
import { one, query } from "../../helpers/db.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { desk, newTag, setUp, tearDown } from "../phase4/p4-bills-fixture.mjs";
import {
  admin,
  db,
  draftWith,
  dropShifts,
  finalBill,
  lineFor,
  openDeskShift,
  payOn,
  prepareCategory,
  refundApproved,
} from "../phase4b/p4b-refunds.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const deposits = await import("../../../server/services/billing/deposits.js");
const payments = await import("../../../server/services/billing/payments.js");
const shifts = await import("../../../server/services/billing/cashShifts.js");
const creditNotes = await import("../../../server/services/billing/creditNotes.js");

const tag = newTag();
let ids;

const balanceOf = async (patientId) => (await deposits.getDeposit(patientId, db)).balance;
const receive = (patientId, body) => deposits.receiveDeposit(patientId, body, desk, db);
const fromDeposit = (rupees) => ({ mode: "deposit", amount: rupees });
const drawer = async () => (await shifts.currentShift(desk, db)).expected_cash;

async function billFor(label, lines = [{ item: ids.brace }]) {
  const { bill } = await draftWith(ids, label, lines);
  return bill;
}

test.describe.serial("D01 deposits: receive, use on a bill, keep a refund as deposit", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    await prepareCategory(ids);
  });

  test.afterAll(async () => {
    await tearDown(ids);
    await dropShifts();
  });

  test("1. cash needs an open shift; card needs its reference", async () => {
    await dropShifts();
    const bill = await billFor("NoShift");
    await expect(receive(bill.patient_id, { mode: "cash", amount: 2000 })).rejects.toMatchObject({
      status: 409,
    });
    await expect(receive(bill.patient_id, { mode: "card", amount: 2000 })).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      receive(bill.patient_id, { mode: "upi", amount: 500000.01, reference: "UPI-MAX" }),
    ).rejects.toMatchObject({ status: 400, message: "One deposit can be at most ₹5,00,000" });
    expect(await balanceOf(bill.patient_id)).toBe(0);
  });

  test("2. a cash deposit is in the drawer once, with a receipt and a passbook line", async () => {
    await openDeskShift(1000);
    const bill = await billFor("Receive");
    const before = await drawer();
    const taken = await receive(bill.patient_id, { mode: "cash", amount: 2000, note: "advance" });
    expect(taken).toMatchObject({ amount: 200000, balance: 200000 });
    expect(taken.receipt_no).toBeTruthy();
    expect(await drawer()).toBe(before + 2000);
    const shift = await shifts.currentShift(desk, db);
    expect(shift.deposits).toMatchObject({ count: 1, received: 2000 });
    const account = await deposits.getDeposit(bill.patient_id, db);
    expect(account.entries[0]).toMatchObject({
      kind: "received",
      amount: 200000,
      balance_after: 200000,
      mode: "cash",
      note: "advance",
    });
  });

  test("3. part of a bill from the deposit, the rest in cash; only the cash reaches the drawer", async () => {
    const bill = await billFor("Apply", [{ item: ids.brace }, { item: ids.dressing }]);
    await receive(bill.patient_id, { mode: "upi", amount: 1000, reference: `UPI-${tag}` });
    const before = await drawer();
    const payable = bill.totals.payable / 100;
    const taken = await payOn(bill.id, [
      fromDeposit(1000),
      { mode: "cash", amount: payable - 1000 },
    ]);
    expect(taken.totals.outstanding).toBe(0);
    expect(await drawer()).toBe(before + payable - 1000);
    expect(await balanceOf(bill.patient_id)).toBe(0);
    const row = await one(
      `SELECT shift_id, receipt_no FROM payments WHERE bill_id = $1 AND mode = 'deposit'`,
      [bill.id],
    );
    expect(row.shift_id).toBeNull();
    expect(row.receipt_no).toBeTruthy();
    const account = await deposits.getDeposit(bill.patient_id, db);
    expect(account.entries[0]).toMatchObject({
      kind: "applied",
      amount: -100000,
      balance_after: 0,
    });
  });

  test("4. more than the deposit holds is refused, and the bill is untouched", async () => {
    const bill = await billFor("TooMuch");
    await receive(bill.patient_id, { mode: "cash", amount: 100 });
    await expect(payOn(bill.id, [fromDeposit(500)])).rejects.toMatchObject({ status: 409 });
    expect(await balanceOf(bill.patient_id)).toBe(10000);
    const { count } = await one(`SELECT COUNT(*)::int AS count FROM payments WHERE bill_id = $1`, [
      bill.id,
    ]);
    expect(count).toBe(0);
  });

  test("5. two desks spending one deposit at once: exactly one wins", async () => {
    const first = await billFor("RaceA");
    const second = await billFor("RaceB");
    await query(`UPDATE bills SET patient_id = $2 WHERE id = $1`, [second.id, first.patient_id]);
    await receive(first.patient_id, { mode: "cash", amount: 1000 });
    const results = await Promise.allSettled([
      payOn(first.id, [fromDeposit(700)]),
      payOn(second.id, [fromDeposit(700)]),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected").reason).toMatchObject({ status: 409 });
    expect(await balanceOf(first.patient_id)).toBe(30000);
  });

  test("6. a cancelled service on a cash-paid bill is kept as deposit, with nothing to pay out", async () => {
    const { bill } = await finalBill(
      ids,
      "KeepCash",
      [{ item: ids.brace }, { item: ids.dressing }],
      {
        pay: (draft) => [{ mode: "cash", amount: draft.totals.payable / 100 }],
      },
    );
    const before = await drawer();
    const approved = await refundApproved(bill.id, [{ line_id: lineFor(bill, ids.dressing).id }], {
      ask: { requested_mode: "deposit" },
    });
    expect(approved.approved_mode ?? approved.refund?.approved_mode).toBe("deposit");
    expect(await balanceOf(bill.patient_id)).toBe(50000);
    const note = await creditNotes.readCreditNote(approved.credit_note.id, db);
    expect(note.refund.due).toBe(0);
    expect(await drawer()).toBe(before);
    const account = await deposits.getDeposit(bill.patient_id, db);
    expect(account.entries[0]).toMatchObject({ kind: "restored", amount: 50000 });
  });

  test("7. 'as paid' on a deposit-paid bill puts the deposit share back, cash share stays to pay", async () => {
    const { bill: draft } = await draftWith(ids, "AsPaidMix", [
      { item: ids.brace },
      { item: ids.dressing },
    ]);
    await receive(draft.patient_id, { mode: "cash", amount: 500 });
    await payOn(draft.id, [fromDeposit(500)]);
    const paid = await payOn(draft.id, [
      { mode: "cash", amount: draft.totals.payable / 100 - 500 },
    ]);
    const { finaliseBill } = await import("../../../server/services/billing/bills.js");
    const bill = await finaliseBill(draft.id, { version: paid.version }, desk, db);
    const approved = await refundApproved(bill.id, "whole");
    const note = await creditNotes.readCreditNote(approved.credit_note.id, db);
    expect(await balanceOf(draft.patient_id)).toBe(50000);
    expect(note.refund.due).toBe(bill.totals.payable - 50000);
    expect(note.refund.legs).toEqual([{ mode: "cash", amount: bill.totals.payable - 50000 }]);
  });

  test("8. an admin can turn a cash refund into a deposit at approval, with a reason", async () => {
    const { bill } = await finalBill(ids, "AdminKeeps", [{ item: ids.brace }], {
      pay: (draft) => [{ mode: "cash", amount: draft.totals.payable / 100 }],
    });
    await refundApproved(bill.id, "whole", {
      ask: { requested_mode: "cash" },
      decide: { approved_mode: "deposit", mode_reason: "Patient will be admitted tomorrow" },
    });
    expect(await balanceOf(bill.patient_id)).toBe(bill.totals.payable);
  });

  test("9. a discount after the bill was final goes back into the deposit it was paid from", async () => {
    const { bill: draft } = await draftWith(ids, "Discount", [{ item: ids.brace }]);
    await receive(draft.patient_id, { mode: "cash", amount: draft.totals.payable / 100 });
    const paid = await payOn(draft.id, [fromDeposit(draft.totals.payable / 100)]);
    const { finaliseBill } = await import("../../../server/services/billing/bills.js");
    const bill = await finaliseBill(draft.id, { version: paid.version }, desk, db);
    const given = await creditNotes.discountFinalBill(
      bill.id,
      { version: bill.version, kind: "flat", value: 100, reason: "Goodwill" },
      admin,
      db,
    );
    expect(given.kept_as_deposit).toBe(10000);
    expect(await balanceOf(draft.patient_id)).toBe(10000);
  });

  test("10. the ledger cannot be edited, and a deposit payment never carries a shift", async () => {
    await expect(query(`UPDATE deposit_entries SET amount = 1 WHERE TRUE`)).rejects.toThrow(
      /append-only/,
    );
    await expect(query(`DELETE FROM deposit_entries WHERE TRUE`)).rejects.toThrow(/append-only/);
    const shift = await one(`SELECT id FROM cash_shifts WHERE closed_at IS NULL LIMIT 1`);
    const bill = await one(`SELECT id FROM bills WHERE bill_type = 'invoice' LIMIT 1`);
    await expect(
      query(
        `INSERT INTO payments (bill_id, mode, amount, shift_id) VALUES ($1, 'deposit', 1, $2)`,
        [bill.id, shift.id],
      ),
    ).rejects.toThrow(/payments_deposit_no_shift_check/);
  });

  test("11. the collections report shows deposits taken on their own line and leaves internal moves out", async () => {
    const reports = await import("../../../server/services/billing/reports.js");
    const today = (await one(`SELECT (NOW() AT TIME ZONE 'Asia/Kolkata')::date::text AS d`)).d;
    const result = await reports.runReport("collections", { from: today, to: today }, db);
    const modes = result.sections.find((part) => part.key === "modes");
    expect(modes.rows.find((row) => row.mode === "deposit")).toBeUndefined();
    const { taken } = await one(
      `SELECT COALESCE(SUM(amount), 0)::float AS taken FROM payments
        WHERE bill_id IS NULL AND mode = 'cash' AND direction = 'in'
          AND (received_at AT TIME ZONE 'Asia/Kolkata')::date = $1::date`,
      [today],
    );
    const line = modes.rows.find((row) => row.label === "Cash — deposit taken");
    expect(line.received).toBe(Math.round(taken * 100));
  });

  test("12. the deposit receipt names the patient, receipt no., amount and balance, and refuses bill payments", async () => {
    const receipts = await import("../../../server/services/billing/depositReceiptPdf.js");
    const bill = await billFor("Receipt");
    const taken = await receive(bill.patient_id, {
      mode: "cash",
      amount: 1500,
      note: "before admission",
    });
    const view = await receipts.depositReceiptView(taken.payment_id, db);
    const html = receipts.buildDepositReceiptHtml(view);
    expect(html).toContain("ADVANCE DEPOSIT RECEIPT");
    expect(html).toContain(taken.receipt_no);
    expect(html).toContain(view.patient.name);
    expect(html).toContain("1,500.00");
    expect(html).toContain("before admission");
    const billPayment = await one(`SELECT id FROM payments WHERE bill_id IS NOT NULL LIMIT 1`);
    await expect(receipts.depositReceiptView(billPayment.id, db)).rejects.toMatchObject({
      status: 404,
    });
  });
});
