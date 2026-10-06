import { test, expect } from "@playwright/test";
import { loginAs } from "../../helpers/auth.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { newTag, setUp, tearDown } from "../phase4/p4-bills-fixture.mjs";
import {
  db,
  draftWith,
  dropShifts,
  finalBill,
  inCash,
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
const dialog = (page) => page.getByRole("dialog");
const actions = (page) => page.getByRole("region", { name: "Bill actions" });

async function openBill(page, bill) {
  await gotoReady(page, `${RECEPTION}?tab=bill&visit=${bill.visit_id}&bill=${bill.id}`, () =>
    pad(page),
  );
}

test.describe.serial("D02 counter: deposit panel, pay from deposit, keep a refund", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    await prepareCategory(ids);
    await dropShifts();
    ids.draft = (await draftWith(ids, "UiDeposit", [{ item: ids.brace }])).bill;
  });

  test.afterAll(async () => {
    await tearDown(ids);
    await dropShifts();
  });

  test("1. taking a cash deposit asks for the shift, then confirms and shows it in the history and header", async ({
    page,
  }) => {
    await loginAs(page, "reception");
    await openBill(page, ids.draft);
    await panel(page)
      .getByRole("button", { name: /^Deposit/ })
      .click();
    await panel(page).getByLabel("Amount *").fill("1000");
    await expect(panel(page)).toContainText("Open your shift");
    await expect(panel(page).getByRole("button", { name: "Take deposit" })).toBeDisabled();

    await openDeskShift(0);
    await page.reload();
    await panel(page)
      .getByRole("button", { name: /^Deposit/ })
      .click();
    await panel(page).getByLabel("Amount *").fill("1000");
    await panel(page).getByRole("button", { name: "Take deposit" }).click();
    await expect(panel(page)).toContainText("Take ₹1,000 by Cash as a deposit");
    await panel(page).getByRole("button", { name: "Confirm deposit" }).click();
    await expect(panel(page)).toContainText("Balance now ₹1,000");
    await expect(panel(page).getByRole("table", { name: "Deposit history" })).toContainText(
      "Deposit taken",
    );
    await expect(
      page.getByRole("button", { name: /Deposit ₹1,000 — show the deposit/ }),
    ).toBeVisible();
  });

  test("2. Deposit is a payment mode capped at what the deposit holds, with no reference box", async ({
    page,
  }) => {
    await loginAs(page, "reception");
    await openBill(page, ids.draft);
    const mode = pad(page).getByRole("combobox", { name: "Mode" }).first();
    await mode.selectOption({ label: "Deposit (₹1,000 available)" });
    await expect(pad(page).getByLabel("Reference")).toHaveCount(0);
    const amount = pad(page).getByLabel("Amount Received").first();
    await expect(amount).toHaveValue("800");
    await pad(page).getByRole("button", { name: "Take payment" }).click();
    await expect(pad(page)).toContainText("Payment taken.");
    expect((await deposits.getDeposit(ids.draft.patient_id, db)).balance).toBe(20000);
  });

  test("3. a refund request defaults to keeping the money as the patient's deposit", async ({
    page,
  }) => {
    const { bill } = await finalBill(ids, "UiKeep", [{ item: ids.brace }], { pay: inCash });
    await loginAs(page, "reception");
    await gotoReady(page, `${RECEPTION}?tab=bill&visit=${bill.visit_id}&bill=${bill.id}`, () =>
      actions(page),
    );
    await actions(page).getByRole("button", { name: "Refund…" }).click();
    await expect(dialog(page).getByRole("combobox", { name: "Refund by" })).toHaveValue("deposit");
    await expect(dialog(page).getByLabel("What the patient gets back")).toContainText(
      "₹800 is kept as deposit for this patient",
    );
  });

  test("4. the deposit panel fits a phone-width screen without sideways scrolling", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await loginAs(page, "reception");
    await openBill(page, ids.draft);
    await panel(page)
      .getByRole("button", { name: /^Deposit/ })
      .click();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
