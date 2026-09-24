import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../../helpers/db.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import {
  desk,
  extraVisit,
  failure,
  newTag,
  payRule,
  refused,
  setUp,
  tearDown,
} from "./p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");
const payments = await import("../../../server/services/billing/payments.js");
const shifts = await import("../../../server/services/billing/cashShifts.js");
const visitLines = await import("../../../server/services/billing/visitLines.js");
const reception = await import("../../../server/services/giniflow/receptionStation.js");
const settings = await import("../../../server/services/billing/billingSettings.js");
const billSeries = await import("../../../server/services/billing/billSeries.js");

const db = getPool();
const tag = newTag();
const admin = { actorId: USERS.admin.id, ip: "10.9.5.9", role: USERS.admin.role };
let ids;
let payLaterWas = null;

const receiptNo = (row) => Number(row.receipt_no.slice(ids.receiptPrefix.length));

const closeOpenShifts = () =>
  query(
    `UPDATE cash_shifts
        SET closed_at = NOW(), expected_cash = opening_cash, counted_cash = opening_cash,
            difference = 0
      WHERE closed_at IS NULL AND user_id = ANY($1::int[])`,
    [[USERS.reception.id, USERS.coordinator.id, USERS.admin.id]],
  );

const pricedOrder = async (visit, tests, kind = "lab") => {
  const total = tests.reduce((sum, test) => sum + test.price, 0);
  const order = await one(
    `INSERT INTO giniflow_lab_orders (visit_id, urgency, payment_status, amount_total,
                                      sample_status, kind)
     VALUES ($1, 'today', 'pending', $2, 'payment_pending', $3) RETURNING id`,
    [visit, total, kind],
  );
  for (const test of tests) {
    await query(
      `INSERT INTO giniflow_lab_order_tests (lab_order_id, test_name, price) VALUES ($1, $2, $3)`,
      [order.id, test.name, test.price],
    );
  }
  return order.id;
};

const orderRow = (id) =>
  one(
    `SELECT payment_status, sample_status, amount_paid, amount_claimed, claim_state, version
       FROM giniflow_lab_orders WHERE id = $1`,
    [id],
  );

