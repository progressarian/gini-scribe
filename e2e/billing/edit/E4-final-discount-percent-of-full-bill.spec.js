import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../../helpers/db.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { desk, extraVisit, newTag, refused, setUp, tearDown } from "../phase4/p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");
const credits = await import("../../../server/services/billing/creditNotes.js");
const shifts = await import("../../../server/services/billing/cashShifts.js");

const db = getPool();
const tag = newTag();
let ids;
let bill;

test.describe.serial("E4 a % discount on a final bill is a share of the full bill", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    const draft = await bills.openDraft(ids.visit, desk, db);
    for (const line of draft.lines) await bills.removeLine(draft.id, line.id, {}, desk, db);
    await bills.addLine(draft.id, { item_id: ids.brace }, desk, db);
    await bills.addLine(draft.id, { item_id: ids.dressing, quantity: 3 }, desk, db);
    const discounted = await bills.setBillDiscount(
      draft.id,
      { kind: "percent", value: 10, reason: "At billing" },
      desk,
      db,
    );
    expect(discounted.totals.payable).toBe(207000);
    await bills.clearHealthrayAndFinalise(
      draft.id,
      { version: discounted.version, paid: { mode: "cash" } },
      desk,
      db,
    );
    bill = await bills.readBill(draft.id, db);
  });

  test.afterAll(async () => {
    await tearDown(ids);
    await query(`DELETE FROM cash_shifts WHERE user_id = $1`, [USERS.reception.id]).catch(() => {});
  });

  test("1. 20% on a bill that already had 10% gives only the other 10% of the full amount", async () => {
    const preview = await credits.previewFinalDiscount(bill.id, { kind: "percent", value: 20 }, db);
    expect(preview).toMatchObject({ gross: 230000, already_given: 23000, amount: 23000 });
    expect(preview.pay_back).toBe(23000);
    const made = await credits.discountFinalBill(
      bill.id,
      { kind: "percent", value: 20, reason: "Make it 20%" },
      desk,
      db,
    );
    expect(made.amount).toBe(23000);
  });

  test("2. asking for 20% again gives nothing more, and 25% gives only the next 5%", async () => {
    await refused(
      credits.previewFinalDiscount(bill.id, { kind: "percent", value: 20 }, db),
      409,
      /already has ₹460\.00 off its ₹2300\.00/,
      "a second 20%",
    );
    const preview = await credits.previewFinalDiscount(bill.id, { kind: "percent", value: 25 }, db);
    expect(preview).toMatchObject({ already_given: 46000, amount: 11500 });
  });

  test("3. a flat discount still comes on top of what was given", async () => {
    const preview = await credits.previewFinalDiscount(bill.id, { kind: "flat", value: 50 }, db);
    expect(preview.amount).toBe(5000);
  });

  async function paidBill(label) {
    const visit = await extraVisit(ids, label);
    const draft = await bills.openDraft(visit.visit, desk, db);
    for (const line of draft.lines) await bills.removeLine(draft.id, line.id, {}, desk, db);
    await bills.addLine(draft.id, { item_id: ids.brace }, desk, db);
    await bills.addLine(draft.id, { item_id: ids.dressing, quantity: 3 }, desk, db);
    const discounted = await bills.setBillDiscount(
      draft.id,
      { kind: "percent", value: 10 },
      desk,
      db,
    );
    await bills.clearHealthrayAndFinalise(
      draft.id,
      { version: discounted.version, paid: { mode: "upi", upi_app: "icici" } },
      desk,
      db,
    );
    return { ...visit, bill: await bills.readBill(draft.id, db) };
  }

  const paymentsOf = (billId) =>
    query(
      `SELECT direction, mode, amount::float AS amount FROM payments WHERE bill_id = $1
        ORDER BY received_at`,
      [billId],
    ).then((r) => r.rows);

  test("4. paid by UPI, the extra can be refunded in cash now; the UPI payment is untouched", async () => {
    await query(`DELETE FROM cash_shifts WHERE user_id = $1`, [USERS.reception.id]);
    await shifts.openShift({ opening_cash: 1000 }, desk, db);
    const { bill: paid } = await paidBill("Cash");
    const made = await credits.discountFinalBill(
      paid.id,
      { kind: "percent", value: 20, reason: "20% of the full bill", payback: "cash" },
      desk,
      db,
    );
    expect(made).toMatchObject({ amount: 23000, paid_in_cash: 23000, payback: "cash" });
    expect(await paymentsOf(paid.id)).toEqual([
      { direction: "in", mode: "healthray", amount: 2070 },
    ]);
    expect(await paymentsOf(made.credit_note_id)).toEqual([
      { direction: "out", mode: "cash", amount: 230 },
    ]);
    const after = await bills.readBill(paid.id, db);
    expect(after.credits).toMatchObject({ credited: 23000, balance: 0, to_pay_back: 0 });
  });

  test("5. or the extra can be kept in the patient's deposit", async () => {
    const { bill: paid, patient } = await paidBill("Dep");
    const made = await credits.discountFinalBill(
      paid.id,
      { kind: "percent", value: 20, payback: "deposit" },
      desk,
      db,
    );
    expect(made).toMatchObject({ amount: 23000, kept_as_deposit: 23000 });
    const account = await one(
      `SELECT balance::float AS balance FROM deposit_accounts WHERE patient_id = $1`,
      [patient],
    );
    expect(account.balance).toBe(230);
  });

  test("6. a cash refund needs an open shift with enough cash", async () => {
    await query(
      `UPDATE cash_shifts SET closed_at = NOW(), expected_cash = opening_cash,
                   counted_cash = opening_cash, difference = 0
                 WHERE user_id = $1 AND closed_at IS NULL`,
      [USERS.reception.id],
    );
    const { bill: paid } = await paidBill("NoShift");
    await refused(
      credits.discountFinalBill(paid.id, { kind: "percent", value: 20, payback: "cash" }, desk, db),
      409,
      /Open your shift first/,
      "cash refund without a shift",
    );
  });
});
