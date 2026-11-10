import { test, expect } from "@playwright/test";
import { tokensFor } from "../../helpers/auth.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { API_URL } from "../../setup/testEnv.mjs";
import { desk, newTag, setUp, tearDown } from "../phase4/p4-bills-fixture.mjs";
import {
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
const dashboard = await import("../../../server/services/billing/dashboard.js");
const bills = await import("../../../server/services/billing/bills.js");

const tag = newTag();
const ME = USERS.reception.id;
let ids;
let shift;
let before;
const made = {};

const board = (extra = {}) =>
  staffBoard.staffDashboard({ from: ids.day, to: ids.day, ...extra }, db, { today: ids.day });
const rowOf = (data, id = ME) => data.staff.find((person) => person.id === id);

async function payDraft(label, pay) {
  const { bill } = await draftWith(ids, label, [{ item: ids.brace }]);
  const amount = bill.totals.payable / 100;
  await payments.takePayments(bill.id, { version: bill.version, payments: pay(amount) }, desk, db);
  return { bill, amount: bill.totals.payable };
}

const get = async (path, role) =>
  fetch(`${API_URL}/api${path}`, {
    headers: { authorization: `Bearer ${(await tokensFor(role)).access}` },
  });

test.describe.serial("SD-01 staff dashboard service", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    await prepareCategory(ids);
    shift = await openDeskShift(1000);
    before = await board({ staff: ME });
    made.cash = await payDraft("SdCash", (amount) => [{ mode: "cash", amount }]);
    made.card = await payDraft("SdCard", (amount) => [
      { mode: "card", amount, reference: `CARD-${tag}` },
    ]);
    made.upi = await payDraft("SdUpi", (amount) => [
      { mode: "upi", amount, reference: `UPI-${tag}`, upi_app: "bharatpe" },
    ]);
  });

  test.afterAll(async () => {
    await tearDown(ids);
    await dropShifts();
  });

  test("1. a person's money moves by exactly what they took, mode by mode", async () => {
    const after = await board({ staff: ME });
    const was = rowOf(before) ?? {
      money: { cash: 0, card: 0, upi_bharatpe: 0 },
      payments: 0,
      collected: 0,
    };
    const now = rowOf(after);
    expect(now.name).toBe(USERS.reception.name);
    expect(now.money.cash - was.money.cash).toBe(made.cash.amount);
    expect(now.money.card - was.money.card).toBe(made.card.amount);
    expect(now.money.upi_bharatpe - was.money.upi_bharatpe).toBe(made.upi.amount);
    expect(now.payments - was.payments).toBe(3);
    expect(now.collected - was.collected).toBe(
      made.cash.amount + made.card.amount + made.upi.amount,
    );
    expect(after.columns.money.map((col) => col.key)).toEqual(
      expect.arrayContaining(["cash", "card", "upi_bharatpe"]),
    );
  });

  test("2. the staff total equals the billing dashboard's Collected for the same day", async () => {
    dashboard.clearDashboardCache();
    const all = await board();
    const main = await dashboard.billingDashboard({ from: ids.day, to: ids.day }, db, {
      today: ids.day,
    });
    expect(all.total.collected).toBe(main.total.collected);
    const summed = all.staff.reduce((sum, person) => sum + person.collected, 0);
    expect(summed).toBe(all.total.collected);
    for (const person of all.staff) {
      const byMode = Object.values(person.money).reduce((sum, value) => sum + value, 0);
      expect(byMode).toBe(person.collected);
    }
  });

  test("3. the open shift is listed with the drawer the shift screen shows", async () => {
    const data = await board({ staff: ME });
    const listed = data.shifts.find((row) => row.id === shift.id);
    const live = await shifts.getShift(shift.id, db);
    expect(listed.is_open).toBe(true);
    expect(listed.left_open).toBe(false);
    expect(listed.expected_cash).toBe(Math.round(live.expected_cash * 100));
    expect(listed.expected_cash).toBe(100000 + made.cash.amount);
    expect(data.handover.open_cash).toBeGreaterThanOrEqual(listed.expected_cash);
  });

  test("4. one shift's payments add up to its totals by mode", async () => {
    const detail = await staffBoard.staffShiftDetail(shift.id, db, { today: ids.day });
    const inShift = detail.payments.filter((row) => !row.voided_at && !row.outside_shift);
    const sumOf = (mode) =>
      inShift
        .filter((row) => row.mode === mode)
        .reduce((sum, row) => sum + (row.direction === "in" ? row.amount : -row.amount), 0);
    expect(sumOf("cash")).toBe(detail.shift.collected.cash - detail.shift.refunded.cash);
    expect(sumOf("card")).toBe(detail.shift.collected.card - detail.shift.refunded.card);
    expect(sumOf("upi")).toBe(detail.shift.collected.upi - detail.shift.refunded.upi);
    const ours = detail.payments.find((row) => row.bill_id === made.upi.bill.id);
    expect(ours).toMatchObject({ mode: "upi", upi_app: "bharatpe", reference: `UPI-${tag}` });
    expect(ours.patient_name).toContain("SdUpi");
  });

  test("5. a short close shows as short, and the handover counts what was counted", async () => {
    const live = await shifts.getShift(shift.id, db);
    await shifts.closeShift(shift.id, { counted_cash: live.expected_cash - 50 }, desk, db);
    const data = await board({ staff: ME });
    const closed = data.shifts.find((row) => row.id === shift.id);
    expect(closed.is_open).toBe(false);
    expect(closed.difference).toBe(-5000);
    expect(data.handover.short.count).toBeGreaterThanOrEqual(1);
    expect(data.handover.short.amount).toBeLessThanOrEqual(-5000);
    expect(rowOf(data).short).toBeLessThanOrEqual(-5000);
    expect(data.exceptions.differences.map((row) => row.id)).toContain(shift.id);
  });

  test("6. only billing reports can read it; bad input is refused", async () => {
    expect((await get(`/billing/staff?from=${ids.day}&to=${ids.day}`, "reception")).status).toBe(
      403,
    );
    const ok = await get(
      `/billing/staff?from=${ids.day}&to=${ids.day}&staff=${ME}`,
      "reception_admin",
    );
    expect(ok.status).toBe(200);
    expect(rowOf(await ok.json())).toBeTruthy();
    expect((await get(`/billing/staff/shifts/${shift.id}`, "reception")).status).toBe(403);
    expect((await get(`/billing/staff/shifts/${shift.id}`, "reception_admin")).status).toBe(200);
    expect((await get(`/billing/staff/shifts/not-a-shift`, "reception_admin")).status).toBe(400);
    expect((await get(`/billing/staff?staff=abc`, "reception_admin")).status).toBe(400);
    await expect(
      staffBoard.staffDashboard({ from: ids.day, to: "2999-01-01" }, db, { today: ids.day }),
    ).rejects.toMatchObject({ status: 400 });
  });

  test("7. a bill made final by a test cancel is counted as closed by test cancel", async () => {
    const LAB = USERS.lab.id;
    const { bill } = await payDraft("SdCancel", (amount) => [
      { mode: "card", amount, reference: `CANCEL-${tag}` },
    ]);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(`SELECT version FROM bills WHERE id = $1`, [bill.id]);
      await bills.finaliseBill(
        bill.id,
        { version: rows[0].version },
        { role: "lab", actorId: LAB },
        client,
      );
      const { rows: lines } = await client.query(
        `SELECT id FROM bill_lines WHERE bill_id = $1 AND is_live ORDER BY line_no LIMIT 1`,
        [bill.id],
      );
      await client.query(
        `INSERT INTO billing_requests (kind, reason, bill_id, created_by, refund_lines, requested_mode)
         VALUES ('refund', 'Cancelled at the lab station by E2E Lab', $1, $2, $3::jsonb, 'as_paid')`,
        [bill.id, LAB, JSON.stringify([{ line_id: lines[0].id, quantity: 1 }])],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    const lab = rowOf(await board({ staff: LAB }), LAB);
    expect(lab).toMatchObject({ finalised: 0, closed_by_cancel: 1 });
    const all = await board();
    expect(all.total.closed_by_cancel).toBeGreaterThanOrEqual(1);
    expect(rowOf(all)).toMatchObject({ closed_by_cancel: 0 });
  });
});
