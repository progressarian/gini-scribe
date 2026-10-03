import { test, expect } from "@playwright/test";
import { getPool, query } from "../../helpers/db.mjs";
import { loginAs } from "../../helpers/auth.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { closePdfViewer, expectPdfInViewer } from "../../helpers/pdfViewer.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { USERS } from "../../fixtures/data.mjs";
import {
  desk,
  extraVisit,
  newTag,
  payRule,
  setUp,
  subCategory,
  tearDown,
} from "./p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");
const shifts = await import("../../../server/services/billing/cashShifts.js");

const db = getPool();
const tag = newTag();
const CODE = `P4TYPED${tag.toUpperCase()}`;
const CARD_NO = `CARD${tag}9911`;
const REFERRAL_NO = `REFNO${tag}7733`;
const RESTORED = "Restored what you'd typed before the page reloaded.";
let ids;
let payLaterBefore = null;

const setPayLater = (on) => query(`UPDATE billing_settings SET allow_pay_later = $1`, [on]);

const closeShifts = () =>
  query(`DELETE FROM cash_shifts WHERE user_id = $1`, [USERS.reception.id]).catch(() => {});

async function freshBill(label, item, category) {
  const made = await extraVisit(ids, label);
  made.bill = (await bills.openDraft(made.visit, desk, db)).id;
  await bills.addLine(made.bill, { item_id: item }, desk, db);
  await bills.setCategory(made.bill, { category }, desk, db);
  return made;
}

const open = (page, visitId) =>
  gotoReady(page, `/giniflow/station/billing?visit=${visitId}`, () =>
    page.getByRole("region", { name: "Totals and payment" }),
  );

const reload = async (page) => {
  await page.reload();
  await pad(page).waitFor({ state: "visible" });
};

const pad = (page) => page.getByRole("region", { name: "Totals and payment" });
const codeBox = (page) => page.getByRole("region", { name: "Discount codes" });
const header = (page) => page.getByRole("region", { name: "Patient" });
const actions = (page) => page.getByRole("region", { name: "Bill actions" });
const clearButton = (page) => actions(page).getByRole("button", { name: "Clear form" });
const billKey = (billId) => `billing.counter.form.${billId}`;

const stored = (page, key) => page.evaluate((k) => window.localStorage.getItem(k), key);

const everyStoredValue = (page) =>
  page.evaluate(() =>
    Object.keys(window.localStorage).map((key) => `${key}=${window.localStorage.getItem(key)}`),
  );

const settle = (page) => page.waitForTimeout(500);

async function typeSplitPayment(page) {
  await pad(page).getByLabel("Mode").selectOption("card");
  await pad(page).getByLabel("Amount").fill("300");
  await pad(page).getByLabel("Reference").fill(`CARD-${tag}`);
  await pad(page).getByRole("button", { name: "Split payment" }).click();
  await pad(page).getByLabel("Mode").nth(1).selectOption("upi");
  await pad(page).getByLabel("Amount").nth(1).fill("500");
  await pad(page).getByLabel("Reference").nth(1).fill(`UPI-${tag}`);
}

async function expectSplitPayment(page) {
  await expect(pad(page).getByLabel("Mode").nth(0)).toHaveValue("card");
  await expect(pad(page).getByLabel("Amount").nth(0)).toHaveValue("300");
  await expect(pad(page).getByLabel("Reference").nth(0)).toHaveValue(`CARD-${tag}`);
  await expect(pad(page).getByLabel("Mode").nth(1)).toHaveValue("upi");
  await expect(pad(page).getByLabel("Amount").nth(1)).toHaveValue("500");
  await expect(pad(page).getByLabel("Reference").nth(1)).toHaveValue(`UPI-${tag}`);
}

async function expectEmptyPad(page) {
  await expect(pad(page).getByLabel("Amount")).toHaveCount(1);
  await expect(pad(page).getByLabel("Amount")).toHaveValue("");
  await expect(pad(page).getByLabel("Mode")).toHaveValue("cash");
  await expect(pad(page).getByText(RESTORED)).toHaveCount(0);
}

