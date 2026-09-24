import { test, expect } from "@playwright/test";
import { getPool, query } from "../../helpers/db.mjs";
import { loginAs } from "../../helpers/auth.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { fromPaise, rupees } from "../../../src/components/billing/format.js";
import { desk, extraVisit, newTag, setUp, tearDown } from "./p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");

const db = getPool();
const tag = newTag();
let ids;
let second;
let older;
let payLaterBefore = null;

const COUNTER = "/giniflow/station/billing";

const dues = (page) => page.getByRole("region", { name: "Dues" });
const shiftPanel = (page) => page.getByRole("region", { name: "Shift" });
const pad = (page) => page.getByRole("region", { name: "Totals and payment" });
const actions = (page) => page.getByRole("region", { name: "Bill actions" });

const tab = (page, name) => page.getByRole("tab", { name, exact: true });

const openCounter = (page, ready) => gotoReady(page, COUNTER, ready);

const drawerRow = (page, label) =>
  shiftPanel(page)
    .getByRole("row")
    .filter({ has: page.getByRole("rowheader", { name: label, exact: true }) });

const closeShifts = () =>
  query(`DELETE FROM cash_shifts WHERE user_id = $1`, [USERS.reception.id]).catch(() => {});

const setPayLater = (on) => query(`UPDATE billing_settings SET allow_pay_later = $1`, [on]);

async function dueBill(visitId) {
  const draft = await bills.openDraft(visitId, desk, db);
  await bills.addLine(draft.id, { item_id: ids.dressing }, desk, db);
  await bills.setCategory(draft.id, { category: ids.paid }, desk, db);
  const priced = await bills.readBill(draft.id, db);
  const final = await bills.finaliseBill(
    draft.id,
    { version: priced.version, pay_later: true },
    desk,
    db,
  );
  return final;
}

