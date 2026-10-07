import { test, expect } from "@playwright/test";
import { loginAs } from "../../helpers/auth.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
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
const deposits = await import("../../../server/services/billing/deposits.js");
const requests = await import("../../../server/services/billing/billingRequests.js");

const tag = newTag();
const RECEPTION = "/giniflow/station/reception";
let ids;

const pad = (page) => page.getByRole("region", { name: "Totals and payment" });
const panel = (page) => page.getByRole("region", { name: "Patient deposit" });
const actions = (page) => panel(page).getByRole("group", { name: "Deposit actions" });

async function openDeposit(page, role) {
  await loginAs(page, role);
  await gotoReady(
    page,
    `${RECEPTION}?tab=bill&visit=${ids.draft.visit_id}&bill=${ids.draft.id}`,
    () => pad(page),
  );
  await panel(page)
    .getByRole("button", { name: /^Deposit/ })
    .click();
}

test.describe
  .serial("D04 counter: move a deposit to IPD, ask to pay it back, pay out on the board", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    await prepareCategory(ids);
    await openDeskShift(5000);
    ids.draft = (await draftWith(ids, "UiMoves", [{ item: ids.brace }])).bill;
    await deposits.receiveDeposit(ids.draft.patient_id, { mode: "cash", amount: 2000 }, desk, db);
  });

  test.afterAll(async () => {
    await tearDown(ids);
    await dropShifts();
  });

  test("1. a billing desk sees Pay back only; moves need a reception admin", async ({ page }) => {
    await openDeposit(page, "reception");
    await expect(actions(page).getByRole("button", { name: "Pay back" })).toBeVisible();
    await expect(actions(page).getByRole("button", { name: "Move to IPD" })).toHaveCount(0);
    await expect(panel(page)).toContainText("needs a reception admin");
  });

  test("2. reception admin moves part of the deposit to IPD after confirming", async ({ page }) => {
    await openDeposit(page, "reception_admin");
    await actions(page).getByRole("button", { name: "Move to IPD" }).click();
    const form = panel(page).getByRole("form", { name: "Move deposit to IPD" });
    await form.getByLabel(/^Amount/).fill("500");
    await form.getByLabel(/IP \/ admission/).fill(`IP-${tag}`);
    await form.getByLabel(/^Reason/).fill("Admitted today");
    await form.getByRole("button", { name: "Move to IPD" }).click();
    await expect(form).toContainText(`Move ₹500 of`);
    await form.getByRole("button", { name: "Confirm move to IPD" }).click();
    await expect(panel(page)).toContainText(`Moved ₹500 to IPD IP-${tag}`);
    await expect(panel(page).getByRole("table", { name: "Deposit history" })).toContainText(
      "Moved to IPD",
    );
    expect((await deposits.getDeposit(ids.draft.patient_id, db)).balance).toBe(150000);
  });

  test("3. the desk asks to pay back; after approval it is paid out from the Refunds board", async ({
    page,
  }) => {
    await openDeposit(page, "reception");
    await actions(page).getByRole("button", { name: "Pay back" }).click();
    const form = panel(page).getByRole("form", { name: "Ask to pay the deposit back" });
    await form.getByLabel(/^Amount/).fill("400");
    await form.getByLabel(/^Reason/).fill("Patient going home");
    await form.getByRole("button", { name: "Ask for approval" }).click();
    await expect(panel(page)).toContainText("sent for approval");
    const open = (await deposits.getDeposit(ids.draft.patient_id, db)).open_refund;
    await requests.approveRequest(open.id, {}, admin, db);

    await gotoReady(page, `${RECEPTION}?tab=refunds`, () =>
      page.getByRole("button", { name: /Pay back ₹400 by Cash/ }),
    );
    await page.getByRole("button", { name: /Pay back ₹400 by Cash/ }).click();
    await expect(page.getByRole("button", { name: /Pay back ₹400 by Cash/ })).toHaveCount(0);
    expect((await deposits.getDeposit(ids.draft.patient_id, db)).balance).toBe(110000);
  });

  test("4. the move forms fit a phone-width screen", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await openDeposit(page, "reception_admin");
    await actions(page).getByRole("button", { name: "Move to another patient" }).click();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
