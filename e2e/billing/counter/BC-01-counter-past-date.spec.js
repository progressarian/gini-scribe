import { test, expect } from "@playwright/test";
import { one, query } from "../../helpers/db.mjs";
import { loginAs, tokensFor } from "../../helpers/auth.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { API_URL } from "../../setup/testEnv.mjs";
import { desk, extraVisit, newTag, setUp, tearDown } from "../phase4/p4-bills-fixture.mjs";
import { db, dropShifts, openDeskShift, prepareCategory } from "../phase4b/p4b-refunds.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");
const payments = await import("../../../server/services/billing/payments.js");
const counter = await import("../../../server/services/billing/counterPatients.js");
const dashboard = await import("../../../server/services/billing/dashboard.js");

const tag = newTag();
const DAY_MS = 86400000;
const dayBefore = (day, n) =>
  new Date(Date.parse(`${day}T00:00:00Z`) - n * DAY_MS).toISOString().slice(0, 10);

let ids;
let past;
const made = {};

const list = (page) => page.getByRole("complementary", { name: /patients/i });
const counterAt = (page, search) =>
  gotoReady(page, `/giniflow/station/reception?tab=bill${search}`, () =>
    page.getByRole("group", { name: "Counter date controls" }),
  );

async function pastVisit(label) {
  const visit = await extraVisit(ids, label, { healthray: false });
  await query(`UPDATE giniflow_visits SET visit_date = $2::date WHERE id = $1`, [
    visit.visit,
    past,
  ]);
  await query(`UPDATE appointments SET appointment_date = $2::date WHERE id = $1`, [
    visit.appointment,
    past,
  ]);
  const draft = await bills.openDraft(visit.visit, desk, db);
  await bills.addLine(draft.id, { item_id: ids.brace }, desk, db);
  const ready = await bills.setCategory(draft.id, { category: ids.pensioner }, desk, db);
  return { ...visit, bill: ready };
}

