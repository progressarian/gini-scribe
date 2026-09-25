import { test, expect } from "@playwright/test";
import { one } from "../../helpers/db.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { desk, newTag, setUp, tearDown } from "../phase4/p4-bills-fixture.mjs";
import {
  db,
  dropShifts,
  finalBill,
  inCash,
  openDeskShift,
  prepareCategory,
  refundApproved,
} from "./p4b-refunds.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const payments = await import("../../../server/services/billing/payments.js");
const shifts = await import("../../../server/services/billing/cashShifts.js");

const tag = newTag();
let ids;

test.describe.serial("P4B-06 cash shift includes cash out", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    await prepareCategory(ids);
  });

  test.afterAll(async () => {
    await tearDown(ids);
    await dropShifts();
  });

  test("1. expected cash is opening + cash in − cash out, and the shift shows its refunds", async () => {
    const opened = await openDeskShift(1000.5);
    const { bill: cashBill } = await finalBill(ids, "CashIn", [{ item: ids.brace }], {
      pay: inCash,
    });
    const { bill: cardBill } = await finalBill(ids, "CardIn", [{ item: ids.dressing }], {
      pay: () => [{ mode: "card", amount: 500, reference: `IN-${tag}` }],
    });
    const cashNote = (await refundApproved(cashBill.id, "whole")).credit_note;
    await payments.payOut(
      cashNote.id,
      { version: cashNote.version, payments: [{ mode: "cash", amount: 200.25 }] },
      desk,
      db,
    );
    const cardNote = (await refundApproved(cardBill.id, "whole")).credit_note;
    await payments.payOut(
      cardNote.id,
      {
        version: cardNote.version,
        payments: [{ mode: "card", amount: 500, reference: `REV-${tag}` }],
      },
      desk,
      db,
    );

    const shift = await shifts.currentShift(desk, db);
    expect(shift.id).toBe(opened.id);
    expect(shift.collected).toEqual({ cash: 800, card: 500, upi: 0, total: 1300 });
    expect(shift.refunded).toEqual({ cash: 200.25, card: 500, upi: 0, total: 700.25 });
    expect(shift.payment_count).toBe(2);
    expect(shift.refund_count).toBe(2);
    expect(shift.credit_note_count).toBe(2);
    expect(shift.expected_cash).toBe(1600.25);

    const closed = await shifts.closeShift(shift.id, { counted_cash: 1600.25 }, desk, db);
    expect(closed.expected_cash).toBe(1600.25);
    expect(closed.difference).toBe(0);
    expect(closed.refunded.cash).toBe(200.25);
    const stored = await one(
      `SELECT expected_cash, counted_cash, difference FROM cash_shifts WHERE id = $1`,
      [shift.id],
    );
    expect(stored).toEqual({
      expected_cash: "1600.25",
      counted_cash: "1600.25",
      difference: "0.00",
    });
  });

  test("2. the drawer sums match the payment rows exactly", async () => {
    const opened = await openDeskShift(0);
    const { bill } = await finalBill(ids, "Exact", [{ item: ids.brace }], { pay: inCash });
    const note = (await refundApproved(bill.id, "whole")).credit_note;
    for (const amount of [0.1, 0.2, 99.7]) {
      const plan = await payments.refundPlan(note.id, db);
      await payments.payOut(
        note.id,
        { version: plan.version, payments: [{ mode: "cash", amount }] },
        desk,
        db,
      );
    }
    const sums = await one(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE direction = 'in' AND mode = 'cash'), 0)
              - COALESCE(SUM(amount) FILTER (WHERE direction = 'out' AND mode = 'cash'), 0)
              AS net
         FROM payments WHERE shift_id = $1`,
      [opened.id],
    );
    const shift = await shifts.getShift(opened.id, db);
    expect(shift.refunded.cash).toBe(100);
    expect(shift.expected_cash).toBe(Number(sums.net));
    expect(shift.expected_cash).toBe(700);
  });
});
