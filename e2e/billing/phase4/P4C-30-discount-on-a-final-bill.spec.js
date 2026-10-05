import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../../helpers/db.mjs";
import { apiAs, loginAs } from "../../helpers/auth.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import {
  autoConsultation,
  desk,
  extraVisit,
  newTag,
  setUp,
  tearDown,
} from "./p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");
const payments = await import("../../../server/services/billing/payments.js");
const shifts = await import("../../../server/services/billing/cashShifts.js");
const credits = await import("../../../server/services/billing/creditNotes.js");
const board = await import("../../../server/services/billing/refundBoard.js");

const db = getPool();
const tag = newTag();
let ids;
let autoBefore;
let payLaterBefore;

const closeOpenShifts = () =>
  query(
    `UPDATE cash_shifts
        SET closed_at = NOW(), expected_cash = opening_cash, counted_cash = opening_cash,
            difference = 0
      WHERE closed_at IS NULL AND user_id = $1`,
    [USERS.reception.id],
  );

async function finalBill(label, { pay }) {
  const { visit } = await extraVisit(ids, label, { visitType: "Follow Up" });
  let bill = await bills.openDraft(visit, desk, db);
  bill = await bills.addLine(bill.id, { item_id: ids.dressing }, desk, db);
  bill = await bills.addLine(bill.id, { item_id: ids.brace }, desk, db);
  bill = await bills.setCategory(bill.id, { category: null }, desk, db);
  if (pay) {
    await payments.takePayments(
      bill.id,
      { version: bill.version, mode: "cash", amount: bill.totals.payable / 100 },
      desk,
      db,
    );
    bill = await bills.readBill(bill.id, db);
  }
  return bills.finaliseBill(bill.id, { version: bill.version, pay_later: !pay }, desk, db);
}

async function call(method, url, data) {
  const api = await apiAs("reception");
  const response = await api[method](url, { data });
  const body = await response.json();
  await api.dispose();
  return { status: response.status(), body };
}

