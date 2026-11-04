import { test, expect } from "@playwright/test";
import ExcelJS from "exceljs";
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
    await shifts
      .getByRole("link", { name: /^Open the shift of/ })
      .first()
      .click();
    await expect(page).toHaveURL(/\/billing\/staff\/shifts\//);
    await expect(page.getByRole("table", { name: "Cash handover" })).toBeVisible();
    await page.getByRole("link", { name: "Back to Staff & shifts" }).click();
    await expect(page).toHaveURL(new RegExp(`from=${ids.day}`));
    await expect(page.getByRole("table", { name: "By staff" })).toBeVisible();
  });

  test("3. the shift page lists the payments by tab and the admin closes it as not counted", async ({
    page,
  }) => {
    await loginAs(page, "reception_admin");
    await gotoReady(
      page,
      `/billing/staff?range=custom&from=${ids.day}&to=${ids.day}&shift=${shift.id}`,
      () => page.getByRole("table", { name: "Cash handover" }),
    );
    await expect(page).toHaveURL(new RegExp(`/billing/staff/shifts/${shift.id}`));
    await expect(page.getByRole("table", { name: "Cash handover" })).toContainText(
      "Expected in drawer",
    );
    await expect(page.getByRole("table", { name: "Payments in this shift" })).toContainText(
      "SdPage",
    );
    await page.getByLabel("Search").fill("no-such-patient-zz");
    await expect(page.getByText("No payments match this search.")).toBeVisible();
    await page.getByLabel("Search").fill("");
    await page.getByRole("tab", { name: /Bills and discounts/ }).click();
    await expect(page).toHaveURL(/tab=activity/);
    await page.getByRole("tab", { name: /Payments/ }).click();
    const form = page.getByRole("form", { name: "Close this shift" });
    const countedBox = form.getByLabel(/^Counted cash/);
    await countedBox.fill("485448655332547354323");
    await expect(countedBox).toHaveValue("4854486553");
    await countedBox.fill("12ab.345");
    await expect(countedBox).toHaveValue("12.34");
    await countedBox.fill("");
    await form.getByRole("button", { name: "Close shift" }).click();
    await expect(form).toContainText("Enter the cash you counted in the drawer.");
    await expect(countedBox).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await countedBox.fill("9999999");
    await expect(form).toContainText("far more than expected");
    await form.getByLabel("Close as not counted").check();
    await form.getByRole("button", { name: "Close shift" }).click();
    await expect(form).toContainText("Say why the cash isn't being counted.");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await form.getByLabel(/^Note/).fill("Left open two days, drawer counted later");
    await form.getByRole("button", { name: "Close shift" }).click();
    await page.getByRole("button", { name: "Close the shift" }).click();
    await expect
      .poll(
        async () =>
          (await one(`SELECT not_counted FROM cash_shifts WHERE id = $1`, [shift.id])).not_counted,
      )
      .toBe(true);
    await expect(page.getByText("Not counted").first()).toBeVisible();
    await expect(page.getByRole("form", { name: "Close this shift" })).toHaveCount(0);
    const url = page.url();
    await page.getByRole("button", { name: "Print handover slip" }).click();
    const slip = page.getByRole("dialog", { name: "Handover slip" });
    await expect(slip.getByRole("heading", { name: "Cash handover — shift closed" })).toBeVisible();
    await expect(slip).toContainText("Not counted");
    await expect(slip.getByRole("button", { name: "Print" })).toBeVisible();
    await page.emulateMedia({ media: "print" });
    const printed = await page.evaluate(() => ({
      slip: document.querySelector(".slip-body")?.getBoundingClientRect().width ?? 0,
      menuShown: [...document.body.children].some(
        (el) =>
          !el.classList.contains("bill-dialog-layer") && el.getBoundingClientRect().height > 0,
      ),
    }));
    expect(printed.slip).toBeGreaterThan(600);
    expect(printed.menuShown).toBe(false);
    await page.emulateMedia({ media: "screen" });
    expect(page.url()).toBe(url);
    await slip.getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
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

  test("5b. Download Excel gives the staff, shifts and payments sheets for the dates", async ({
    page,
  }) => {
    await loginAs(page, "reception_admin");
    await staffPage(
      page,
      `?range=custom&from=${ids.day}&to=${ids.day}&staff=${USERS.reception.id}`,
    );
    const saved = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download Excel" }).click();
    const file = await saved;
    expect(file.suggestedFilename()).toBe(`staff-and-shifts-${ids.day}-to-${ids.day}.xlsx`);
    const book = new ExcelJS.Workbook();
    await book.xlsx.readFile(await file.path());
    expect(book.worksheets.map((ws) => ws.name)).toEqual(["Staff", "Shifts", "Payments"]);
    const staff = book.getWorksheet("Staff");
    const headers = staff.getRow(1).values.slice(1);
    const netAt = headers.indexOf("Net collected") + 1;
    const rows = [];
    staff.eachRow((row, n) => n > 1 && row.getCell(1).value && rows.push(row));
    const person = rows.find((row) => row.getCell(1).value === USERS.reception.name);
    const total = rows.find((row) => row.getCell(1).value === "Total");
    expect(person.getCell(netAt).value).toBe(total.getCell(netAt).value);
    const payments = book.getWorksheet("Payments");
    const listed = [];
    payments.eachRow((row, n) => n > 1 && listed.push(String(row.getCell(4).value ?? "")));
    expect(listed.some((name) => name.includes("SdPage"))).toBe(true);
  });

  test("6. on a phone the staff page has no sideways page scroll", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginAs(page, "reception_admin");
    await staffPage(page, `?range=custom&from=${ids.day}&to=${ids.day}`);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(wide).toBeLessThanOrEqual(390);
  });

  test("7. hand-edited links are caught: bad dates, a page past the end, an unknown filter", async ({
    page,
  }) => {
    await loginAs(page, "reception_admin");
    await page.goto(`/billing/staff?range=custom&from=2026-13-45&to=${ids.day}`);
    await expect(page.getByRole("alert")).toContainText("Choose a valid start date.");
    await expect(page.getByRole("button", { name: "Download Excel" })).toBeDisabled();
    await page.goto(`/billing/staff?range=custom&from=${ids.day}&to=2999-01-01`);
    await expect(page.getByRole("alert")).toContainText("The end date can't be after today.");
    await gotoReady(page, `/billing/staff/shifts/${shift.id}?page=999&show=nonsense`, () =>
      page.getByRole("table", { name: "Payments in this shift" }),
    );
    await expect(page.getByRole("table", { name: "Payments in this shift" })).toContainText(
      "SdPage",
    );
    await expect(page.getByText(/^Showing 1–/)).toBeVisible();
    await page.goto(`/billing/staff/shifts/not-a-shift`);
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByRole("link", { name: "Back to Staff & shifts" })).toBeVisible();
  });
});
