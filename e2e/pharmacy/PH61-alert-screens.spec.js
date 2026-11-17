import { test, expect } from "@playwright/test";
import { apiAs, loginAs } from "../helpers/auth.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { one, query } from "../helpers/db.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { pickOption } from "../helpers/pickers.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);

const TAG = `PH61${Date.now().toString(36).toUpperCase()}`;
const dayOffset = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
};

test.describe.configure({ mode: "serial" });

test.describe("PH61 the notifications bell and the expiry page", () => {
  let admin;
  let medicine;
  let vendor;

  test.beforeAll(async () => {
    admin = await apiAs("pharmacy_admin");
    vendor = await (
      await admin.post("/api/pharmacy/vendors", {
        data: { name: `${TAG} Medi Supply`, phone: "9812345678" },
      })
    ).json();
    medicine = await (
      await admin.post("/api/pharmacy/medicines", {
        data: {
          name: `${TAG} Thyronorm 50`,
          form: "TAB",
          pack_size: 10,
          unit_label: "tab",
          pack_label: "strip",
          gst_rate_pct: 12,
          min_stock_units: 100,
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
              batch_no: "THY1",
              expiry_date: dayOffset(300),
              qty_packs: 2,
              purchase_rate: "20",
              gst_rate_pct: 12,
              mrp: "40",
              sale_rate: "35",
            },
          ],
        },
      })
    ).json();
    await admin.post(`/api/pharmacy/purchases/${receipt.id}/post`, {
      data: { version: saved.version },
    });
    const main = await one(`SELECT id FROM pharmacy_locations WHERE kind = 'main'`);
    const old = await one(
      `INSERT INTO pharmacy_batches (medicine_id, batch_no, expiry_date, pack_size, mrp, sale_rate,
                                     purchase_rate, gst_rate_pct, vendor_id)
       VALUES ($1, 'THY0', $2, 10, 40, 35, 20, 12, $3) RETURNING id`,
      [medicine.id, dayOffset(-10), vendor.id],
    );
    await query(
      `INSERT INTO pharmacy_stock (location_id, batch_id, qty_units) VALUES ($1, $2, 7)`,
      [main.id, old.id],
    );
    await query(
      `INSERT INTO pharmacy_stock_movements (location_id, batch_id, medicine_id, kind, delta_units, balance_after)
       VALUES ($1, $2, $3, 'opening', 7, 7)`,
      [main.id, old.id, medicine.id],
    );
  });

  test.afterAll(async () => {
    await admin?.dispose();
  });

  test("the bell shows the low-stock alert and opens the stock list on it", async ({ page }) => {
    await loginAs(page, "pharmacy_admin");
    await gotoReady(page, "/pharmacy/expiry", () => page.getByRole("heading", { name: "Expiry" }), {
      timeout: 30000,
    });
    await page.getByRole("button", { name: /^Notifications, \d+ unread$/ }).click();
    const panel = page.getByRole("dialog", { name: "Notifications" });
    const item = panel.getByRole("button", { name: new RegExp(`Low stock: ${TAG} Thyronorm`) });
    await expect(item).toContainText("20 tab left at the main pharmacy; the minimum is 100");
    await item.click();
    await expect(page).toHaveURL(/\/pharmacy\/stock\?location_id=\d+&q=.*&filter=low/);
    await expect(page.getByText(`${TAG} Thyronorm 50`).first()).toBeVisible();
  });

  test("an expired batch is returned to its vendor from the expiry page", async ({ page }) => {
    await loginAs(page, "pharmacy_admin");
    await gotoReady(
      page,
      "/pharmacy/expiry?bucket=expired",
      () => page.getByRole("heading", { name: "Expiry" }),
      { timeout: 30000 },
    );
    await page.getByLabel("Search batches").fill(TAG);
    const row = page.getByRole("row").filter({ hasText: "THY0" });
    await expect(row).toContainText("Expired 10 days ago");
    await expect(row).toContainText(`${TAG} Medi Supply`);
    await row.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Return to vendor (1)" }).click();
    const dialog = page.getByRole("dialog", { name: "Return to vendor" });
    await expect(dialog.getByRole("button", { name: /^Vendor/ })).toContainText(vendor.name);
    await expect(dialog.getByRole("button", { name: /^Reason/ })).toContainText("Expired");
    await dialog.getByLabel("Vendor credit note / reference").fill("VCN-55");

    await dialog.getByRole("button", { name: "Cancel" }).click();
    await dialog.getByRole("button", { name: "Keep editing" }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("Vendor credit note / reference")).toHaveValue("VCN-55");
    const kept = await one(
      `SELECT count(*)::int AS n FROM pharmacy_vendor_returns WHERE vendor_id = $1`,
      [vendor.id],
    );
    expect(kept.n).toBe(0);

    await dialog.getByRole("button", { name: "Return stock worth ₹14.00" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("Nothing expired or expiring in this view.")).toBeVisible();
    await expect(page.getByRole("table", { name: "Recent vendor returns" })).toContainText(
      "VCN-55",
    );
  });
});