test.describe.serial("P4C-11 the counter form survives a refresh", () => {
  test.describe.configure({ retries: 1 });

  test.beforeAll(async () => {
    payLaterBefore =
      (await query(`SELECT allow_pay_later FROM billing_settings`)).rows[0]?.allow_pay_later ??
      false;
    ids = await setUp(tag);
    ids.cardScheme = await subCategory(ids, "Cardholder", {
      requires_ref: true,
      requires_referral: true,
    });
    await payRule(ids, ids.pensioner, { name: "pensioner pays nothing", patient_pays: "nothing" });
    await closeShifts();
    await setPayLater(true);
  });

  test.afterAll(async () => {
    try {
      await setPayLater(payLaterBefore).catch(() => {});
      await tearDown(ids);
    } finally {
      await closeShifts();
    }
  });

  test("1. the shift's opening cash survives a reload, and is cleared once the shift opens", async ({
    page,
  }) => {
    await loginAs(page, "reception");
    await gotoReady(page, "/giniflow/station/billing", () =>
      page.getByRole("tab", { name: "Shift", exact: true }),
    );
    await page.getByRole("tab", { name: "Shift", exact: true }).click();
    const shift = page.getByRole("region", { name: "Shift" });
    await shift.getByLabel("Opening cash").fill("1234");
    await settle(page);

    await page.reload();
    await page.getByRole("tab", { name: "Shift", exact: true }).click();
    await expect(shift.getByLabel("Opening cash")).toHaveValue("1234");

    await shift.getByRole("button", { name: "Open shift" }).click();
    await expect(shift.getByRole("table", { name: "Drawer" })).toBeVisible();
    await settle(page);
    expect(await stored(page, `billing.counter.shift.${USERS.reception.id}`)).toBeNull();
  });

  test("2. typed payment rows, pay later and a typed code survive a reload", async ({ page }) => {
    const bill = await freshBill("Typed", ids.brace, ids.paid);
    await loginAs(page, "reception");
    await open(page, bill.visit);

    await expect(pad(page).getByText(RESTORED)).toHaveCount(0);
    await typeSplitPayment(page);
    await pad(page).getByLabel("Pay later").check();
    await codeBox(page).getByLabel("Discount code", { exact: true }).fill(CODE);
    await settle(page);

    await reload(page);
    await expectSplitPayment(page);
    await expect(pad(page).getByLabel("Pay later")).toBeChecked();
    await expect(codeBox(page).getByLabel("Discount code", { exact: true })).toHaveValue(CODE);
    await expect(pad(page).getByText(RESTORED)).toBeVisible();

    const saved = await bills.readBill(bill.bill, db);
    expect(saved.totals.paid).toBe(0);
    expect(saved.codes).toEqual([]);
  });

  test("3. an unconfirmed category survives a reload, without being saved", async ({ page }) => {
    const bill = await freshBill("Unconfirmed", ids.brace, ids.paid);
    await loginAs(page, "reception");
    await open(page, bill.visit);

    await header(page).getByLabel("Category").selectOption(ids.pensioner);
    await settle(page);
    await reload(page);

    await expect(header(page).getByLabel("Category")).toHaveValue(ids.pensioner);
    expect((await bills.readBill(bill.bill, db)).category).toBe(ids.paid);

    await header(page).getByRole("button", { name: "Confirm category" }).click();
    await expect
      .poll(async () => (await bills.readBill(bill.bill, db)).category)
      .toBe(ids.pensioner);
    await settle(page);
    const left = JSON.parse((await stored(page, billKey(bill.bill))) ?? "null");
    expect(left?.value?.chosen ?? null).toBeNull();
  });

  test("4. the card and referral numbers are never stored", async ({ page }) => {
    const bill = await freshBill("Cardholder", ids.brace, ids.cardScheme);
    await loginAs(page, "reception");
    await open(page, bill.visit);

    await header(page).getByLabel("Card number").fill(CARD_NO);
    await header(page).getByLabel("Referral number").fill(REFERRAL_NO);
    await codeBox(page).getByLabel("Discount code", { exact: true }).fill(CODE);
    await settle(page);

    expect(await stored(page, billKey(bill.bill))).toContain(CODE);
    for (const entry of await everyStoredValue(page)) {
      expect(entry).not.toContain(CARD_NO);
      expect(entry).not.toContain(REFERRAL_NO);
    }

    await reload(page);
    await expect(codeBox(page).getByLabel("Discount code", { exact: true })).toHaveValue(CODE);
    await expect(header(page).getByLabel("Card number")).toHaveValue("");
    await expect(header(page).getByLabel("Referral number")).toHaveValue("");
    for (const entry of await everyStoredValue(page)) {
      expect(entry).not.toContain(CARD_NO);
      expect(entry).not.toContain(REFERRAL_NO);
    }

    await header(page).getByLabel("Card number").fill(CARD_NO);
    await header(page).getByLabel("Referral number").fill(REFERRAL_NO);
    await clearButton(page).click();
    await expect(header(page).getByLabel("Card number")).toHaveValue("");
    await expect(header(page).getByLabel("Referral number")).toHaveValue("");
    expect((await bills.readBill(bill.bill, db)).category).toBe(ids.cardScheme);
  });

  test("5. another patient's bill does not get the first patient's values", async ({ page }) => {
    const first = await freshBill("First", ids.brace, ids.paid);
    const second = await freshBill("Second", ids.brace, ids.paid);
    await loginAs(page, "reception");
    await open(page, first.visit);
    await typeSplitPayment(page);
    await pad(page).getByLabel("Pay later").check();
    await codeBox(page).getByLabel("Discount code", { exact: true }).fill(CODE);
    await header(page).getByLabel("Category").selectOption(ids.pensioner);
    await settle(page);

    await open(page, second.visit);
    await expect(page.getByRole("heading", { name: `P4 Second ${tag}` })).toBeVisible();
    await expectEmptyPad(page);
    await expect(pad(page).getByLabel("Pay later")).not.toBeChecked();
    await expect(codeBox(page).getByLabel("Discount code", { exact: true })).toHaveValue("");
    await expect(header(page).getByLabel("Category")).toHaveValue(ids.paid);
    expect(await stored(page, billKey(second.bill))).toBeNull();

    const untouched = page.getByRole("button", { name: `P4 First ${tag}` });
    if (!(await untouched.isVisible())) {
      await page.getByRole("button", { name: /^Nothing to bill yet/ }).click();
    }
    await untouched.click();
    await expect(page.getByRole("heading", { name: `P4 First ${tag}` })).toBeVisible();
    await expectSplitPayment(page);

    const other = page.getByRole("button", { name: `P4 Second ${tag}` });
    if (!(await other.isVisible())) {
      await page.getByRole("button", { name: /^Nothing to bill yet/ }).click();
    }
    await other.click();
    await expect(page.getByRole("heading", { name: `P4 Second ${tag}` })).toBeVisible();
    await expectEmptyPad(page);
    await expect(pad(page).getByLabel("Pay later")).not.toBeChecked();
    await expect(codeBox(page).getByLabel("Discount code", { exact: true })).toHaveValue("");
  });

  test("6. Clear form empties everything, and a reload after it restores nothing", async ({
    page,
  }) => {
    const bill = await freshBill("Cleared", ids.brace, ids.paid);
    await loginAs(page, "reception");
    await open(page, bill.visit);
    await expect(clearButton(page)).toHaveCount(0);

    await typeSplitPayment(page);
    await pad(page).getByLabel("Pay later").check();
    await codeBox(page).getByLabel("Discount code", { exact: true }).fill(CODE);
    await header(page).getByLabel("Category").selectOption(ids.pensioner);
    await page.getByRole("region", { name: "Add items" }).getByLabel("Search items").fill("zz");
    await settle(page);
    await reload(page);
    await expect(pad(page).getByText(RESTORED)).toBeVisible();
    const before = await bills.readBill(bill.bill, db);

    await clearButton(page).click();
    await expect(actions(page).getByText("Form cleared.")).toBeVisible();
    await expect(clearButton(page)).toHaveCount(0);
    await expectEmptyPad(page);
    await expect(pad(page).getByLabel("Pay later")).not.toBeChecked();
    await expect(codeBox(page).getByLabel("Discount code", { exact: true })).toHaveValue("");
    await expect(header(page).getByLabel("Category")).toHaveValue(ids.paid);
    await expect(
      page.getByRole("region", { name: "Add items" }).getByLabel("Search items"),
    ).toHaveValue("");
    expect(await stored(page, billKey(bill.bill))).toBeNull();

    await reload(page);
    await expectEmptyPad(page);
    await expect(codeBox(page).getByLabel("Discount code", { exact: true })).toHaveValue("");
    await expect(clearButton(page)).toHaveCount(0);

    const saved = await bills.readBill(bill.bill, db);
    expect(saved.status).toBe("draft");
    expect(saved.lines.map((line) => line.id)).toEqual(before.lines.map((line) => line.id));
    expect(saved.version).toBe(before.version);
    expect(saved.category).toBe(ids.paid);
  });

  test("7. a payment taken clears the saved rows, so a reload shows an empty pad", async ({
    page,
  }) => {
    await shifts.openShift({ opening_cash: 1000 }, desk, db).catch(() => {});
    const bill = await freshBill("Paying", ids.brace, ids.paid);
    await loginAs(page, "reception");
    await open(page, bill.visit);

    await pad(page).getByLabel("Mode").selectOption("upi");
    await pad(page).getByLabel("Amount").fill("300");
    await pad(page).getByLabel("Reference").fill(`UPI-PAY-${tag}`);
    await settle(page);
    await reload(page);
    await expect(pad(page).getByLabel("Amount")).toHaveValue("300");

    await pad(page).getByRole("button", { name: "Take payment" }).click();
    await expect(pad(page).getByText("Payment taken")).toBeVisible();
    expect((await bills.readBill(bill.bill, db)).totals.paid).toBe(30000);

    await reload(page);
    await expectEmptyPad(page);
  });

  test("8. a finalise clears the bill's saved form", async ({ page }) => {
    const bill = await freshBill("Finalised", ids.dressing, ids.pensioner);
    await loginAs(page, "reception");
    await open(page, bill.visit);

    await codeBox(page).getByLabel("Discount code", { exact: true }).fill(CODE);
    await settle(page);
    expect(await stored(page, billKey(bill.bill))).toContain(CODE);

    await page.getByRole("button", { name: "Finalise & print" }).click();
    await expectPdfInViewer(page, `/api/billing/bills/${bill.bill}/bill.pdf`);
    await closePdfViewer(page);
    await expect(actions(page).getByText("CGHS pending")).toBeVisible();
    await settle(page);
    expect(await stored(page, billKey(bill.bill))).toBeNull();
    expect((await bills.readBill(bill.bill, db)).status).toBe("final");
  });

  test("9. a counter whose storage throws still works", async ({ page }) => {
    await page.addInitScript(() => {
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (String(key).startsWith("billing.counter.")) throw new Error("storage is full");
        return setItem.call(this, key, value);
      };
    });
    const bill = await freshBill("Throwing", ids.brace, ids.paid);
    await loginAs(page, "reception");
    await open(page, bill.visit);

    await typeSplitPayment(page);
    await codeBox(page).getByLabel("Discount code", { exact: true }).fill(CODE);
    await settle(page);
    await expectSplitPayment(page);
    await expect(clearButton(page)).toBeVisible();

    await clearButton(page).click();
    await expect(actions(page).getByText("Form cleared.")).toBeVisible();
    await expectEmptyPad(page);

    await reload(page);
    await expectEmptyPad(page);
    await expect(codeBox(page).getByLabel("Discount code", { exact: true })).toHaveValue("");
  });

  test("10. a saved form older than a day, or from another version, is dropped on load", async ({
    page,
  }) => {
    const stale = await freshBill("Stale", ids.brace, ids.paid);
    const versioned = await freshBill("Versioned", ids.brace, ids.paid);
    await loginAs(page, "reception");
    await open(page, stale.visit);
    const rows = [{ mode: "upi", amount: "250", reference: `OLD-${tag}` }];
    await page.evaluate(
      ([staleKey, versionKey, value]) => {
        const dayAgo = Date.now() - 25 * 60 * 60 * 1000;
        window.localStorage.setItem(staleKey, JSON.stringify({ v: 1, savedAt: dayAgo, value }));
        window.localStorage.setItem(
          versionKey,
          JSON.stringify({ v: 99, savedAt: Date.now(), value }),
        );
      },
      [billKey(stale.bill), billKey(versioned.bill), { rows, code: CODE }],
    );

    await reload(page);
    await expectEmptyPad(page);
    await expect(codeBox(page).getByLabel("Discount code", { exact: true })).toHaveValue("");
    expect(await stored(page, billKey(stale.bill))).toBeNull();
    expect(await stored(page, billKey(versioned.bill))).toBeNull();
  });
});
