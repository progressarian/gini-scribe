import { test, expect } from "@playwright/test";
import { getPool, query } from "../../helpers/db.mjs";
import { loginAs } from "../../helpers/auth.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { fromPaise } from "../../../src/components/billing/format.js";
import { desk, extraVisit, newTag, payRule, setUp, tearDown } from "./p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");
const shifts = await import("../../../server/services/billing/cashShifts.js");

const db = getPool();
const tag = newTag();
const payments = await import("../../../server/services/billing/payments.js");
let ids;
let later;
let free;
let payLaterBefore = null;

const setPayLater = (on) => query(`UPDATE billing_settings SET allow_pay_later = $1`, [on]);

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

const pad = (page) => page.getByRole("region", { name: "Totals and payment" });

const totalRow = (page, label) =>
  pad(page)
    .getByRole("row")
    .filter({ has: page.getByRole("rowheader", { name: label, exact: true }) });

const finaliseButton = (page) => page.getByRole("button", { name: "Finalise & print" });

const closeShifts = () =>
  query(`DELETE FROM cash_shifts WHERE user_id = $1`, [USERS.reception.id]).catch(() => {});

const GST_COLUMNS = `gst_enabled, gstin, state_code, legal_name`;
let gstBefore = null;

const readGst = async () =>
  (await query(`SELECT ${GST_COLUMNS} FROM billing_settings`)).rows[0] ?? null;

const writeGst = (row) =>
  query(
    `UPDATE billing_settings
        SET gst_enabled = $1, gstin = $2, state_code = $3, legal_name = $4`,
    [row.gst_enabled, row.gstin, row.state_code, row.legal_name],
  );

const restoreGst = () =>
  writeGst(
    gstBefore ?? { gst_enabled: false, gstin: null, state_code: null, legal_name: null },
  ).catch(() => {});

