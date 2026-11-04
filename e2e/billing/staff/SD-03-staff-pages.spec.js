import { test, expect } from "@playwright/test";
import { one, query } from "../../helpers/db.mjs";
import { loginAs } from "../../helpers/auth.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
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

const tag = newTag();
let ids;
let shift;

const staffPage = (page, search = "") =>
  gotoReady(page, `/billing/staff${search}`, () =>
    page.getByRole("heading", { name: "Staff & shifts" }),
  );
const shiftPanel = (page) => page.getByRole("region", { name: "Shift" });

test.describe.serial("SD-03 staff & shifts pages", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    await prepareCategory(ids);
    shift = await openDeskShift(0);
    const { bill } = await draftWith(ids, "SdPage", [{ item: ids.brace }]);
    const taken = bill.totals.payable;
    await payments.takePayments(
      bill.id,
      { version: bill.version, payments: [{ mode: "cash", amount: taken / 100 }] },
      desk,
      db,
    );
    await query(`UPDATE cash_shifts SET opened_at = opened_at - INTERVAL '2 days' WHERE id = $1`, [
      shift.id,
    ]);
  });

  test.afterAll(async () => {
    await tearDown(ids);
    await dropShifts();
  });

  test("1. reception can't open the staff page", async ({ page }) => {
    await loginAs(page, "reception");
    await page.goto(`/billing/staff`);
    await expect(page.getByRole("heading", { name: "Staff & shifts" })).toHaveCount(0);
  });

  test("2. the page lists the person, their left-open shift, and it needs attention", async ({
    page,
  }) => {
    await loginAs(page, "reception_admin");
    await staffPage(
      page,
      `?range=custom&from=${ids.day}&to=${ids.day}&staff=${USERS.reception.id}`,
    );
    const staff = page.getByRole("table", { name: "By staff" });
    await expect(
      staff.getByRole("button", { name: `Show only ${USERS.reception.name}` }),
    ).toBeVisible();
    const attention = page.getByRole("region", { name: "Needs attention" });
    await expect(attention).toContainText("Shifts left open past their day");
    await expect(attention).toContainText(USERS.reception.name);
    const shifts = page.getByRole("table", { name: "Shifts" });
    await expect(shifts.getByText("Left open").first()).toBeVisible();
  });

  test("3. the drawer shows the handover and the admin closes the shift as not counted", async ({
    page,
  }) => {
    await loginAs(page, "reception_admin");
    await staffPage(page, `?range=custom&from=${ids.day}&to=${ids.day}&shift=${shift.id}`);
    const drawer = page.getByRole("dialog");
    await expect(drawer.getByRole("table", { name: "Cash handover" })).toContainText(
      "Expected in drawer",
    );
    await expect(drawer.getByRole("table", { name: "Payments in this shift" })).toContainText(
      "SdPage",
    );
    const form = drawer.getByRole("form", { name: "Close this shift" });
    await form.getByLabel("Close as not counted").check();
    await expect(form.getByRole("button", { name: "Close shift" })).toBeDisabled();
    await form.getByLabel(/^Note/).fill("Left open two days, drawer counted later");
    await form.getByRole("button", { name: "Close shift" }).click();
    await page.getByRole("button", { name: "Close the shift" }).click();
    await expect
      .poll(
        async () =>
          (await one(`SELECT not_counted FROM cash_shifts WHERE id = $1`, [shift.id])).not_counted,
      )
      .toBe(true);
    await expect(drawer.getByText("Not counted").first()).toBeVisible();
  });

  test("4. the handover slip shows what was handed over", async ({ page }) => {
    await loginAs(page, "reception");
    await gotoReady(page, `/billing/shift-slip/${shift.id}`, () =>
      page.getByRole("heading", { name: /Cash handover/ }),
    );
    await expect(page.getByRole("heading", { name: "Cash handover — shift closed" })).toBeVisible();
    await expect(page.getByText("Not counted").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Print" })).toBeVisible();
  });

  test("5. the Shift tab warns about an old shift and closes by note count", async ({ page }) => {
    const fresh = await openDeskShift(0);
    await query(`UPDATE cash_shifts SET opened_at = opened_at - INTERVAL '1 day' WHERE id = $1`, [
      fresh.id,
    ]);
    await loginAs(page, "reception");
    await gotoReady(page, `/giniflow/station/reception?tab=shift`, () => shiftPanel(page));
    await expect(shiftPanel(page).getByRole("alert")).toContainText("has been open since");
    await shiftPanel(page).getByText("Count by notes (optional)").click();
    await shiftPanel(page).getByLabel("₹100 notes").fill("3");
    await shiftPanel(page).getByLabel("Coins (₹)").fill("5");
    await expect(shiftPanel(page).getByLabel("Counted cash")).toHaveValue("305.00");
    await shiftPanel(page).getByRole("button", { name: "Close shift" }).click();
    await page.getByRole("button", { name: "Close the shift" }).click();
    await expect(
      shiftPanel(page).getByRole("status").filter({ hasText: "Shift closed" }),
    ).toContainText("The handover is recorded");
    const row = await one(
      `SELECT counted_cash, difference, denominations FROM cash_shifts WHERE id = $1`,
      [fresh.id],
    );
    expect(Number(row.counted_cash)).toBe(305);
    expect(Number(row.difference)).toBe(305);
    expect(row.denominations).toMatchObject({ notes: { 100: 3 }, coins: 500, total: 30500 });
    await expect(
      shiftPanel(page).getByRole("link", { name: "Print the handover slip" }),
    ).toBeVisible();
  });

  test("6. on a phone the staff page has no sideways page scroll", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginAs(page, "reception_admin");
    await staffPage(page, `?range=custom&from=${ids.day}&to=${ids.day}`);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(wide).toBeLessThanOrEqual(390);
  });
});