test.describe.serial("BC-01 the billing counter on a past date", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    await prepareCategory(ids);
    await openDeskShift(0);
    past = dayBefore(ids.day, 3);
    made.paid = await pastVisit("CtrPaid");
    await payments.takePayments(
      made.paid.bill.id,
      { version: made.paid.bill.version, payments: [{ mode: "cash", amount: 800 }] },
      desk,
      db,
    );
    made.due = await pastVisit("CtrDue");
    made.dueFinal = await bills.finaliseBill(
      made.due.bill.id,
      { version: made.due.bill.version, pay_later: true },
      desk,
      db,
    );
    counter.billingChanged();
    dashboard.clearDashboardCache();
  });

  test.afterAll(async () => {
    await tearDown(ids);
    await dropShifts();
  });

  test("1. the service lists that day's visits, says it isn't today, and refuses the future", async () => {
    const day = await counter.counterPatients(past, "", new Date(), db);
    expect(day).toMatchObject({ date: past, isToday: false, today: ids.day });
    const names = [...day.toBill, ...day.billed, ...day.waiting].map((row) => row.name);
    expect(names).toEqual(expect.arrayContaining([`P4 CtrPaid ${tag}`, `P4 CtrDue ${tag}`]));
    expect(day.firstDay <= past).toBe(true);
    const today = await counter.counterPatients("", "", new Date(), db);
    expect(today.isToday).toBe(true);
    expect([...today.toBill, ...today.billed].map((row) => row.name)).not.toContain(
      `P4 CtrPaid ${tag}`,
    );
    const future = dayBefore(ids.day, -1);
    await expect(counter.counterPatients(future, "", new Date(), db)).rejects.toMatchObject({
      status: 400,
    });
    const res = await fetch(`${API_URL}/api/billing/counter/patients?date=${future}`, {
      headers: { authorization: `Bearer ${(await tokensFor("reception")).access}` },
    });
    expect(res.status).toBe(400);
  });

  test("2. a past date shows a banner, that day's list, and does not keep polling", async ({
    page,
  }) => {
    await loginAs(page, "reception");
    let calls = 0;
    page.on("request", (req) => {
      if (req.url().includes("/counter/patients") && req.url().includes(`date=${past}`)) calls += 1;
    });
    await counterAt(page, `&date=${past}`);
    await expect(page.getByRole("status").filter({ hasText: "not today" })).toBeVisible();
    await expect(page.getByLabel("Counter date", { exact: true })).toHaveValue(past);
    await expect(page.getByLabel("Counter date", { exact: true })).toHaveAttribute("max", ids.day);
    await expect(list(page)).toContainText(`P4 CtrPaid ${tag}`);
    await expect(list(page).getByRole("button", { name: /Billed \/ Exited/ })).toBeVisible();
    const before = calls;
    await page.waitForTimeout(8000);
    expect(calls).toBe(before);
  });

  test("3. a paid draft from that day is flagged and can be finalised there, keeping its date", async ({
    page,
  }) => {
    await loginAs(page, "reception");
    await counterAt(page, `&date=${past}`);
    await expect(list(page)).toContainText("1 paid, not final");
    await list(page)
      .getByRole("button", { name: new RegExp(`P4 CtrPaid ${tag}`) })
      .click();
    await expect(page).toHaveURL(new RegExp(`date=${past}`));
    await page.getByRole("button", { name: "Finalise this bill" }).click();
    await expect
      .poll(
        async () =>
          (await one(`SELECT status FROM bills WHERE id = $1`, [made.paid.bill.id])).status,
      )
      .toBe("final");
    const final = await one(
      `SELECT bill_no, bill_date::text AS bill_date FROM bills WHERE id = $1`,
      [made.paid.bill.id],
    );
    expect(final.bill_no).toBeTruthy();
    expect(final.bill_date).toBe(past);
    await expect(list(page)).not.toContainText("paid, not final");
  });

  test("4. settling an older bill's due warns that the money is taken today, in today's shift", async ({
    page,
  }) => {
    await loginAs(page, "reception");
    await counterAt(page, `&date=${past}&bill=${made.dueFinal.id}&visit=${made.due.visit}`);
    await expect(
      page.getByRole("note").filter({ hasText: "this payment is recorded today" }),
    ).toBeVisible();
    const fresh = await bills.readBill(made.dueFinal.id, db);
    await payments.takePayments(
      fresh.id,
      { version: fresh.version, payments: [{ mode: "cash", amount: 800 }] },
      desk,
      db,
    );
    const paid = await one(
      `SELECT (received_at AT TIME ZONE 'Asia/Kolkata')::date::text AS day, shift_id
         FROM payments WHERE bill_id = $1`,
      [fresh.id],
    );
    const shift = await one(`SELECT id FROM cash_shifts WHERE user_id = $1 AND closed_at IS NULL`, [
      desk.actorId,
    ]);
    expect(paid).toEqual({ day: ids.day, shift_id: shift.id });
  });

  test("5. back to today clears the date; a reload keeps a chosen date", async ({ page }) => {
    await loginAs(page, "reception");
    await counterAt(page, `&date=${past}`);
    await page.reload();
    await expect(page.getByLabel("Counter date", { exact: true })).toHaveValue(past);
    await page.getByRole("button", { name: "Back to today" }).click();
    await expect(page).not.toHaveURL(/date=/);
    await expect(page.getByLabel("Counter date", { exact: true })).toHaveValue(ids.day);
    await expect(page.getByRole("button", { name: "Next day" })).toBeDisabled();
    await page.getByRole("button", { name: "Previous day" }).click();
    await expect(page).toHaveURL(new RegExp(`date=${dayBefore(ids.day, 1)}`));
  });

  test("6. the dashboard's paid-not-finalised list opens the counter on the bill's own date", async ({
    page,
  }) => {
    const other = await pastVisit("CtrDash");
    await payments.takePayments(
      other.bill.id,
      { version: other.bill.version, payments: [{ mode: "cash", amount: 800 }] },
      desk,
      db,
    );
    dashboard.clearDashboardCache();
    const data = await dashboard.billingDashboard(
      { from: past, to: past, sub_category: ids.pensioner },
      db,
      { today: ids.day },
    );
    expect(data.not_final.bills.map((bill) => bill.bill_id)).toContain(other.bill.id);
    expect(data.total.not_final_bills).toBe(data.not_final.bills.length);

    await loginAs(page, "reception_admin");
    await gotoReady(
      page,
      `/billing/dashboard?range=custom&from=${past}&to=${past}&sub_category=${ids.pensioner}`,
      () => page.getByRole("heading", { name: "Paid, not finalised" }),
    );
    await page
      .getByRole("link", { name: new RegExp(`bill for P4 CtrDash ${tag} at the counter`) })
      .click();
    await expect(page).toHaveURL(new RegExp(`date=${past}`));
    await expect(page).toHaveURL(new RegExp(`visit=${other.visit}`));
    await expect(page.getByRole("button", { name: "Finalise this bill" })).toBeVisible();
  });

  test("7. on a phone the date control fits the screen", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginAs(page, "reception");
    await counterAt(page, `&date=${past}`);
    const right = await page
      .getByRole("group", { name: "Counter date controls" })
      .evaluate((el) => el.getBoundingClientRect().right);
    expect(right).toBeLessThanOrEqual(390);
  });
});