test.describe.serial("P4-15 take payments", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    await payRule(ids, ids.pensioner, { name: "pensioner pays", patient_pays: "full" });
    payLaterWas = (await settings.getSettings(db)).allow_pay_later;
    await settings.updateSettings({ allow_pay_later: true }, admin, db);
    await closeOpenShifts();
  });

  test.afterAll(async () => {
    await tearDown(ids);
    await closeOpenShifts();
    await query(`DELETE FROM cash_shifts WHERE user_id = ANY($1::int[])`, [
      [USERS.reception.id, USERS.coordinator.id],
    ]).catch(() => {});
    if (payLaterWas !== null) {
      await settings.updateSettings({ allow_pay_later: payLaterWas }, admin, db);
    }
  });

  test("1. a whole visit: check in, two tests, finalise, a card and a cash payment", async () => {
    await reception.markArrived(ids.visit, USERS.reception.id, db);
    ids.labOrder = await pricedOrder(ids.visit, [{ name: ids.hba1cName, price: 250 }]);
    ids.machineOrder = await pricedOrder(ids.visit, [{ name: ids.abiName, price: 400 }], "machine");
    await visitLines.linesForOrder(
      ids.visit,
      { labOrderId: ids.labOrder, testNames: [ids.hba1cName] },
      desk,
      db,
    );
    await visitLines.linesForOrder(
      ids.visit,
      { labOrderId: ids.machineOrder, testNames: [ids.abiName] },
      desk,
      db,
    );
    const draft = await one(`SELECT id FROM bills WHERE visit_id = $1 AND status = 'draft'`, [
      ids.visit,
    ]);
    ids.bill = draft.id;
    const ready = await bills.setCategory(ids.bill, { category: ids.pensioner }, desk, db);
    expect(ready.lines).toHaveLength(3);
    expect(ready.totals.payable).toBe(265000);

    const final = await bills.finaliseBill(
      ids.bill,
      { version: ready.version, pay_later: true },
      desk,
      db,
    );
    expect(final.status).toBe("final");
    expect((await orderRow(ids.labOrder)).payment_status).toBe("pending");

    const shift = await shifts.openShift({ opening_cash: 500 }, desk, db);
    ids.shift = shift.id;
    const taken = await payments.takePayments(
      ids.bill,
      {
        version: final.version,
        payments: [
          { mode: "card", amount: 1000, reference: `CARD-${tag}` },
          { mode: "cash", amount: 1650 },
        ],
      },
      desk,
      db,
    );
    expect(taken.payments).toHaveLength(2);
    expect(taken.totals).toMatchObject({ payable: 265000, paid: 265000, outstanding: 0 });
    expect(receiptNo(taken.payments[1])).toBe(receiptNo(taken.payments[0]) + 1);
    expect(taken.payments[0].mode).toBe("card");
    expect(taken.payments[1].shift_id).toBe(ids.shift);

    const lab = await orderRow(ids.labOrder);
    expect(lab.payment_status).toBe("paid");
    expect(lab.sample_status).toBe("paid");
    expect(Number(lab.amount_paid)).toBe(250);
    expect((await orderRow(ids.machineOrder)).payment_status).toBe("paid");

    const after = await shifts.getShift(ids.shift, db);
    expect(after.collected).toMatchObject({ cash: 1650, card: 1000, upi: 0, total: 2650 });
    expect(after.expected_cash).toBe(2150);

    const stored = await one(`SELECT paid_amount, patient_payable FROM bills WHERE id = $1`, [
      ids.bill,
    ]);
    expect(Number(stored.paid_amount)).toBe(2650);
    expect(Number(stored.patient_payable)).toBe(2650);
  });

  test("2. nothing more can be taken on a bill that is settled", async () => {
    const bill = await bills.readBill(ids.bill, db);
    await refused(
      payments.takePayments(ids.bill, { version: bill.version, mode: "cash", amount: 1 }, desk, db),
      409,
      /Nothing is left to collect on bill /,
      "paying a settled bill",
    );
  });

  test("3. overpaying is refused, naming what is left", async () => {
    const { visit } = await extraVisit(ids, "Over");
    const draft = await bills.openDraft(visit, desk, db);
    await bills.addLine(draft.id, { item_id: ids.dressing }, desk, db);
    const ready = await bills.setCategory(draft.id, { category: ids.pensioner }, desk, db);
    expect(ready.totals.payable).toBe(50000);
    await refused(
      payments.takePayments(
        draft.id,
        { version: ready.version, mode: "cash", amount: 500.01 },
        desk,
        db,
      ),
      409,
      /₹500.00 is left to collect on this visit's draft bill, so ₹500.01 can't be taken/,
      "one payment over the payable",
    );
    await refused(
      payments.takePayments(
        draft.id,
        {
          version: ready.version,
          payments: [
            { mode: "cash", amount: 300 },
            { mode: "upi", amount: 300, reference: `UPI-${tag}` },
          ],
        },
        desk,
        db,
      ),
      409,
      /₹500.00 is left to collect/,
      "two payments that together overpay",
    );
    const { count } = await one(`SELECT COUNT(*)::int AS count FROM payments WHERE bill_id = $1`, [
      draft.id,
    ]);
    expect(count).toBe(0);
    const part = await payments.takePayments(
      draft.id,
      { version: ready.version, mode: "cash", amount: 200 },
      desk,
      db,
    );
    expect(part.totals.outstanding).toBe(30000);
    await refused(
      payments.takePayments(
        draft.id,
        { version: part.version, mode: "cash", amount: 300.5 },
        desk,
        db,
      ),
      409,
      /₹300.00 is left to collect/,
      "overpaying what is left after a part payment",
    );
    ids.overBill = draft.id;
    ids.overVersion = part.version;
  });

  test("4. card and UPI need a reference; the mode and the amount are checked", async () => {
    const version = ids.overVersion;
    const bad = async (input, message, label) =>
      refused(
        payments.takePayments(ids.overBill, { version, ...input }, desk, db),
        400,
        message,
        label,
      );
    await bad(
      { mode: "card", amount: 10 },
      /card payment needs its reference/,
      "a card with no reference",
    );
    await bad(
      { mode: "upi", amount: 10, reference: "   " },
      /UPI payment needs its reference/,
      "UPI with a blank reference",
    );
    await bad({ mode: "cheque", amount: 10 }, /cash, card, upi/, "an unknown mode");
    await bad({ mode: "cash", amount: 0 }, /more than zero/, "nothing at all");
    await bad({ mode: "cash", amount: -5 }, /can't be negative/, "a negative amount");
    await bad({ mode: "cash", amount: 1.234 }, /2 decimals/, "a fraction of a paisa");
    await bad({}, /taken as one of/, "no payment at all");
    await refused(
      payments.takePayments(ids.overBill, { mode: "cash", amount: 10 }, desk, db),
      400,
      /version/,
      "no version",
    );
  });

  test("5. cash needs an open shift; card and UPI may go unattached", async () => {
    await shifts.closeShift(ids.shift, { counted_cash: 2150 }, desk, db);
    const { visit } = await extraVisit(ids, "Noshift");
    const draft = await bills.openDraft(visit, desk, db);
    await bills.addLine(draft.id, { item_id: ids.dressing }, desk, db);
    const ready = await bills.setCategory(draft.id, { category: ids.pensioner }, desk, db);
    await refused(
      payments.takePayments(
        draft.id,
        { version: ready.version, mode: "cash", amount: 100 },
        desk,
        db,
      ),
      409,
      /Open your shift first/,
      "cash with no shift open",
    );
    const card = await payments.takePayments(
      draft.id,
      { version: ready.version, mode: "card", amount: 100, reference: `C2-${tag}` },
      desk,
      db,
    );
    expect(card.payments[0].shift_id).toBeNull();
    ids.shift = (await shifts.openShift({ opening_cash: 0 }, desk, db)).id;
    const cash = await payments.takePayments(
      draft.id,
      { version: card.version, mode: "cash", amount: 100 },
      desk,
      db,
    );
    expect(cash.payments[0].shift_id).toBe(ids.shift);
    expect(cash.totals.outstanding).toBe(30000);
    ids.noshiftBill = draft.id;
    ids.noshiftVersion = cash.version;
  });

  test("6. the version lock stops two desks taking the last rupee twice", async () => {
    const bill = ids.overBill;
    const before = await bills.readBill(bill, db);
    await refused(
      payments.takePayments(
        bill,
        { version: before.version - 1, mode: "cash", amount: 100 },
        desk,
        db,
      ),
      409,
      /changed while you were working on it/,
      "a stale version",
    );
    const holder = await db.connect();
    let blocked;
    try {
      await holder.query("BEGIN");
      const first = await payments.takePayments(
        bill,
        { version: before.version, mode: "cash", amount: 300 },
        desk,
        holder,
      );
      expect(first.totals.outstanding).toBe(0);
      blocked = payments.takePayments(
        bill,
        { version: before.version, mode: "cash", amount: 300 },
        desk,
        db,
      );
      await holder.query("COMMIT");
    } catch (error) {
      await holder.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      holder.release();
    }
    const error = await failure(blocked);
    expect(error?.status, error?.message ?? "the second desk was allowed").toBe(409);
    expect(error.message).toMatch(/changed while you were working|left to collect/);
    const { total } = await one(
      `SELECT COALESCE(SUM(amount), 0)::numeric AS total FROM payments WHERE bill_id = $1`,
      [bill],
    );
    expect(Number(total)).toBe(500);
    const stored = await one(`SELECT paid_amount FROM bills WHERE id = $1`, [bill]);
    expect(Number(stored.paid_amount)).toBe(500);
  });

  test("7. a cancelled bill takes no payment, and every payment is audited", async () => {
    const { visit } = await extraVisit(ids, "Cancel");
    const draft = await bills.openDraft(visit, desk, db);
    await bills.addLine(draft.id, { item_id: ids.dressing }, desk, db);
    const ready = await bills.setCategory(draft.id, { category: ids.pensioner }, desk, db);
    const final = await bills.finaliseBill(
      draft.id,
      { version: ready.version, pay_later: true },
      desk,
      db,
    );
    await bills.cancelBill(draft.id, { reason: "wrong patient" }, desk, db);
    await refused(
      payments.takePayments(
        draft.id,
        { version: final.version + 1, mode: "cash", amount: 100 },
        desk,
        db,
      ),
      409,
      /was cancelled/,
      "paying a cancelled bill",
    );
    const list = await payments.listPayments(ids.bill, db);
    expect(list).toHaveLength(2);
    expect(list.map((row) => row.amount)).toEqual([100000, 165000]);
    const audit = await query(
      `SELECT action, actor_id FROM billing_audit WHERE entity = 'payments' AND entity_id = $1`,
      [list[0].id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ action: "create", actor_id: desk.actorId });
  });

  test("8. receipt numbers run on without a gap", async () => {
    const { rows } = await query(
      `SELECT receipt_no FROM payments
        WHERE bill_id IN (SELECT id FROM bills WHERE patient_id IN
              (SELECT id FROM patients WHERE name LIKE $1))
        ORDER BY receipt_no`,
      [`P4 %${tag}`],
    );
    const numbers = rows.map((row) => Number(row.receipt_no.slice(ids.receiptPrefix.length)));
    expect(numbers.length).toBeGreaterThan(4);
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(numbers.at(-1) - numbers[0]).toBe(numbers.length - 1);
  });

  test("9. a receipt is numbered from the day it is written, not the bill's date", async () => {
    const { visit } = await extraVisit(ids, "Lastyear");
    const draft = await bills.openDraft(visit, desk, db);
    await bills.addLine(draft.id, { item_id: ids.dressing }, desk, db);
    const ready = await bills.setCategory(draft.id, { category: ids.pensioner }, desk, db);
    const { bill_date } = await one(
      `UPDATE bills SET bill_date = ($2::date - INTERVAL '2 years')::date
        WHERE id = $1 RETURNING bill_date::text`,
      [draft.id, ids.day],
    );
    const billFy = billSeries.financialYear(bill_date);
    expect(billFy, `${bill_date} falls in a different financial year`).not.toBe(ids.fy);
    const receiptSeries = async (fy) =>
      (await one(`SELECT next_no FROM bill_series WHERE series = 'RCPT' AND fy = $1`, [fy]))
        ?.next_no ?? null;
    const oldYearBefore = await receiptSeries(billFy);
    const thisYearBefore = await receiptSeries(ids.fy);

    const taken = await payments.takePayments(
      draft.id,
      { version: ready.version, mode: "cash", amount: 500 },
      desk,
      db,
    );
    expect(taken.payments[0].receipt_no.startsWith(ids.receiptPrefix)).toBe(true);
    expect(await receiptSeries(billFy), `${billFy} numbered nothing`).toBe(oldYearBefore);
    expect(receiptNo(taken.payments[0]), `${ids.fy} numbered the receipt`).toBeGreaterThanOrEqual(
      Number(thisYearBefore),
    );
    expect(
      Number(await receiptSeries(ids.fy)),
      `${ids.fy} is the series that moved`,
    ).toBeGreaterThan(Number(thisYearBefore));
  });
});