test.describe.serial("P4-34 dues list and shift panel", () => {
  test.describe.configure({ retries: 1 });

  test.beforeAll(async () => {
    payLaterBefore =
      (await query(`SELECT allow_pay_later FROM billing_settings`)).rows[0]?.allow_pay_later ??
      false;
    await setPayLater(true);
    ids = await setUp(tag);
    await closeShifts();

    ids.due = await dueBill(ids.visit);
    second = await extraVisit(ids, "Second");
    second.due = await dueBill(second.visit);
    older = await extraVisit(ids, "Older");
    await query(`UPDATE giniflow_visits SET visit_date = $2::date - 1 WHERE id = $1`, [
      older.visit,
      ids.day,
    ]);
    older.due = await dueBill(older.visit);
  });

  test.afterAll(async () => {
    await closeShifts();
    await tearDown(ids);
    await setPayLater(payLaterBefore).catch(() => {});
  });

  test("1. the Dues tab is there only while pay-later is allowed", async ({ page }) => {
    await loginAs(page, "reception");
    await setPayLater(false);
    try {
      const settings = page.waitForResponse((r) => r.url().includes("/billing/desk-settings"));
      await openCounter(page, () => tab(page, "Shift"));
      await settings;
      await expect(tab(page, "Dues")).toHaveCount(0);
    } finally {
      await setPayLater(true);
    }

    await openCounter(page, () => tab(page, "Dues"));
    await expect(tab(page, "Dues")).toBeVisible();
  });

  test("2. the Dues tab lists what is still to be collected", async ({ page }) => {
    await loginAs(page, "reception");
    await openCounter(page, () => tab(page, "Dues"));
    await tab(page, "Dues").click();

    const row = dues(page).getByRole("row").filter({ hasText: ids.due.bill_no });
    await expect(row).toBeVisible();
    await expect(row).toContainText(`P4 Patient ${tag}`);
    await expect(row).toContainText(fromPaise(ids.due.totals.payable));
    await expect(row).toContainText("Pay later");
    await expect(dues(page).getByRole("row").filter({ hasText: second.due.bill_no })).toBeVisible();
  });

  test("3. a due opens its own finalised bill, is paid from the list, and leaves it", async ({
    page,
  }) => {
    await loginAs(page, "reception");
    await openCounter(page, () => tab(page, "Dues"));
    await tab(page, "Dues").click();
    await dues(page)
      .getByRole("button", { name: `Take payment on bill ${ids.due.bill_no}` })
      .click();

    await expect(actions(page)).toBeVisible();
    expect(page.url()).toContain(`bill=${ids.due.id}`);
    await expect(actions(page).getByRole("button", { name: "Cancel unpaid bill" })).toBeVisible();
    await expect(actions(page).getByRole("button", { name: "Finalise & print" })).toHaveCount(0);

    await pad(page).getByLabel("Mode").selectOption("card");
    await pad(page)
      .getByLabel("Amount")
      .fill(String(ids.due.totals.payable / 100));
    await pad(page).getByLabel("Reference").fill(`CARD-${tag}`);
    await pad(page).getByRole("button", { name: "Take payment" }).click();
    await expect(pad(page).getByText("Payment taken")).toBeVisible();

    const settled = await bills.readBill(ids.due.id, db);
    expect(settled.totals.paid).toBe(settled.totals.payable);

    await tab(page, "Dues").click();
    await expect(dues(page).getByRole("row").filter({ hasText: ids.due.bill_no })).toHaveCount(0);
    await expect(dues(page).getByRole("row").filter({ hasText: second.due.bill_no })).toBeVisible();
  });

  test("4. a shift opens with its opening cash and closes with the counted cash and difference", async ({
    page,
  }) => {
    await closeShifts();
    await loginAs(page, "reception");
    await openCounter(page, () => tab(page, "Shift"));
    await tab(page, "Shift").click();

    await shiftPanel(page).getByLabel("Opening cash").fill("1000");
    await shiftPanel(page).getByRole("button", { name: "Open shift" }).click();
    await expect(drawerRow(page, "Expected in the drawer").getByRole("cell")).toHaveText(
      rupees(1000),
    );

    await tab(page, "Dues").click();
    await dues(page)
      .getByRole("button", { name: `Take payment on bill ${second.due.bill_no}` })
      .click();
    await pad(page)
      .getByLabel("Amount")
      .fill(String(second.due.totals.payable / 100));
    await pad(page).getByRole("button", { name: "Take payment" }).click();
    await expect(pad(page).getByText("Payment taken")).toBeVisible();

    const collected = second.due.totals.payable / 100;
    const expectedCash = 1000 + collected;
    const counted = expectedCash + 50;

    await tab(page, "Shift").click();
    await expect(drawerRow(page, "Cash collected").getByRole("cell")).toHaveText(rupees(collected));
    await expect(drawerRow(page, "Expected in the drawer").getByRole("cell")).toHaveText(
      rupees(expectedCash),
    );

    await shiftPanel(page).getByLabel("Counted cash").fill(String(counted));
    await expect(shiftPanel(page).getByText(`Difference ${rupees(50)}`)).toBeVisible();
    await shiftPanel(page).getByRole("button", { name: "Close shift" }).click();
    await page.getByRole("button", { name: "Close the shift" }).click();

    await expect(shiftPanel(page).getByText("Shift closed", { exact: false })).toContainText(
      `difference ${rupees(50)}`,
    );

    const { rows } = await query(
      `SELECT opening_cash, expected_cash, counted_cash, difference, closed_at
         FROM cash_shifts WHERE user_id = $1 ORDER BY opened_at DESC LIMIT 1`,
      [USERS.reception.id],
    );
    expect(Number(rows[0].opening_cash)).toBe(1000);
    expect(Number(rows[0].expected_cash)).toBe(expectedCash);
    expect(Number(rows[0].counted_cash)).toBe(counted);
    expect(Number(rows[0].difference)).toBe(50);
    expect(rows[0].closed_at).not.toBeNull();

    await expect(
      shiftPanel(page).getByRole("table", { name: "Your earlier shifts" }),
    ).toContainText(rupees(counted));
    await expect(shiftPanel(page).getByLabel("Opening cash")).toBeVisible();
  });

  test("5. a due from an earlier day still names its patient at the counter", async ({ page }) => {
    await loginAs(page, "reception");
    await openCounter(page, () => tab(page, "Dues"));
    await tab(page, "Dues").click();
    await dues(page)
      .getByRole("button", { name: `Take payment on bill ${older.due.bill_no}` })
      .click();

    await expect(page.getByRole("heading", { name: `P4 Older ${tag}` })).toBeVisible();
    await expect(actions(page)).toBeVisible();
  });
});
