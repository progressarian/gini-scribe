import { test, expect } from "@playwright/test";
import { apiAs, loginAs } from "../helpers/auth.mjs";
import { one, query } from "../helpers/db.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { gstinCheckCharacter } from "../../shared/pharmacyVocab.js";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);

const GSTIN = `03AAPFU0939F1Z${gstinCheckCharacter("03AAPFU0939F1Z")}`;

const DEFAULTS = {
  legal_name: null,
  gstin: null,
  drug_license_no: null,
  address: null,
  phone: null,
  bill_footer: null,
  sale_rate_includes_gst: false,
  near_expiry_warn_days: 30,
  expiry_alert_days: 90,
  stock_source: "darpan",
};

const current = () => one(`SELECT * FROM pharmacy_settings WHERE id`);

test.describe.configure({ mode: "serial" });

test.describe("PH14 pharmacy settings", () => {
  let admin;
  let pharmacist;

  test.beforeAll(async () => {
    admin = await apiAs("pharmacy_admin");
    pharmacist = await apiAs("pharmacy");
  });

  test.afterAll(async () => {
    await Promise.all([admin?.dispose(), pharmacist?.dispose()]);
    const row = await current();
    await query(
      `UPDATE pharmacy_settings SET legal_name = NULL, gstin = NULL, drug_license_no = NULL,
              address = NULL, phone = NULL, bill_footer = NULL, sale_rate_includes_gst = FALSE,
              near_expiry_warn_days = 30, expiry_alert_days = 90, stock_source = 'darpan', version = $1
        WHERE id`,
      [row.version + 1],
    );
  });

  test("the settings row exists with safe defaults and cannot be deleted", async () => {
    const response = await admin.get("/api/pharmacy/settings");
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject(DEFAULTS);
    await expect(query(`DELETE FROM pharmacy_settings`)).rejects.toThrow(/keeps its one row/);
  });

  test("the admin saves the bill header and rules, and the change is audited", async () => {
    const { version } = await current();
    const response = await admin.put("/api/pharmacy/settings", {
      data: {
        ...DEFAULTS,
        legal_name: "Gini Pharmacy LLP",
        gstin: GSTIN.toLowerCase(),
        drug_license_no: "20B-1234, 21B-1235",
        phone: "0172 400 1234",
        sale_rate_includes_gst: true,
        near_expiry_warn_days: 45,
        expiry_alert_days: 120,
        version,
      },
    });
    const body = await response.json();
    expect(response.status(), JSON.stringify(body)).toBe(200);
    expect(body).toMatchObject({
      legal_name: "Gini Pharmacy LLP",
      gstin: GSTIN,
      phone: "01724001234",
      sale_rate_includes_gst: true,
      near_expiry_warn_days: 45,
      version: version + 1,
    });
    const audit = await one(
      `SELECT before->>'legal_name' AS before, after->>'legal_name' AS after
         FROM billing_audit WHERE entity = 'pharmacy_settings' ORDER BY id DESC LIMIT 1`,
    );
    expect(audit).toEqual({ before: null, after: "Gini Pharmacy LLP" });
  });

  test("bad values and stale edits are refused", async () => {
    const { version } = await current();
    const bad = await admin.put("/api/pharmacy/settings", {
      data: {
        ...DEFAULTS,
        gstin: "03AAPFU0939F1Z0",
        near_expiry_warn_days: 60,
        expiry_alert_days: 30,
        version,
      },
    });
    expect(bad.status()).toBe(400);
    const { error } = await bad.json();
    expect(error).toContain("GSTIN has a typing mistake");
    expect(error).toContain(
      "Expiry alert (days) cannot be fewer days than the near-expiry warning",
    );

    const stale = await admin.put("/api/pharmacy/settings", {
      data: { ...DEFAULTS, version: version - 1 },
    });
    expect(stale.status()).toBe(409);
  });

  test("the pharmacist cannot read or change the settings", async () => {
    expect((await pharmacist.get("/api/pharmacy/settings")).status()).toBe(403);
    const { version } = await current();
    const write = await pharmacist.put("/api/pharmacy/settings", {
      data: { ...DEFAULTS, version },
    });
    expect(write.status()).toBe(403);
  });

  test("the admin changes the expiry warning from the page", async ({ page }) => {
    await loginAs(page, "pharmacy_admin");
    await gotoReady(page, "/pharmacy/settings", () =>
      page.getByRole("heading", { name: "Pharmacy settings", exact: true }),
    );
    const save = page.getByRole("button", { name: "Save settings" });
    await expect(save).toBeDisabled();

    const warn = page.getByRole("textbox", { name: "Near-expiry warning (days)" });
    await warn.fill("200");
    await save.click();
    await expect(
      page.getByText("This cannot be fewer days than the near-expiry warning."),
    ).toBeVisible();

    await warn.fill("60");
    await page.getByRole("checkbox", { name: "Sale rates already include GST" }).uncheck();
    await save.click();
    await expect(page.getByText(/Last changed by E2E Pharmacy Admin/)).toBeVisible();
    await expect(save).toBeDisabled();

    expect(await current()).toMatchObject({
      near_expiry_warn_days: 60,
      sale_rate_includes_gst: false,
    });
  });
});
