import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../../helpers/db.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { apiAs, loginAs } from "../../helpers/auth.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { desk, extraVisit, newTag, refused, setUp, tearDown } from "./p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");
const payments = await import("../../../server/services/billing/payments.js");
const shifts = await import("../../../server/services/billing/cashShifts.js");
const { correctPaymentMode } =
  await import("../../../server/services/billing/paymentCorrection.js");

const db = getPool();
const tag = newTag();
const admin = { actorId: USERS.admin.id, ip: "10.9.42.1", role: USERS.admin.role };
const coordinator = {
  actorId: USERS.coordinator.id,
  ip: "10.9.42.2",
  role: USERS.coordinator.role,
};
let ids;

const closeOpenShifts = () =>
  query(
    `UPDATE cash_shifts
        SET closed_at = NOW(), expected_cash = opening_cash, counted_cash = opening_cash,
            difference = 0
      WHERE closed_at IS NULL AND user_id = ANY($1::int[])`,
    [[USERS.reception.id, USERS.coordinator.id, USERS.admin.id]],
  );

async function paidBill(label, payment) {
  const { visit } = await extraVisit(ids, label, { healthray: false });
  await query(`UPDATE giniflow_visits SET current_status = 'checked_in' WHERE id = $1`, [visit]);
  await query(
    `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, occurred_at)
     VALUES ($1, 'checked_in', 'reception', NOW())`,
    [visit],
  );
  const draft = await bills.openDraft(visit, desk, db);
  await bills.addLine(draft.id, { item_id: ids.dressing }, desk, db);
  const ready = await bills.setCategory(draft.id, { category: ids.pensioner }, desk, db);
  await payments.takePayments(draft.id, { version: ready.version, payments: [payment] }, desk, db);
  const paid = await bills.readBill(draft.id, db);
  const final = await bills.finaliseBill(draft.id, { version: paid.version }, desk, db);
  const taken = await one(`SELECT id, shift_id FROM payments WHERE bill_id = $1`, [final.id]);
  return { billId: final.id, paymentId: taken.id, shiftId: taken.shift_id };
}

const paymentRow = (id) => one(`SELECT mode, reference FROM payments WHERE id = $1`, [id]);

test.describe.serial("P4C-42 correcting a payment's mode", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    await closeOpenShifts();
  });

  test.afterAll(async () => {
    await tearDown(ids);
    await closeOpenShifts();
  });

  test("1. reception corrects their own payment while the shift is open, and it is audited", async () => {
    await shifts.openShift({ opening_cash: 0 }, desk, db);
    ids.first = await paidBill("ModeOwn", { mode: "cash", amount: 500 });

    await correctPaymentMode(
      ids.first.paymentId,
      { mode: "upi", reference: `UPI-${tag}`, reason: "Paid by UPI, entered as cash" },
      desk,
      db,
    );
    expect(await paymentRow(ids.first.paymentId)).toEqual({
      mode: "upi",
      reference: `UPI-${tag}`,
    });
    const audit = await one(
      `SELECT before->>'mode' AS was, after->>'mode' AS now, after->>'reason' AS reason
         FROM billing_audit WHERE entity = 'payments' AND entity_id = $1`,
      [ids.first.paymentId],
    );
    expect(audit).toEqual({ was: "cash", now: "upi", reason: "Paid by UPI, entered as cash" });
  });

  test("2. after the shift closes only an admin corrects it, and the drawer is recounted", async () => {
    await shifts.closeShift(ids.first.shiftId, { counted_cash: 500 }, desk, db);
    const closed = await one(
      `SELECT expected_cash::float AS expected, difference::float AS difference
         FROM cash_shifts WHERE id = $1`,
      [ids.first.shiftId],
    );
    expect(closed).toEqual({ expected: 0, difference: 500 });

    await refused(
      correctPaymentMode(ids.first.paymentId, { mode: "cash", reason: "Back to cash" }, desk, db),
      403,
      /shift for that payment is closed/,
      "own payment after the shift closed",
    );
    await correctPaymentMode(
      ids.first.paymentId,
      { mode: "cash", reason: "Patient paid cash after all" },
      admin,
      db,
    );
    expect(await paymentRow(ids.first.paymentId)).toEqual({ mode: "cash", reference: null });
    const recounted = await one(
      `SELECT expected_cash::float AS expected, difference::float AS difference
         FROM cash_shifts WHERE id = $1`,
      [ids.first.shiftId],
    );
    expect(recounted).toEqual({ expected: 500, difference: 0 });
  });

  test("3. a correction needs a real change, a reference for card or UPI, and the right person", async () => {
    await shifts.openShift({ opening_cash: 0 }, desk, db);
    const second = await paidBill("ModeRules", { mode: "cash", amount: 500 });
    await refused(
      correctPaymentMode(second.paymentId, { mode: "cash", reason: "Same again" }, desk, db),
      400,
      /already the payment's mode/,
      "no change",
    );
    await refused(
      correctPaymentMode(second.paymentId, { mode: "card", reason: "Was card" }, desk, db),
      400,
      /needs its reference number/,
      "card without reference",
    );
    await refused(
      correctPaymentMode(
        second.paymentId,
        { mode: "card", reference: "C-1", reason: "Was card" },
        coordinator,
        db,
      ),
      403,
      /Only the person who took that payment/,
      "another desk",
    );
  });

  test("4. the desk sees which payments it may correct and corrects through the API", async () => {
    const third = await paidBill("ModeApi", { mode: "cash", amount: 500 });
    const api = await apiAs("reception");
    const listed = await api.get(`/api/billing/bills/${third.billId}/payments`);
    expect(listed.status()).toBe(200);
    expect((await listed.json())[0]).toMatchObject({
      mode: "cash",
      can_correct: true,
      shift_open: true,
    });
    const saved = await api.patch(`/api/billing/payments/${third.paymentId}/mode`, {
      data: { mode: "card", reference: `CARD-${tag}`, reason: "Card machine slip shows card" },
    });
    expect(saved.status()).toBe(200);
    expect(await saved.json()).toMatchObject({ mode: "card", reference: `CARD-${tag}` });
    await api.dispose();
  });

  test("5. at the counter reception corrects a payment's mode from the bill", async ({ page }) => {
    await paidBill("ModeScreen", { mode: "cash", amount: 500 });
    await loginAs(page, "reception");
    await gotoReady(page, "/giniflow/station/billing", () =>
      page.getByRole("searchbox", { name: "Search today's patients" }),
    );
    await page
      .getByRole("searchbox", { name: "Search today's patients" })
      .fill(`ModeScreen ${tag}`);
    await page
      .getByRole("complementary", { name: "Today's patients" })
      .getByRole("button", { name: `P4 ModeScreen ${tag}` })
      .click();

    await page
      .getByRole("button", { name: /^Open bill / })
      .first()
      .click();
    const received = page.getByRole("table", { name: "Payments received" });
    await expect(received).toContainText("Cash");
    await page.getByRole("button", { name: /^Correct .* payment$/ }).click();
    const form = page.getByRole("form", { name: "Correct how it was paid" });
    await form.getByRole("combobox", { name: /^Really paid by/ }).selectOption("upi");
    await form.getByRole("textbox", { name: "Reference" }).fill(`UPI-S-${tag}`);
    await form.getByRole("textbox", { name: "Reason" }).fill("Paid by UPI, typed as cash");
    await form.getByRole("button", { name: "Save correction" }).click();

    await expect(received).toContainText(`UPI · UPI-S-${tag}`);
    await expect(form).toHaveCount(0);
  });
});
