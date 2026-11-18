import { test, expect } from "@playwright/test";
import { apiAs, loginAs } from "../helpers/auth.mjs";
import { one, query } from "../helpers/db.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { gstinCheckCharacter } from "../../shared/pharmacyVocab.js";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);

const TAG = `PH10${Date.now().toString(36).toUpperCase()}`;
const vendorName = (n) => `${TAG} ${n}`;

const gstin = (seed) => {
  const letters = seed
    .replace(/[^A-Z]/g, "")
    .padEnd(5, "X")
    .slice(0, 5);
  const digits = String(Date.now() + seed.length).slice(-4);
  const first14 = `03${letters}${digits}F1Z`;
  return `${first14}${gstinCheckCharacter(first14)}`;
};

const validVendor = (overrides = {}) => ({
  name: vendorName("Mohali Pharma Distributors"),
  contact_person: "Ramesh Kumar",
  phone: "9876543210",
  email: "orders@example.com",
  city: "Mohali",
  state: "Punjab",
  pincode: "160062",
  gstin: gstin("MOHAL"),
  pan: "ABCDE1234F",
  drug_license_no: "PB-MOH-20B-1234",
  drug_license_expiry: "2027-12-31",
  payment_terms_days: 30,
  bank_name: "HDFC Bank",
  bank_account: "50100012345678",
  ifsc: "HDFC0001234",
  ...overrides,
});

test.describe.configure({ mode: "serial" });

