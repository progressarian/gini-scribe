import crypto from "node:crypto";
import { test, expect } from "@playwright/test";
import { apiAs, loginAs } from "../../helpers/auth.mjs";
import { one, query } from "../../helpers/db.mjs";
import { buildCatalogTest } from "../../helpers/builders.mjs";
import { gotoReady } from "../../helpers/browser.mjs";

const tag = crypto.randomBytes(3).toString("hex");
const TEST_NAME = `P130 Ferritin ${tag}`;
const OFF_TEST_NAME = `P130 Lipase ${tag}`;
const DOCTOR = `Dr P130 ${tag}`;
const REPORT = `P130 Report ${tag}`;
const seed = {};

const dialog = (page) => page.getByRole("dialog");
const viewSwitch = (page) => page.getByRole("group", { name: "Services view" });
const field = (page, label) => dialog(page).getByLabel(label, { exact: true });
const tests = (page) => page.getByRole("table", { name: "Tests without an item" });
const consultants = (page) => page.getByRole("table", { name: "Consultants without a fee" });
const reports = (page) => page.getByRole("table", { name: "Lab reports not in the catalogue" });

const LIST_TAB = {
  tests: /^\d+\s*Tests without an item/,
  consultants: /^\d+\s*Consultants without a fee/,
  reports: /^\d+\s*Lab reports not in the catalogue/,
};

async function showList(page, list, needle) {
  await page
    .getByRole("tablist", { name: "Not priced lists" })
    .getByRole("tab", { name: LIST_TAB[list] })
    .click();
  await page.getByRole("searchbox", { name: "Search this list" }).fill(needle);
}

async function openNotPriced(page) {
  await loginAs(page, "reception_admin");
  await gotoReady(page, "/settings/services", () =>
    viewSwitch(page).getByRole("button", { name: /^Not priced/ }),
  );
  await viewSwitch(page)
    .getByRole("button", { name: /^Not priced/ })
    .click();
  await expect(page.getByRole("tablist", { name: "Not priced lists" })).toBeVisible();
}