test.describe.serial("P4C-30 a discount on a final bill is a discount credit note", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    autoBefore = await autoConsultation(false);
    payLaterBefore = (await one(`SELECT allow_pay_later FROM billing_settings`)).allow_pay_later;
    await query(`UPDATE billing_settings SET allow_pay_later = TRUE`);
    await closeOpenShifts();
    await shifts.openShift({ opening_cash: 0 }, desk, db);
  });

  test.afterAll(async () => {
    if (payLaterBefore !== undefined) {
      await query(`UPDATE billing_settings SET allow_pay_later = $1`, [payLaterBefore]);
    }
    if (autoBefore !== undefined) await autoConsultation(autoBefore);
    await tearDown(ids);
    await closeOpenShifts();
  });

  test("1. on an unpaid final bill the discount comes off what is still owed", async () => {
    const bill = await finalBill("F1", { pay: false });
    expect(bill.status).toBe("final");
    expect(bill.totals.payable).toBe(130000);
    const preview = await credits.previewFinalDiscount(bill.id, { kind: "percent", value: 10 }, db);
    expect(preview).toMatchObject({ amount: 13000, pay_back: 0, off_balance: 13000 });

    const made = await credits.discountFinalBill(
      bill.id,
      { kind: "percent", value: 10, reason: "Senior doctor's approval" },
      desk,
      db,
    );
    expect(made).toMatchObject({ amount: 13000, pay_back: 0, off_balance: 13000 });
    const note = await credits.readCreditNote(made.credit_note_id, db);
    expect(note.credit_kind).toBe("discount");
    expect(note.discount).toMatchObject({
      kind: "percent",
      value: 10,
      reason: "Senior doctor's approval",
      by: USERS.reception.id,
    });
    expect(note.totals.payable).toBe(13000);
    expect(note.lines.map((line) => line.quantity)).toEqual([0, 0]);
    expect(note.lines.reduce((sum, line) => sum + line.patient_payable, 0)).toBe(13000);

    const after = await bills.readBill(bill.id, db);
    expect(after.credits.credited).toBe(13000);
    expect(after.credits.balance).toBe(117000);
    expect(after.credits.to_pay_back).toBe(0);
  });

  test("2. on a paid bill the discount is money to pay back, the way it was paid", async () => {
    const bill = await finalBill("F2", { pay: true });
    const made = await credits.discountFinalBill(bill.id, { kind: "flat", value: 100 }, desk, db);
    expect(made).toMatchObject({ amount: 10000, pay_back: 10000, off_balance: 0 });
    const plan = await payments.refundPlan(made.credit_note_id, db);
    expect(plan).toMatchObject({ mode: "as_paid", due: 10000 });
    const after = await bills.readBill(bill.id, db);
    expect(after.credits.to_pay_back).toBe(10000);
    expect(after.credits.notes[0]).toMatchObject({ credit_kind: "discount", due: 10000 });
    const note = await credits.readCreditNote(made.credit_note_id, db);
    const paid = await payments.payOut(
      made.credit_note_id,
      { version: note.version, mode: "cash", amount: 100 },
      desk,
      db,
    );
    expect(paid).toBeTruthy();
    expect((await bills.readBill(bill.id, db)).credits.to_pay_back).toBe(0);
  });

  test("3. a discount on one line credits that line only", async () => {
    const bill = await finalBill("F3", { pay: false });
    const brace = bill.lines.find((line) => line.service_item_id === ids.brace);
    const made = await credits.discountFinalBill(
      bill.id,
      { kind: "flat", value: 9999, line_id: brace.id },
      desk,
      db,
    );
    expect(made.amount).toBe(80000);
    const note = await credits.readCreditNote(made.credit_note_id, db);
    expect(note.lines).toHaveLength(1);
    expect(note.lines[0]).toMatchObject({ credited_line_id: brace.id, patient_payable: 80000 });
    const again = await call("post", `/api/billing/bills/${bill.id}/final-discount`, {
      kind: "flat",
      value: 10,
      line_id: brace.id,
    });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/Nothing is left to discount on that line/);
  });

  test("4. a later full refund credits only what the discount left", async () => {
    const bill = await finalBill("F4", { pay: false });
    await credits.discountFinalBill(bill.id, { kind: "flat", value: 300 }, desk, db);
    const refund = await credits.previewCredit(bill.id, { whole_bill: true }, db);
    expect(refund.totals.payable).toBe(100000);
    const quantities = refund.lines.map((line) => line.quantity);
    expect(quantities).toEqual([1, 1]);
  });

  test("5. drafts and bad input are refused in words; the note is audited", async () => {
    const { visit } = await extraVisit(ids, "F5", { visitType: "Follow Up" });
    let draft = await bills.openDraft(visit, desk, db);
    draft = await bills.addLine(draft.id, { item_id: ids.brace }, desk, db);
    const onDraft = await call("post", `/api/billing/bills/${draft.id}/final-discount`, {
      kind: "flat",
      value: 50,
    });
    expect(onDraft.status).toBe(409);
    expect(onDraft.body.error).toMatch(/draft/);

    const bill = await finalBill("F6", { pay: false });
    const over = await call("post", `/api/billing/bills/${bill.id}/final-discount/preview`, {
      kind: "percent",
      value: 150,
    });
    expect(over.status).toBe(400);
    const made = await call("post", `/api/billing/bills/${bill.id}/final-discount`, {
      kind: "flat",
      value: "50",
      reason: "Goodwill",
    });
    expect(made.status).toBe(200);
    const audit = await one(
      `SELECT after FROM billing_audit WHERE entity = 'bills' AND entity_id = $1 AND action = 'create'`,
      [made.body.credit_note_id],
    );
    expect(audit.after.discount).toMatchObject({ kind: "flat", value: 50, reason: "Goodwill" });
  });

  test("6. the counter: review the discount, confirm it, and see the credit note", async ({
    page,
  }) => {
    const bill = await finalBill("F7", { pay: false });
    await loginAs(page, "reception");
    const box = page.getByRole("group", { name: "Discount on this final bill" });
    await gotoReady(
      page,
      `/giniflow/station/reception?tab=bill&visit=${bill.visit_id}&bill=${bill.id}`,
      () => box,
    );
    await box.getByRole("button", { name: "+ Discount on this final bill" }).click();
    await box.getByLabel("Discount %").fill("10");
    await box.getByRole("button", { name: "Review discount" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText(bill.bill_no);
    await expect(dialog).toContainText("₹130");
    await dialog.getByRole("button", { name: "Give discount" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(
      box.getByText(/Credit note .* made for ₹130 — it came off what is still owed/),
    ).toBeVisible();
    await expect(page.getByText(/Discount credit note/)).toBeVisible();
    await expect(page.getByText("Discount after the bill was final: 10%")).toBeVisible();
  });

  test("7. the refunds board lists discount pay-backs, not discounts that only cut what is owed", async () => {
    const owed = await finalBill("F8", { pay: false });
    const unpaid = await credits.discountFinalBill(owed.id, { kind: "flat", value: 50 }, desk, db);
    const paidBill = await finalBill("F9", { pay: true });
    const back = await credits.discountFinalBill(
      paidBill.id,
      { kind: "percent", value: 10, reason: "Camp" },
      desk,
      db,
    );
    const find = (groups, id) =>
      Object.values(groups)
        .flat()
        .find((row) => row.credit_note?.id === id);

    let listed = await board.refundBoard({ q: tag }, db);
    expect(find(listed.groups, unpaid.credit_note_id)).toBeUndefined();
    const row = find(listed.groups, back.credit_note_id);
    expect(row).toMatchObject({
      kind: "discount",
      group: "to_pay",
      key: back.credit_note_id,
      request_id: null,
      approved_mode: "as_paid",
      amounts: { credited: 13000, to_pay: 13000, paid_back: 0 },
    });
    expect(row.reason.note).toBe("Discount after the bill was final: 10% — Camp");
    expect(row.requested_by).toMatchObject({ id: USERS.reception.id });

    const note = await credits.readCreditNote(back.credit_note_id, db);
    await payments.payOut(
      back.credit_note_id,
      { version: note.version, mode: "cash", amount: 130 },
      desk,
      db,
    );
    listed = await board.refundBoard({ q: tag }, db);
    expect(find(listed.groups, back.credit_note_id)).toMatchObject({
      group: "paid",
      amounts: { paid_back: 13000, to_pay: 0 },
    });
  });
});
