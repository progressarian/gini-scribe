import { test, expect } from "@playwright/test";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { desk, newTag, refused, setUp, tearDown } from "../phase4/p4-bills-fixture.mjs";
import {
  billRow,
  db,
  draftWith,
  dropShifts,
  finalBill,
  inCash,
  lineFor,
  openDeskShift,
  payOn,
  prepareCategory,
  refundApproved,
} from "./p4b-refunds.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");
const payments = await import("../../../server/services/billing/payments.js");

const tag = newTag();
let ids;

const card = (amount, reference = `REV-${tag}-${amount}`) => ({ mode: "card", amount, reference });
const cash = (amount) => ({ mode: "cash", amount });

const payOut = (note, pay, version = note.version) =>
  payments.payOut(note.id, { version, payments: pay }, desk, db);

async function paidTwice(label) {
  const { bill: draft } = await draftWith(ids, label, [
    { item: ids.dressing },
    { item: ids.brace },
  ]);
  await payOn(draft.id, [card(800)]);
  const taken = await payOn(draft.id, [cash(500)]);
  return bills.finaliseBill(draft.id, { version: taken.version }, desk, db);
}

test.describe.serial("P4B-05 pay out", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    await prepareCategory(ids);
    await openDeskShift(5000);
  });

  test.afterAll(async () => {
    await tearDown(ids);
    await dropShifts();
  });

  test("1. back the way it came, newest payment first, with the card reversal's reference", async () => {
    const bill = await paidTwice("AsPaid");
    const approved = await refundApproved(bill.id, [{ line_id: lineFor(bill, ids.brace).id }]);
    const note = approved.credit_note;
    expect(note.refund.due).toBe(80000);
    expect(note.refund.legs).toEqual([
      { mode: "cash", amount: 50000 },
      { mode: "card", amount: 30000 },
    ]);
    const plan = await payments.refundPlan(note.id, db);
    expect(plan).toMatchObject({ mode: "as_paid", due: 80000, refunded: 0 });

    await refused(
      payOut(note, [card(400)]),
      409,
      /at most ₹300.00 .* by card/,
      "card past its share",
    );
    await refused(
      payOut(note, [{ mode: "card", amount: 300 }]),
      400,
      /reversal's reference/,
      "a card refund with no reference",
    );
    await refused(payOut(note, [cash(500)], note.version + 7), 409, /changed while/, "stale");
    await refused(
      payOut(note, [cash(500), card(301)]),
      409,
      /₹800.00 is due back .* so ₹801.00 can't be paid out/,
      "more than is due",
    );

    const done = await payOut(note, [cash(500), card(300)]);
    expect(done.totals).toEqual({ credited: 80000, refunded: 80000, due: 0 });
    expect(done.payments.map((p) => [p.direction, p.mode, p.amount])).toEqual([
      ["out", "cash", 50000],
      ["out", "card", 30000],
    ]);
    const listed = await payments.listPayments(note.id, db);
    expect(listed.every((p) => p.direction === "out" && p.receipt_no === null)).toBe(true);
    expect((await payments.listPayments(bill.id, db)).every((p) => p.direction === "in")).toBe(
      true,
    );
    expect(Number((await billRow(bill.id)).paid_amount)).toBe(1300);
    expect(Number((await billRow(note.id)).paid_amount)).toBe(800);
    await refused(payOut(note, [cash(1)], done.version), 409, /paid back in full/, "twice");
    await refused(
      payments.takePayments(note.id, { version: done.version, ...cash(1) }, desk, db),
      409,
      /never on a credit note/,
      "taking money on a credit note",
    );
  });

  test("2. an admin's other mode is the only way the money goes back", async () => {
    const { bill } = await finalBill(ids, "Mode", [{ item: ids.brace }], {
      pay: () => [card(800)],
    });
    const approved = await refundApproved(bill.id, "whole", {
      decide: { approved_mode: "cash", mode_reason: "The card can't be reversed" },
    });
    const note = approved.credit_note;
    expect(note.refund.legs).toEqual([{ mode: "cash", amount: 80000 }]);
    await refused(
      payOut(note, [card(800)]),
      409,
      /approved paying this back by cash, so it can't go back by card/,
      "the wrong mode",
    );
    const done = await payOut(note, [cash(800)]);
    expect(done.totals.due).toBe(0);
  });

  test("3. cash goes back only from an open shift's drawer that holds it", async () => {
    await dropShifts();
    const { bill } = await finalBill(ids, "Drawer", [{ item: ids.dressing }], {
      pay: () => [card(500)],
    });
    const approved = await refundApproved(bill.id, "whole", {
      decide: { approved_mode: "cash", mode_reason: "Patient wants cash" },
    });
    const note = approved.credit_note;
    await refused(payOut(note, [cash(100)]), 409, /Open your shift first/, "no shift");
    await openDeskShift(0);
    await refused(payOut(note, [cash(100)]), 409, /Your drawer holds ₹0.00/, "an empty drawer");
    await finalBill(ids, "Fill", [{ item: ids.brace }], { pay: inCash });
    const part = await payOut(note, [cash(300)]);
    expect(part.totals).toMatchObject({ refunded: 30000, due: 20000 });
    expect(part.payments[0].shift_id).toBeTruthy();
  });

  test("4. on a pay-later bill a credit reduces the balance first; only money paid comes back", async () => {
    const { bill: first } = await finalBill(
      ids,
      "LaterA",
      [{ item: ids.dressing }, { item: ids.brace }],
      { payLater: true },
    );
    await payOn(first.id, [cash(500)]);
    const none = (await refundApproved(first.id, [{ line_id: lineFor(first, ids.brace).id }]))
      .credit_note;
    expect(none.refund.due).toBe(0);
    await refused(
      payOut(none, [cash(1)]),
      409,
      /credit went against what was still owed/,
      "refunding money owed",
    );
    const firstDues = await payments.listDues({ patientId: first.patient_id }, db);
    expect(firstDues).toEqual([]);
    const settled = await bills.readBill(first.id, db);
    await refused(
      payments.takePayments(first.id, { version: settled.version, ...cash(1) }, desk, db),
      409,
      /Nothing is left to collect/,
      "collecting after the credit settled it",
    );

    const { bill: second } = await finalBill(
      ids,
      "LaterB",
      [{ item: ids.dressing }, { item: ids.brace }],
      { payLater: true },
    );
    await payOn(second.id, [cash(1000)]);
    const some = (await refundApproved(second.id, [{ line_id: lineFor(second, ids.brace).id }]))
      .credit_note;
    expect(some.refund.due).toBe(50000);
    expect((await payOut(some, [cash(500)])).totals.due).toBe(0);

    const { bill: third } = await finalBill(
      ids,
      "LaterC",
      [{ item: ids.dressing }, { item: ids.brace }],
      { payLater: true },
    );
    await payOn(third.id, [cash(300)]);
    await refundApproved(third.id, [{ line_id: lineFor(third, ids.dressing).id }]);
    const [due] = await payments.listDues({ patientId: third.patient_id }, db);
    expect(due).toMatchObject({ credited: 50000, refunded: 0, outstanding: 50000 });
    const taken = await payOn(third.id, [cash(500)]);
    expect(taken.totals.outstanding).toBe(0);
    expect(await payments.listDues({ patientId: third.patient_id }, db)).toEqual([]);
  });
});
