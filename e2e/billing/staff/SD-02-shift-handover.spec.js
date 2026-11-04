import { test, expect } from "@playwright/test";
import { one } from "../../helpers/db.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { desk, newTag, setUp, tearDown } from "../phase4/p4-bills-fixture.mjs";
import {
  admin,
  db,
  draftWith,
  dropShifts,
  openDeskShift,
  prepareCategory,
} from "../phase4b/p4b-refunds.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const payments = await import("../../../server/services/billing/payments.js");
const shifts = await import("../../../server/services/billing/cashShifts.js");
const staffBoard = await import("../../../server/services/billing/staffDashboard.js");

const tag = newTag();
const recAdmin = { actorId: USERS.reception_admin.id, ip: "10.9.40.8", role: "reception_admin" };
let ids;

async function cashOn(label) {
  const { bill } = await draftWith(ids, label, [{ item: ids.brace }]);
  await payments.takePayments(
    bill.id,
    { version: bill.version, payments: [{ mode: "cash", amount: bill.totals.payable / 100 }] },
    desk,
    db,
  );
  return bill.totals.payable;
}

test.describe.serial("SD-02 shift handover record", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    await prepareCategory(ids);
  });

  test.afterAll(async () => {
    await tearDown(ids);
    await dropShifts();
  });

  test("1. a note count that doesn't add up to the counted cash is refused", async () => {
    const shift = await openDeskShift(0);
    const taken = await cashOn("HoMismatch");
    await expect(
      shifts.closeShift(
        shift.id,
        { counted_cash: taken / 100 + 10, denominations: { 500: 1 } },
        desk,
        db,
      ),
    ).rejects.toMatchObject({ status: 400 });
    const still = await shifts.getShift(shift.id, db);
    expect(still.is_open).toBe(true);
  });

  test("2. closing saves the handover as it was, with the note count", async () => {
    const live = await shifts.currentShift(desk, db);
    const expected = Math.round(live.expected_cash * 100);
    const notes = Math.floor(expected / 50000);
    const coins = (expected - notes * 50000) / 100;
    const closed = await shifts.closeShift(
      live.id,
      { denominations: { 500: notes, coins } },
      desk,
      db,
    );
    expect(closed.not_counted).toBe(false);
    expect(closed.difference).toBe(0);
    expect(closed.denominations).toMatchObject({ total: expected });
    expect(closed.handover).toMatchObject({
      unit: "paise",
      expected_cash: expected,
      counted_cash: expected,
      difference: 0,
      not_counted: false,
      closed_by_owner: true,
    });
    expect(closed.handover.collected.cash).toBe(expected);
    expect(closed.handover.payment_count).toBe(live.payment_count);
    expect(closed.handover.patients).toBeGreaterThanOrEqual(1);
    const audit = await one(
      `SELECT after FROM billing_audit WHERE entity = 'cash_shifts' AND entity_id = $1
        ORDER BY id DESC LIMIT 1`,
      [live.id],
    );
    expect(audit.after.handover.expected_cash).toBe(expected);
  });

  test("3. only an admin can close without counting, and then no difference is recorded", async () => {
    const shift = await openDeskShift(500);
    await cashOn("HoNotCounted");
    await expect(
      shifts.closeShift(shift.id, { not_counted: true }, desk, db),
    ).rejects.toMatchObject({ status: 403 });
    const closed = await shifts.closeShift(
      shift.id,
      { not_counted: true, note: "Left open, counted next morning" },
      recAdmin,
      db,
    );
    expect(closed).toMatchObject({ not_counted: true, counted_cash: null, difference: null });
    expect(closed.handover).toMatchObject({ not_counted: true, closed_by_owner: false });
    const board = await staffBoard.staffDashboard(
      { from: ids.day, to: ids.day, staff: USERS.reception.id },
      db,
      { today: ids.day },
    );
    const listed = board.shifts.find((row) => row.id === shift.id);
    expect(listed.counted_cash).toBe(null);
    expect(board.handover.not_counted).toBeGreaterThanOrEqual(1);
  });

  test("4. a mode correction after close changes the live drawer but not the handover", async () => {
    const shift = await openDeskShift(0);
    const taken = await cashOn("HoCorrect");
    const live = await shifts.getShift(shift.id, db);
    const closed = await shifts.closeShift(
      shift.id,
      { counted_cash: live.expected_cash },
      desk,
      db,
    );
    const paid = await one(
      `SELECT id FROM payments WHERE shift_id = $1 AND mode = 'cash' ORDER BY received_at DESC LIMIT 1`,
      [shift.id],
    );
    const correction = await import("../../../server/services/billing/paymentCorrection.js");
    await correction.correctPaymentMode(
      paid.id,
      { mode: "upi", upi_app: "paytm", reference: `CORR-${tag}`, reason: "Was UPI" },
      admin,
      db,
    );
    const after = await shifts.getShift(shift.id, db);
    expect(after.expected_cash).toBe(live.expected_cash - taken / 100);
    expect(after.handover.expected_cash).toBe(closed.handover.expected_cash);
    const detail = await staffBoard.staffShiftDetail(shift.id, db, { today: ids.day });
    expect(detail.changes).toHaveLength(1);
    expect(detail.changes[0].after.mode).toBe("upi");
  });

  test("5. a desk can read its own handover; another desk can't without reports", async () => {
    const mine = await one(
      `SELECT id FROM cash_shifts WHERE user_id = $1 AND closed_at IS NOT NULL
        ORDER BY closed_at DESC LIMIT 1`,
      [USERS.reception.id],
    );
    const own = await staffBoard.shiftHandover(mine.id, desk, db);
    expect(own.shift.id).toBe(mine.id);
    const other = { actorId: USERS.coordinator.id, role: "coordinator" };
    await expect(staffBoard.shiftHandover(mine.id, other, db)).rejects.toMatchObject({
      status: 403,
    });
    const boss = await staffBoard.shiftHandover(mine.id, recAdmin, db);
    expect(boss.shift.id).toBe(mine.id);
  });
});
