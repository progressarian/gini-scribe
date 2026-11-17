import { test, expect } from "@playwright/test";
import { apiAs, loginAs } from "../helpers/auth.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { one, query } from "../helpers/db.mjs";
import { USERS } from "../fixtures/data.mjs";
import { financialYearOf } from "../../shared/billingVocab.js";
import { assertTestDatabase } from "../setup/guard.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);

const STAMP = Date.now().toString(36).toUpperCase();
const TAG = `PH51${STAMP}`;
const dayOffset = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
};
const FY = financialYearOf(dayOffset(0));

const closeReceptionShifts = () =>
  query(
    `UPDATE cash_shifts
        SET closed_at = NOW(), expected_cash = opening_cash, counted_cash = opening_cash,
            difference = 0
      WHERE closed_at IS NULL AND user_id = $1`,
    [USERS.reception.id],
  );

test.describe.configure({ mode: "serial" });

test.describe("PH51 transfer, indent and reception screens", () => {
  let admin;
  let pharmacist;
  let reception;
  let ward;
  let medicine;
  let patient;

  test.beforeAll(async () => {
    admin = await apiAs("pharmacy_admin");
    pharmacist = await apiAs("pharmacy");
    reception = await apiAs("reception");
    for (const [series, prefix] of [
      ["PH", "PH/"],
      ["PHR", "PHR/"],
      ["PHCN", "PHCN/"],
    ]) {
      await admin.put("/api/pharmacy/settings/series", {
        data: { series, fy: FY, prefix, number_width: 6 },
      });
    }
    ward = await (
      await admin.post("/api/pharmacy/locations", {
        data: { code: `W${STAMP}`.slice(0, 20), name: `${TAG} Ward` },
      })
    ).json();
    medicine = await (
      await admin.post("/api/pharmacy/medicines", {
        data: {
          name: `${TAG} Ceftriaxone 1g`,
          form: "INJ",
          pack_size: 1,
          unit_label: "vial",
          pack_label: "vial",
          gst_rate_pct: 12,
        },
      })
    ).json();
    const receipt = await (
      await admin.post("/api/pharmacy/purchases", { data: { kind: "opening" } })
    ).json();
    const saved = await (
      await admin.put(`/api/pharmacy/purchases/${receipt.id}`, {
        data: {
          version: receipt.version,
          lines: [
            {
              medicine_id: medicine.id,
              batch_no: "CEF1",
              expiry_date: dayOffset(400),
              qty_packs: 40,
              purchase_rate: "40",
              gst_rate_pct: 12,
              mrp: "80",
              sale_rate: "50",
              rack_no: "R-9",
            },
          ],
        },
      })
    ).json();
    await admin.post(`/api/pharmacy/purchases/${receipt.id}/post`, {
      data: { version: saved.version },
    });
    patient = (
      await (
        await pharmacist.post("/api/pharmacy/bills/patients", {
          data: { name: `${TAG} Ward Patient`, phone: `92${String(Date.now()).slice(-8)}` },
        })
      ).json()
    ).patient;
    await closeReceptionShifts();
  });

  test.afterAll(async () => {
    await closeReceptionShifts();
    await Promise.all([admin?.dispose(), pharmacist?.dispose(), reception?.dispose()]);
  });

  test("the pharmacy admin restocks the ward from the main pharmacy", async ({ page }) => {
    await loginAs(page, "pharmacy_admin");
    await gotoReady(
      page,
      "/pharmacy/transfers",
      () => page.getByRole("heading", { name: "Stock transfers" }),
      { timeout: 30000 },
    );
    await page.getByRole("combobox", { name: /^To/ }).selectOption({ label: `${TAG} Ward` });
    await page.getByRole("combobox", { name: "Add medicine" }).fill(TAG);
    await page.getByRole("option", { name: new RegExp(`${TAG} Ceftriaxone`) }).click();
    const picker = page.getByRole("dialog", { name: /Choose batches/ });
    await picker.getByLabel("Quantity from batch CEF1").fill("15");
    await picker.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByRole("table", { name: "Medicines to move" })).toContainText("15 vial");
    await page.getByRole("button", { name: "Move stock" }).click();
    const confirm = page.getByRole("dialog").filter({ hasText: "Move this stock?" });
    await expect(confirm).toContainText(`${TAG} Ward`);
    await confirm.getByRole("button", { name: "Move stock" }).click();
    await expect(page.getByRole("table", { name: "Stock transfers" })).toContainText(`${TAG} Ward`);
    const stock = await one(
      `SELECT qty_units FROM pharmacy_stock s JOIN pharmacy_batches b ON b.id = s.batch_id
        WHERE b.medicine_id = $1 AND s.location_id = $2`,
      [medicine.id, ward.id],
    );
    expect(stock.qty_units).toBe(15);
  });

  test("a nurse issues an indent from the ward stock", async ({ page }) => {
    await loginAs(page, "nurse");
    await gotoReady(
      page,
      "/pharmacy/indents",
      () => page.getByRole("heading", { name: "Department indents" }),
      { timeout: 30000 },
    );
    await page
      .getByRole("combobox", { name: /^Department/ })
      .selectOption({ label: `${TAG} Ward` });
    await page.getByLabel("IPD number").fill("IPD-909");
    await page.getByLabel("Find patient").fill(TAG);
    await page.getByRole("radio", { name: new RegExp(`${TAG} Ward Patient`) }).check();
    await page.getByRole("combobox", { name: "Add medicine" }).fill(TAG);
    await page.getByRole("option", { name: new RegExp(`${TAG} Ceftriaxone`) }).click();
    const picker = page.getByRole("dialog", { name: /Choose batches/ });
    await picker.getByLabel("Quantity from batch CEF1").fill("4");
    await picker.getByRole("button", { name: "Add", exact: true }).click();
    await page.getByRole("button", { name: "Issue indent" }).click();
    await page
      .getByRole("dialog")
      .filter({ hasText: "Issue this indent?" })
      .getByRole("button", { name: "Issue indent" })
      .click();
    await expect(page.getByText(/Last issued: IND\d{6}/)).toBeVisible();
    await expect(page.getByRole("table", { name: "Indents" })).toContainText("₹224.00");
  });

  test("the nurse returns an unused vial and the bill goes down", async ({ page }) => {
    await loginAs(page, "nurse");
    await gotoReady(
      page,
      "/pharmacy/indents",
      () => page.getByRole("heading", { name: "Department indents" }),
      { timeout: 30000 },
    );
    const row = page.getByRole("row").filter({ hasText: `${TAG} Ward Patient` });
    await row.getByRole("button", { name: /Return medicines from IND/ }).click();
    const dialog = page.getByRole("dialog", { name: /Return medicines/ });
    await dialog.getByLabel(`Returning ${TAG} Ceftriaxone 1g batch CEF1`).fill("1");
    await dialog.getByLabel("Reason").fill("Dose stopped");
    await expect(dialog.getByText("₹56.00 taken off the due")).toBeVisible();
    await expect(dialog.getByLabel("Refund by")).toHaveCount(0);
    await dialog.getByRole("button", { name: "Review return" }).click();
    await dialog.getByRole("button", { name: "Confirm return" }).click();
    await expect(dialog).toBeHidden();
    await expect(row).toContainText("₹168.00");
  });

  test("reception collects the indent bill from the Pharmacy bills tab", async ({ page }) => {
    const opened = await reception.post("/api/billing/shifts/open", {
      data: { opening_cash: 0 },
    });
    expect(opened.status(), await opened.text()).toBe(201);
    await loginAs(page, "reception");
    await gotoReady(
      page,
      "/giniflow/station/reception?tab=pharmacy",
      () => page.getByRole("heading", { name: "Pharmacy bills to collect" }),
      { timeout: 30000 },
    );
    await page.getByLabel("Search pharmacy bills").fill(TAG);
    const row = page.getByRole("row").filter({ hasText: `${TAG} Ward Patient` });
    await expect(row).toContainText("₹168.00");
    await row.getByRole("button", { name: /Collect pharmacy bill/ }).click();
    const dialog = page.getByRole("dialog", { name: /Collect pharmacy bill/ });
    await dialog.getByRole("button", { name: "Collect ₹168.00" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("No pharmacy bills match the search.")).toBeVisible();

    await page.getByRole("tab", { name: "Shift" }).click();
    await expect(page.getByRole("row", { name: /Pharmacy cash collected/ })).toContainText("168");
  });
});