test.describe("PH10 pharmacy vendors", () => {
  let admin;
  let pharmacist;

  test.beforeAll(async () => {
    admin = await apiAs("pharmacy_admin");
    pharmacist = await apiAs("pharmacy");
  });

  test.afterAll(async () => {
    await admin?.dispose();
    await pharmacist?.dispose();
    await query(`DELETE FROM pharmacy_vendors WHERE name LIKE $1`, [`${TAG}%`]);
  });

  test("pharmacy admin creates a vendor and the change is audited", async () => {
    const response = await admin.post("/api/pharmacy/vendors", {
      data: validVendor(),
    });
    const body = await response.json();
    expect(response.status(), JSON.stringify(body)).toBe(201);
    expect(body).toMatchObject({
      name: vendorName("Mohali Pharma Distributors"),
      phone: "9876543210",
      payment_terms_days: 30,
      is_active: true,
      version: 1,
    });
    const audit = await one(
      `SELECT action, actor_id FROM billing_audit WHERE entity = 'pharmacy_vendors' AND entity_id = $1`,
      [String(body.id)],
    );
    expect(audit).toEqual({ action: "create", actor_id: 9011 });
  });

  test("input is cleaned before it is stored", async () => {
    const response = await admin.post("/api/pharmacy/vendors", {
      data: {
        name: `  ${vendorName("Clean Input Traders")}  `,
        phone: "98765 43211",
        gstin: gstin("CLEAN").toLowerCase(),
        email: "",
        pincode: "",
      },
    });
    const body = await response.json();
    expect(response.status(), JSON.stringify(body)).toBe(201);
    expect(body.name).toBe(vendorName("Clean Input Traders"));
    expect(body.phone).toBe("9876543211");
    expect(body.gstin).toBe(body.gstin.toUpperCase());
    expect(body.email).toBeNull();
    expect(body.pincode).toBeNull();
    expect(body.payment_terms_days).toBe(0);
  });

  test("invalid details are refused with messages that say how to fix them", async () => {
    const response = await admin.post("/api/pharmacy/vendors", {
      data: { name: "X", phone: "123", gstin: "BADGSTIN", ifsc: "HDFC1234", pan: "12345" },
    });
    expect(response.status()).toBe(400);
    const { error } = await response.json();
    expect(error).toContain("Vendor name must be at least 2 characters");
    expect(error).toContain("Phone must be 10 to 12 digits");
    expect(error).toContain("GSTIN must be 15 characters");

    const typo = await admin.post("/api/pharmacy/vendors", {
      data: { name: vendorName("Typo"), phone: "9876543299", gstin: "03ABCDE1234F1Z5" },
    });
    expect(typo.status()).toBe(400);
    expect((await typo.json()).error).toContain(
      "GSTIN has a typing mistake: its last character does not match",
    );
    expect(error).toContain("PAN must be 10 characters");
    expect(error).toContain("IFSC must be 11 characters");
  });

  test("unknown fields are refused", async () => {
    const response = await admin.post("/api/pharmacy/vendors", {
      data: { name: vendorName("Extra Field"), phone: "9876543212", is_active: false },
    });
    expect(response.status()).toBe(400);
  });

  test("a duplicate name or GSTIN is refused", async () => {
    const sameName = await admin.post("/api/pharmacy/vendors", {
      data: {
        name: vendorName("mohali pharma distributors").toUpperCase(),
        phone: "9876543213",
      },
    });
    expect(sameName.status()).toBe(409);
    expect((await sameName.json()).error).toBe("A vendor with this name already exists");

    const first = await one(`SELECT gstin FROM pharmacy_vendors WHERE name = $1`, [
      vendorName("Mohali Pharma Distributors"),
    ]);
    const sameGstin = await admin.post("/api/pharmacy/vendors", {
      data: { name: vendorName("Another Name"), phone: "9876543214", gstin: first.gstin },
    });
    expect(sameGstin.status()).toBe(409);
    expect((await sameGstin.json()).error).toBe("A vendor with this GSTIN already exists");
  });

  test("an edit needs the current version and bumps it", async () => {
    const vendor = await one(`SELECT id, version FROM pharmacy_vendors WHERE name = $1`, [
      vendorName("Mohali Pharma Distributors"),
    ]);
    const edit = await admin.put(`/api/pharmacy/vendors/${vendor.id}`, {
      data: { ...validVendor({ payment_terms_days: 45 }), gstin: null, version: vendor.version },
    });
    const body = await edit.json();
    expect(edit.status(), JSON.stringify(body)).toBe(200);
    expect(body.payment_terms_days).toBe(45);
    expect(body.version).toBe(vendor.version + 1);

    const stale = await admin.put(`/api/pharmacy/vendors/${vendor.id}`, {
      data: { ...validVendor({ payment_terms_days: 60 }), gstin: null, version: vendor.version },
    });
    expect(stale.status()).toBe(409);
    expect((await stale.json()).error).toMatch(/Someone else changed this vendor/);

    const audit = await one(
      `SELECT before->>'payment_terms_days' AS before, after->>'payment_terms_days' AS after
         FROM billing_audit
        WHERE entity = 'pharmacy_vendors' AND entity_id = $1 AND action = 'update'`,
      [String(vendor.id)],
    );
    expect(audit).toEqual({ before: "30", after: "45" });
  });

  test("deactivating hides the vendor from the active list and is audited", async () => {
    const vendor = await one(`SELECT id FROM pharmacy_vendors WHERE name = $1`, [
      vendorName("Clean Input Traders"),
    ]);
    const off = await admin.patch(`/api/pharmacy/vendors/${vendor.id}/active`, {
      data: { is_active: false },
    });
    expect(off.status()).toBe(200);
    expect((await off.json()).is_active).toBe(false);

    const active = await (
      await admin.get("/api/pharmacy/vendors", { params: { q: TAG, status: "active" } })
    ).json();
    expect(active.rows.map((v) => v.name)).not.toContain(vendorName("Clean Input Traders"));

    const inactive = await (
      await admin.get("/api/pharmacy/vendors", { params: { q: TAG, status: "inactive" } })
    ).json();
    expect(inactive.rows.map((v) => v.name)).toEqual([vendorName("Clean Input Traders")]);

    const audit = await one(
      `SELECT count(*)::int AS n FROM billing_audit
        WHERE entity = 'pharmacy_vendors' AND entity_id = $1 AND action = 'deactivate'`,
      [String(vendor.id)],
    );
    expect(audit.n).toBe(1);
  });

  test("search matches name, phone and city", async () => {
    for (const q of [TAG.toLowerCase(), "9876543210", "mohali"]) {
      const body = await (
        await admin.get("/api/pharmacy/vendors", { params: { q, status: "all" } })
      ).json();
      expect(body.rows.length, q).toBeGreaterThan(0);
    }
  });

  test("an unknown vendor id is a 404", async () => {
    expect((await admin.get("/api/pharmacy/vendors/999999999")).status()).toBe(404);
    expect((await admin.get("/api/pharmacy/vendors/abc")).status()).toBe(404);
    const edit = await admin.patch("/api/pharmacy/vendors/999999999/active", {
      data: { is_active: false },
    });
    expect(edit.status()).toBe(404);
  });

  test("the pharmacist cannot read or change vendors", async () => {
    expect((await pharmacist.get("/api/pharmacy/vendors")).status()).toBe(403);
    const create = await pharmacist.post("/api/pharmacy/vendors", {
      data: { name: vendorName("Not Allowed"), phone: "9876543215" },
    });
    expect(create.status()).toBe(403);
  });

  test("pharmacy admin adds, edits and deactivates a vendor from the page", async ({ page }) => {
    await loginAs(page, "pharmacy_admin");
    await gotoReady(page, "/pharmacy/vendors", () =>
      page.getByRole("heading", { name: "Vendors", exact: true }),
    );

    await page.getByRole("button", { name: "Add vendor" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Add vendor" });
    await expect(dialog).toBeVisible();

    await dialog.getByLabel("Vendor name").fill(vendorName("Screen Pharma"));
    await dialog.getByRole("textbox", { name: "Phone", exact: true }).fill("98765 43216");
    await dialog.getByLabel("GSTIN").fill("bad");
    await dialog.getByRole("button", { name: "Add vendor" }).click();
    await expect(dialog.getByText("Fix the highlighted fields, then save again.")).toBeVisible();
    await expect(dialog.getByLabel("GSTIN")).toHaveAttribute("aria-invalid", "true");

    await dialog.getByLabel("GSTIN").fill(gstin("SCREE"));
    await dialog.getByLabel("City").fill("Chandigarh");
    await dialog.getByRole("button", { name: "Add vendor" }).click();
    await expect(dialog).toBeHidden();

    await page.getByLabel("Search vendors").fill(vendorName("Screen"));
    const row = page.getByRole("row", { name: new RegExp(vendorName("Screen Pharma")) });
    await expect(row).toBeVisible();
    await expect(row).toContainText("9876543216");
    await expect(row).toContainText("Active");

    await row.getByRole("button", { name: `Edit ${vendorName("Screen Pharma")}` }).click();
    const editDialog = page.getByRole("dialog", { name: `Edit ${vendorName("Screen Pharma")}` });
    await editDialog.getByLabel("Payment terms (days)").fill("15");
    await editDialog.getByRole("button", { name: "Save vendor" }).click();
    await expect(editDialog).toBeHidden();
    await expect(row).toContainText("15 days");

    await row.getByRole("button", { name: `Deactivate ${vendorName("Screen Pharma")}` }).click();
    await page.getByRole("button", { name: "Deactivate vendor" }).click();
    await expect(row).toBeHidden();

    const stored = await one(
      `SELECT is_active, payment_terms_days FROM pharmacy_vendors WHERE name = $1`,
      [vendorName("Screen Pharma")],
    );
    expect(stored).toEqual({ is_active: false, payment_terms_days: 15 });
  });

  const pharmacyMenu = (page) => page.getByRole("button", { name: "Pharmacy", exact: true });

  const topEntries = (page) => page.locator(".tabs > .tab-btn, .tabs .tab-menu-btn");
  const menu = (page, name) => page.getByRole("button", { name, exact: true });

  test("the pharmacist sees daily pages as tabs and stock pages under Inventory, without vendors", async ({
    page,
  }) => {
    await loginAs(page, "pharmacy");
    const bills = () => page.getByRole("link", { name: "Pharmacy Bills", exact: true });
    await gotoReady(page, "/pharmacy/billing", bills);
    await expect(bills()).toBeVisible();
    await menu(page, "Inventory").click();
    await expect(page.getByRole("menuitem", { name: "Stock", exact: true })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Expiry", exact: true })).toBeVisible();
    await expect(page.getByText("Vendors", { exact: true })).toHaveCount(0);
    await expect(menu(page, "Setup")).toHaveCount(0);
    await expect(pharmacyMenu(page)).toHaveCount(0);
  });

  test("the pharmacy admin gets nine top-bar entries with related pages grouped", async ({
    page,
  }) => {
    await loginAs(page, "pharmacy_admin");
    const today = () => page.getByRole("link", { name: "Pharmacy Today", exact: true });
    await gotoReady(page, "/pharmacy/dashboard", today);
    await expect(topEntries(page)).toHaveText([
      "Pharmacy Today",
      /^Reports/,
      "Prescriptions",
      "Pharmacy Bills",
      "Pharmacy Credit",
      /^Inventory/,
      /^Setup/,
      "Medicine Collection",
      "Pharmacy Station",
    ]);
    await expect(page.locator(".tabs .tab-btn svg.tab-btn__icon")).toHaveCount(9);
    await expect(page.locator(".tabs")).toHaveCSS("scrollbar-width", "none");
    await expect(pharmacyMenu(page)).toHaveCount(0);

    await menu(page, "Setup").click();
    await expect(page.getByRole("menuitem")).toHaveText([
      "Vendors",
      "Medicines",
      "Departments",
      "Pharmacy Settings",
    ]);
    await page.getByRole("menuitem", { name: "Vendors", exact: true }).click();
    await expect(page).toHaveURL(/\/pharmacy\/vendors$/);
    await expect(page.locator(".tab-btn--active")).toHaveText([/^Setup/]);

    await menu(page, "Reports").click();
    await page.getByRole("menuitem", { name: "Top Selling Items", exact: true }).click();
    await expect(page.locator(".tab-btn--active")).toHaveText([/^Reports/]);
    await menu(page, "Reports").click();
    await expect(page.locator(".tab-menu-item--active")).toHaveText(["Top Selling Items"]);
  });

  test("the main admin still gets the pharmacy pages folded under one menu", async ({ page }) => {
    await loginAs(page, "admin");
    await gotoReady(page, "/pharmacy/vendors", () => pharmacyMenu(page).first());
    await expect(page.getByRole("link", { name: "Vendors", exact: true })).toHaveCount(0);
    await pharmacyMenu(page).first().click();
    await expect(page.getByRole("menuitem", { name: "Vendors", exact: true })).toBeVisible();
  });
});