test.describe.serial("P1-30 not priced tab", () => {
  test.describe.configure({ retries: 1 });

  test.beforeAll(async () => {
    const api = await apiAs("admin");
    const group = await (
      await api.post("/api/billing/master/groups", {
        data: { code: `P130G_${tag}`, name: `P130 Group ${tag}` },
      })
    ).json();
    seed.subgroup = await (
      await api.post("/api/billing/master/subgroups", {
        data: { group_id: group.id, code: `P130S_${tag}`, name: `P130 Sub ${tag}` },
      })
    ).json();
    seed.test = await buildCatalogTest({ test_name: TEST_NAME, price: 320 });
    seed.offTest = await buildCatalogTest({ test_name: OFF_TEST_NAME, price: 500 });
    const offItem = await (
      await api.post("/api/billing/master/items", {
        data: {
          code: `P130OFF_${tag}`,
          name: OFF_TEST_NAME,
          subgroup_id: seed.subgroup.id,
          base_price: 500,
          kind: "test",
          test_catalog_id: seed.offTest.id,
        },
      })
    ).json();
    await api.put(`/api/billing/master/items/${offItem.id}/active`, {
      data: { is_active: false },
    });
    await api.dispose();
    seed.doctor = await one(
      `INSERT INTO doctors (name, role, pin, is_active) VALUES ($1, 'consultant', 'x', TRUE) RETURNING id`,
      [DOCTOR],
    );
    seed.report = await one(
      `INSERT INTO lab_report_catalog (name, aliases, is_active) VALUES ($1, '{}', TRUE) RETURNING id`,
      [REPORT],
    );
  });

  test.afterAll(async () => {
    await query(
      `DELETE FROM service_item_price_history WHERE service_item_id IN
         (SELECT id FROM service_items WHERE code LIKE $1)`,
      [`P130%${tag}`],
    );
    await query(`DELETE FROM service_items WHERE code LIKE $1`, [`P130%${tag}`]);
    await query(`DELETE FROM service_subgroups WHERE code LIKE $1`, [`P130%${tag}`]);
    await query(`DELETE FROM service_groups WHERE code LIKE $1`, [`P130%${tag}`]);
    for (const t of [seed.test, seed.offTest].filter(Boolean)) {
      await query(`DELETE FROM giniflow_test_catalog WHERE id = $1`, [t.id]);
    }
    if (seed.doctor) await query(`DELETE FROM doctors WHERE id = $1`, [seed.doctor.id]);
    if (seed.report) await query(`DELETE FROM lab_report_catalog WHERE id = $1`, [seed.report.id]);
  });

  test("1. the tab shows the P1-18 list with its count", async ({ page }) => {
    const api = await apiAs("reception_admin");
    const list = await (await api.get("/api/billing/master/items/not-priced")).json();
    await api.dispose();
    await openNotPriced(page);
    await expect(viewSwitch(page).getByRole("button", { name: /^Not priced/ })).toHaveText(
      `Not priced · ${list.tests.length + list.consultants.length}`,
    );
    await expect(viewSwitch(page).getByRole("button", { name: /^Not priced/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await showList(page, "tests", TEST_NAME);
    const row = tests(page).getByRole("row", { name: new RegExp(TEST_NAME) });
    await expect(row).toContainText("₹320");
    await expect(row).toContainText("No item");
    await showList(page, "consultants", DOCTOR);
    for (const visit of ["New", "Follow Up"]) {
      await expect(
        consultants(page).getByRole("button", {
          name: `Create item for ${DOCTOR} (${visit})`,
          exact: true,
        }),
      ).toBeVisible();
    }
    const report = list.reportsNotInCatalogue.find((r) => r.name === REPORT);
    expect(report).toBeTruthy();
    await showList(page, "reports", REPORT);
    await expect(reports(page).getByRole("row", { name: new RegExp(REPORT) })).toContainText(
      "Not in the test catalogue",
    );
    await expect(reports(page).getByRole("button")).toHaveCount(0);
  });

  test("2. creating a test item from its row pre-fills the form and removes the row", async ({
    page,
  }) => {
    await openNotPriced(page);
    await showList(page, "tests", TEST_NAME);
    await tests(page)
      .getByRole("button", { name: `Create item for ${TEST_NAME}`, exact: true })
      .click();
    await expect(field(page, "Name")).toHaveValue(TEST_NAME);
    await expect(field(page, "Kind")).toHaveValue("test");
    await expect(field(page, "Price (₹)")).toHaveValue("320");
    await expect(field(page, "Catalogue test")).toHaveValue(seed.test.id);
    await field(page, "Code").fill(`P130T_${tag}`);
    await field(page, "Subgroup").selectOption(String(seed.subgroup.id));
    await dialog(page).getByRole("button", { name: "Add item", exact: true }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(tests(page).getByRole("row", { name: new RegExp(TEST_NAME) })).toHaveCount(0);
    const item = await one(
      `SELECT kind, test_catalog_id, base_price::text FROM service_items WHERE code = $1`,
      [`P130T_${tag}`],
    );
    expect(item).toEqual({ kind: "test", test_catalog_id: seed.test.id, base_price: "320.00" });
  });

  test("3. creating a consultant fee from its row pre-fills the form and removes the row", async ({
    page,
  }) => {
    await openNotPriced(page);
    await showList(page, "consultants", DOCTOR);
    const create = consultants(page).getByRole("button", {
      name: `Create item for ${DOCTOR} (New)`,
      exact: true,
    });
    await create.click();
    await expect(field(page, "Kind")).toHaveValue("consultation");
    await expect(field(page, "Consultant")).toHaveValue(String(seed.doctor.id));
    await expect(field(page, "Visit type")).toHaveValue("New");
    await expect(field(page, "Name")).toHaveValue(`Consultation — ${DOCTOR} (New)`);
    await field(page, "Code").fill(`P130C_${tag}`);
    await field(page, "Price (₹)").fill("800");
    await field(page, "Subgroup").selectOption(String(seed.subgroup.id));
    await dialog(page).getByRole("button", { name: "Add item", exact: true }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(create).toHaveCount(0);
    await expect(
      consultants(page).getByRole("button", {
        name: `Create item for ${DOCTOR} (Follow Up)`,
        exact: true,
      }),
    ).toBeVisible();
  });

  test("4. a test whose item is off offers to activate it, and the row goes", async ({ page }) => {
    await openNotPriced(page);
    await showList(page, "tests", OFF_TEST_NAME);
    const row = tests(page).getByRole("row", { name: new RegExp(OFF_TEST_NAME) });
    await expect(row).toContainText(`P130OFF_${tag} is off`);
    await expect(
      row.getByRole("button", { name: `Create item for ${OFF_TEST_NAME}`, exact: true }),
    ).toHaveCount(0);
    await row
      .getByRole("button", {
        name: `Activate item P130OFF_${tag} for ${OFF_TEST_NAME}`,
        exact: true,
      })
      .click();
    await expect(row).toHaveCount(0);
    const item = await one(`SELECT is_active FROM service_items WHERE code = $1`, [
      `P130OFF_${tag}`,
    ]);
    expect(item.is_active).toBe(true);
  });

  test("5. closing a pre-filled form without changes creates nothing", async ({ page }) => {
    await openNotPriced(page);
    await showList(page, "consultants", DOCTOR);
    await consultants(page)
      .getByRole("button", { name: `Create item for ${DOCTOR} (Follow Up)`, exact: true })
      .click();
    await expect(dialog(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
    const n = await one(
      `SELECT count(*)::int AS n FROM service_items WHERE doctor_id = $1 AND visit_type = 'Follow Up'`,
      [seed.doctor.id],
    );
    expect(n.n).toBe(0);
  });

  test("6. the Items view is still one click away", async ({ page }) => {
    await openNotPriced(page);
    await viewSwitch(page).getByRole("button", { name: "Items", exact: true }).click();
    await expect(page.getByRole("region", { name: "Groups" })).toBeVisible();
    await expect(
      viewSwitch(page).getByRole("button", { name: "Items", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
  });
});
