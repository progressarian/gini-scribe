import { test, expect } from "@playwright/test";
import { loginAs } from "../../helpers/auth.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
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
const deposits = await import("../../../server/services/billing/deposits.js");

const tag = newTag();
const RECEPTION = "/giniflow/station/reception";
let ids;

const pad = (page) => page.getByRole("region", { name: "Totals and payment" });
const panel = (page) => page.getByRole("region", { name: "Patient deposit" });
const history = (page) => panel(page).getByRole("table", { name: "Deposit history" });

async function openDeposit(page, bill) {
  await gotoReady(page, `${RECEPTION}?tab=bill&visit=${bill.visit_id}&bill=${bill.id}`, () =>
    pad(page),
  );
  await panel(page)
    .getByRole("button", { name: /^Deposit/ })
    .click();
}

test.describe.serial("D07 counter: void a wrongly taken deposit receipt", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    await prepareCategory(ids);
    await openDeskShift(0);
    ids.draft = (await draftWith(ids, "UiVoid", [{ item: ids.brace }])).bill;
    ids.taken = await deposits.receiveDeposit(
      ids.draft.patient_id,
      { mode: "upi", amount: 1125, reference: `UPI-${tag}`, note: "entered by mistake" },
      desk,
      db,
    );
  });

  test.afterAll(async () => {
    await tearDown(ids);
    await dropShifts();
  });

  test("1. the dialog names the receipt and the balance change, and needs a reason", async ({
    page,
  }) => {
    await loginAs(page, "reception");
    await openDeposit(page, ids.draft);
    await history(page)
      .getByRole("button", { name: `Void deposit receipt ${ids.taken.receipt_no}` })
      .click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText(`Void deposit receipt ${ids.taken.receipt_no}?`);
    await expect(dialog).toContainText("₹1,125");
    await expect(dialog).toContainText("₹1,125 → ₹0");
    await expect(dialog.getByRole("button", { name: "Void receipt" })).toBeDisabled();
    await dialog.getByLabel("Reason *").fill("Entered by mistake, bill settled in cash");
    await dialog.getByRole("button", { name: "Void receipt" }).click();
    await expect(dialog).toBeHidden();
    await expect(panel(page)).toContainText(`Receipt ${ids.taken.receipt_no} voided`);
    await expect(panel(page)).toContainText("Balance now ₹0");
    await expect(history(page)).toContainText("Receipt voided");
    await expect(history(page)).toContainText("Voided");
    await expect(
      history(page).getByRole("button", { name: `Void deposit receipt ${ids.taken.receipt_no}` }),
    ).toHaveCount(0);
  });

  test("2. the void dialog fits a phone-width screen", async ({ page }) => {
    const again = await deposits.receiveDeposit(
      ids.draft.patient_id,
      { mode: "cash", amount: 200 },
      desk,
      db,
    );
    await page.setViewportSize({ width: 375, height: 800 });
    await loginAs(page, "reception");
    await openDeposit(page, ids.draft);
    await history(page)
      .getByRole("button", { name: `Void deposit receipt ${again.receipt_no}` })
      .click();
    await expect(page.getByRole("dialog")).toBeVisible();
    const wide = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(wide).toBe(false);
  });
});