test.describe.serial("P4-32 totals and payment", () => {
  test.describe.configure({ retries: 1 });

  test.beforeAll(async () => {
    gstBefore = await readGst();
    payLaterBefore =
      (await query(`SELECT allow_pay_later FROM billing_settings`)).rows[0]?.allow_pay_later ??
      false;
    ids = await setUp(tag);
    await payRule(ids, ids.pensioner, { name: "pensioner pays nothing", patient_pays: "nothing" });

    ids.bill = (await bills.openDraft(ids.visit, desk, db)).id;
    await bills.addLine(ids.bill, { item_id: ids.dressing }, desk, db);
    await bills.setCategory(ids.bill, { category: ids.paid }, desk, db);

    free = await extraVisit(ids, "Free");
    free.bill = (await bills.openDraft(free.visit, desk, db)).id;
    await bills.addLine(free.bill, { item_id: ids.dressing }, desk, db);
    await bills.setCategory(free.bill, { category: ids.pensioner }, desk, db);

    later = await extraVisit(ids, "Later");
    later.bill = (await bills.openDraft(later.visit, desk, db)).id;
    await bills.addLine(later.bill, { item_id: ids.brace }, desk, db);
    await bills.setCategory(later.bill, { category: ids.paid }, desk, db);

    await closeShifts();
  });

  test.afterAll(async () => {
    await closeShifts();
    await restoreGst();
    await tearDown(ids);
    await setPayLater(payLaterBefore).catch(() => {});
  });

  test("1. every total on screen is the total the server holds", async ({ page }) => {
    await loginAs(page, "reception");
    await open(page, ids.visit);
    const bill = await bills.readBill(ids.bill, db);
    const shown = [
      ["Actual", bill.totals.actual],
      ["Discount", bill.totals.discount],
      ["Patient payable", bill.totals.payable],
      ["Claimed", bill.totals.claim],
      ["Adjustment", bill.totals.adjustment],
      ["Round-off", bill.totals.round_off],
      ["Paid", bill.totals.paid],
      ["Balance", bill.totals.payable - bill.totals.paid],
    ];
    for (const [label, amount] of shown) {
      await expect(totalRow(page, label).getByRole("cell")).toHaveText(fromPaise(amount));
    }
    await expect(totalRow(page, "Tax")).toHaveCount(0);
  });

  test("2. the tax row appears only when GST is switched on", async ({ page }) => {
    await writeGst({
      gst_enabled: true,
      gstin: "03ABCDE1234F1Z5",
      state_code: "03",
      legal_name: "P4-32 Hospital",
    });
    try {
      await loginAs(page, "reception");
      await open(page, ids.visit);
      await expect(totalRow(page, "Tax")).toHaveCount(1);
    } finally {
      await restoreGst();
    }
  });

  test("3. cash without an open shift is refused, and the pad says where to open one", async ({
    page,
  }) => {
    await closeShifts();
    await loginAs(page, "reception");
    await open(page, ids.visit);
    await expect(pad(page).getByText("No shift is open", { exact: false })).toBeVisible();
    await expect(pad(page).getByLabel("Opening cash")).toHaveCount(0);

    await pad(page).getByLabel("Amount").fill("500");
    await pad(page).getByRole("button", { name: "Take payment" }).click();
    await expect(pad(page).getByText("Open your shift first", { exact: false })).toBeVisible();

    await shifts.openShift({ opening_cash: 1000 }, desk, db);
    await open(page, ids.visit);
    await expect(pad(page).getByText("No shift is open", { exact: false })).toHaveCount(0);
  });

  test("4. Finalise is enabled only once the finalise checks would pass", async ({ page }) => {
    await loginAs(page, "reception");
    await open(page, ids.visit);
    await expect(totalRow(page, "Balance").getByRole("cell")).toHaveText(fromPaise(50000));
    await expect(finaliseButton(page)).toBeDisabled();

    await pad(page).getByLabel("Amount").fill("300");
    await expect(pad(page).getByText(`Remaining ${fromPaise(20000)}`)).toBeVisible();
    await pad(page).getByLabel("Amount").fill("500");
    await expect(pad(page).getByText(`Remaining ${fromPaise(0)}`)).toBeVisible();
    await pad(page).getByRole("button", { name: "Take payment" }).click();

    await expect(totalRow(page, "Paid").getByRole("cell")).toHaveText(fromPaise(50000));
    await expect(totalRow(page, "Balance").getByRole("cell")).toHaveText(fromPaise(0));
    await expect(finaliseButton(page)).toBeEnabled();
    const saved = await bills.readBill(ids.bill, db);
    expect(saved.totals.paid).toBe(50000);
  });

  test("5. pay later is offered only where it is allowed", async ({ page }) => {
    await loginAs(page, "reception");
    await open(page, later.visit);
    await expect(pad(page).getByLabel("Pay later")).toHaveCount(0);
    await expect(finaliseButton(page)).toBeDisabled();

    await query(`UPDATE patient_schemes SET allow_pay_later = TRUE WHERE code = $1`, [ids.paid]);
    try {
      await open(page, later.visit);
      await pad(page).getByLabel("Pay later").check();
      await expect(finaliseButton(page)).toBeEnabled();
    } finally {
      await query(`UPDATE patient_schemes SET allow_pay_later = NULL WHERE code = $1`, [ids.paid]);
    }
  });

  test("6. a bill with nothing to pay finalises without a payment and shows CGHS pending", async ({
    page,
  }) => {
    await loginAs(page, "reception");
    await open(page, free.visit);
    await expect(totalRow(page, "Patient payable").getByRole("cell")).toHaveText(fromPaise(0));
    await expect(pad(page).getByText("No payment is needed on this bill")).toBeVisible();
    await expect(pad(page).getByLabel("Amount")).toHaveCount(0);
    await expect(finaliseButton(page)).toBeEnabled();

    const popup = page.waitForEvent("popup").catch(() => null);
    await finaliseButton(page).click();
    await expect(page.getByText("CGHS pending")).toBeVisible();
    await popup;

    const saved = await bills.readBill(free.bill, db);
    expect(saved.status).toBe("final");
    expect(saved.claim_status).toBe("pending");
    expect(saved.totals.paid).toBe(0);
    expect(
      (await query(`SELECT id FROM payments WHERE bill_id = $1`, [free.bill])).rows,
    ).toHaveLength(0);
  });

  test("7. pay later follows the parent category, not the setting alone", async ({ page }) => {
    const bill = await freshBill("Parent", ids.brace, ids.paid);
    await setPayLater(true);
    await query(`UPDATE patient_schemes SET allow_pay_later = FALSE WHERE code = $1`, [ids.parent]);
    try {
      await loginAs(page, "reception");
      await open(page, bill.visit);
      await expect(pad(page).getByLabel("Pay later")).toHaveCount(0);
      await expect(finaliseButton(page)).toBeDisabled();
    } finally {
      await query(`UPDATE patient_schemes SET allow_pay_later = NULL WHERE code = $1`, [
        ids.parent,
      ]);
      await setPayLater(payLaterBefore);
    }
  });

  test("8. a payment refused as stale re-reads the bill, so the next one is taken", async ({
    page,
  }) => {
    const bill = await freshBill("Stale", ids.dressing, ids.paid);
    await loginAs(page, "reception");
    await open(page, bill.visit);
    await expect(totalRow(page, "Balance").getByRole("cell")).toHaveText(fromPaise(50000));

    const held = await bills.readBill(bill.bill, db);
    await payments.takePayments(
      bill.bill,
      { version: held.version, payments: [{ mode: "card", amount: "100", reference: "P4-32-8" }] },
      desk,
      db,
    );

    await pad(page).getByLabel("Mode").selectOption("card");
    await pad(page).getByLabel("Amount").fill("400");
    await pad(page).getByLabel("Reference").fill("P4-32-8B");
    await pad(page).getByRole("button", { name: "Take payment" }).click();
    await expect(
      pad(page).getByText("changed while you were working", { exact: false }),
    ).toBeVisible();
    await expect(totalRow(page, "Paid").getByRole("cell")).toHaveText(fromPaise(10000));

    await pad(page).getByLabel("Mode").selectOption("card");
    await pad(page).getByLabel("Amount").fill("400");
    await pad(page).getByLabel("Reference").fill("P4-32-8B");
    await pad(page).getByRole("button", { name: "Take payment" }).click();
    await expect(pad(page).getByText("Payment taken")).toBeVisible();
    expect((await bills.readBill(bill.bill, db)).totals.paid).toBe(50000);
  });

  test("9. pay later is not carried from one patient to the next", async ({ page }) => {
    const one = await freshBill("Ticked", ids.brace, ids.paid);
    const two = await freshBill("Untouched", ids.brace, ids.paid);
    await setPayLater(true);
    try {
      await loginAs(page, "reception");
      await open(page, one.visit);
      await pad(page).getByLabel("Pay later").check();
      await expect(finaliseButton(page)).toBeEnabled();

      await page.getByRole("button", { name: `P4 Untouched ${tag}` }).click();
      await expect(page.getByRole("heading", { name: `P4 Untouched ${tag}` })).toBeVisible();
      await expect(pad(page).getByLabel("Pay later")).not.toBeChecked();
      await expect(finaliseButton(page)).toBeDisabled();
      expect(page.url()).toContain(`visit=${two.visit}`);
    } finally {
      await setPayLater(payLaterBefore);
    }
  });

  test("10. a payment taken but not read back says so, rather than looking untaken", async ({
    page,
  }) => {
    const bill = await freshBill("Cutoff", ids.dressing, ids.paid);
    await loginAs(page, "reception");
    await open(page, bill.visit);
    await page.route(
      (url) => /\/api\/billing\/bills\/[0-9a-f-]+$/.test(url.pathname),
      (route) => route.abort(),
    );

    await pad(page).getByLabel("Mode").selectOption("upi");
    await pad(page).getByLabel("Amount").fill("500");
    await pad(page).getByLabel("Reference").fill("P4-32-10");
    await pad(page).getByRole("button", { name: "Take payment" }).click();

    await expect(pad(page).getByText("The payment was taken", { exact: false })).toBeVisible();
    await page.unroute((url) => /\/api\/billing\/bills\/[0-9a-f-]+$/.test(url.pathname));
    expect((await bills.readBill(bill.bill, db)).totals.paid).toBe(50000);
  });
});
