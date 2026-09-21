import crypto from "node:crypto";
import { test, expect } from "@playwright/test";
import { apiAs, loginAs } from "../../helpers/auth.mjs";
import { one, query } from "../../helpers/db.mjs";
import { buildCatalogTest } from "../../helpers/builders.mjs";
import { gotoReady } from "../../helpers/browser.mjs";

const tag = crypto.randomBytes(3).toString("hex");
const PRICED = `P134 Priced ${tag}`;
const UNBILLED = `P134 Unbilled ${tag}`;
const OFF = `P134 Off ${tag}`;
const ADDED = `P134 Added ${tag}`;
const RETIRED = `P134 Retired ${tag}`;
const seed = {};

const table = (page) => page.locator(".tcat__table");
const search = (page) => page.getByLabel("Search tests by name or code", { exact: true });
const row = (page, name) => table(page).getByRole("row", { name: new RegExp(name) });

async function openCatalogue(page) {
  await loginAs(page, "admin");
  await gotoReady(page, "/settings/tests", () => search(page));
  await search(page).fill(`P134`);
}

test.describe.serial("P1-34 test catalogue page stops editing price", () => {
  test.describe.configure({ retries: 1 });

  test.beforeAll(async () => {
    const api = await apiAs("admin");
    const post = async (path, data) => {
      const response = await api.post(`/api/billing/master/${path}`, { data });
      expect(response.status(), path).toBe(201);
      return response.json();
    };
    const group = await post("groups", { code: `P134G_${tag}`, name: `P134 Lab ${tag}` });
    seed.subgroup = await post("subgroups", {
      group_id: group.id,
      code: `P134S_${tag}`,
      name: `P134 Tests ${tag}`,
    });
    seed.priced = await buildCatalogTest({ test_name: PRICED, price: 100 });
    seed.unbilled = await buildCatalogTest({ test_name: UNBILLED, price: 300 });
    seed.off = await buildCatalogTest({ test_name: OFF, price: 200 });
    seed.retired = await buildCatalogTest({ test_name: RETIRED, price: 50, is_active: false });
    await post("items", {
      code: `P134P_${tag}`,
      name: PRICED,
      subgroup_id: seed.subgroup.id,
      base_price: 450,
      kind: "test",
      test_catalog_id: seed.priced.id,
    });
    const offItem = await post("items", {
      code: `P134O_${tag}`,
      name: OFF,
      subgroup_id: seed.subgroup.id,
      base_price: 200,
      kind: "test",
      test_catalog_id: seed.off.id,
    });
    await api.put(`/api/billing/master/items/${offItem.id}/active`, {
      data: { is_active: false },
    });
    await api.dispose();
  });

  test.afterAll(async () => {
    await query(
      `DELETE FROM service_item_price_history WHERE service_item_id IN
         (SELECT id FROM service_items WHERE code LIKE $1)`,
      [`P134%${tag}`],
    );
    await query(`DELETE FROM service_items WHERE code LIKE $1`, [`P134%${tag}`]);
    await query(`DELETE FROM service_subgroups WHERE code LIKE $1`, [`P134%${tag}`]);
    await query(`DELETE FROM service_groups WHERE code LIKE $1`, [`P134%${tag}`]);
    await query(`DELETE FROM giniflow_test_catalog WHERE test_name LIKE $1`, [`P134 %${tag}`]);
  });

  test("1. no price can be typed anywhere on the page", async ({ page }) => {
    await openCatalogue(page);
    await expect(row(page, PRICED)).toBeVisible();
    await expect(page.locator(".tcat__price")).toHaveCount(0);
    await expect(page.locator('input[inputmode="decimal"]')).toHaveCount(0);
    await expect(page.getByPlaceholder("₹ price")).toHaveCount(0);
  });

  test("2. each test shows where its price comes from", async ({ page }) => {
    await openCatalogue(page);
    await expect(row(page, PRICED)).toContainText("₹450");
    await expect(
      row(page, PRICED).getByRole("link", {
        name: `P134P_${tag} — change the price of ${PRICED} in Services`,
      }),
    ).toHaveText(`P134P_${tag}`);
    await expect(row(page, UNBILLED)).toContainText("₹300");
    await expect(
      row(page, UNBILLED).getByRole("link", { name: `Create item for ${UNBILLED}` }),
    ).toHaveText("Create item");
    await expect(
      row(page, OFF).getByRole("link", {
        name: `P134O_${tag} is off — the billing item for ${OFF}`,
      }),
    ).toHaveText(`P134O_${tag} is off`);

    const api = await apiAs("admin");
    const tests = (await (await api.get("/api/giniflow/test-catalog")).json()).tests;
    await api.dispose();
    const unbilled = tests.filter((t) => t.isActive && !t.serviceItemCode).length;
    await expect(page.locator(".tcat__warn")).toContainText(
      `${unbilled} active test${unbilled === 1 ? " has" : "s have"} no active billing item`,
    );
  });

  test("2b. review: search finds a test by its billing item's code", async ({ page }) => {
    await openCatalogue(page);
    await search(page).fill(`p134p_${tag}`);
    await expect(row(page, PRICED)).toBeVisible();
    await expect(table(page).getByRole("row", { name: new RegExp(UNBILLED) })).toHaveCount(0);
    await search(page).fill(`P134O_${tag}`);
    await expect(row(page, OFF)).toBeVisible();
    await expect(table(page).getByRole("row", { name: new RegExp(PRICED) })).toHaveCount(0);
  });

  test("2c. review: the new test name and the gloss stop at the server's lengths", async ({
    page,
  }) => {
    await openCatalogue(page);
    await expect(
      page.getByPlaceholder("Test name — offered to every patient", { exact: true }),
    ).toHaveAttribute("maxlength", "120");
    await expect(row(page, PRICED).getByPlaceholder("Why a doctor orders it")).toHaveAttribute(
      "maxlength",
      "160",
    );
  });

  test("3. the item link opens Services searched to that item", async ({ page }) => {
    await openCatalogue(page);
    await row(page, PRICED)
      .getByRole("link", { name: `P134P_${tag} — change the price of ${PRICED} in Services` })
      .click();
    await expect(page).toHaveURL(new RegExp(`/settings/services\\?q=P134P_${tag}`));
    await expect(page.getByLabel("Search items")).toHaveValue(`P134P_${tag}`);
    await expect(
      page.getByRole("table", { name: "Items" }).getByRole("cell", { name: `P134P_${tag}` }),
    ).toBeVisible();
  });

  test("4. Create item opens the item form pre-filled, and the test is then billed", async ({
    page,
  }) => {
    await openCatalogue(page);
    await row(page, UNBILLED)
      .getByRole("link", { name: `Create item for ${UNBILLED}` })
      .click();
    const dialog = page.getByRole("dialog");
    const field = (label) => dialog.getByLabel(label, { exact: true });
    await expect(field("Name")).toHaveValue(UNBILLED);
    await expect(field("Kind")).toHaveValue("test");
    await expect(field("Catalogue test")).toHaveValue(seed.unbilled.id);
    await expect(field("Price (₹)")).toHaveValue("300");
    await expect(page).not.toHaveURL(/createTest/);
    await field("Code").fill(`P134U_${tag}`);
    await field("Subgroup").selectOption(String(seed.subgroup.id));
    await dialog.getByRole("button", { name: "Add item", exact: true }).click();
    await expect(dialog).toHaveCount(0);

    await openCatalogue(page);
    await expect(
      row(page, UNBILLED).getByRole("link", {
        name: `P134U_${tag} — change the price of ${UNBILLED} in Services`,
      }),
    ).toHaveText(`P134U_${tag}`);
  });

  test("5. a test that already has an item can't be sent to Create item twice", async ({
    page,
  }) => {
    await loginAs(page, "admin");
    await gotoReady(page, `/settings/services?createTest=${seed.priced.id}`, () =>
      page.getByRole("region", { name: "Groups" }),
    );
    await expect(
      page.getByText("That test can't get a new item — it already has one, or it's retired"),
    ).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("6. a new test is added without a price and offers Create item", async ({ page }) => {
    await openCatalogue(page);
    await page.getByPlaceholder("Test name — offered to every patient").fill(ADDED);
    await page.getByRole("button", { name: "+ Add", exact: true }).click();
    await expect(
      row(page, ADDED).getByRole("link", { name: `Create item for ${ADDED}` }),
    ).toBeVisible();
    const added = await one(`SELECT price::text FROM giniflow_test_catalog WHERE test_name = $1`, [
      ADDED,
    ]);
    expect(Number(added.price)).toBe(0);
  });

  test("7. a retired test with no item says Retired, not Create item", async ({ page }) => {
    await openCatalogue(page);
    await expect(row(page, RETIRED)).toHaveCount(0);
    await page.getByLabel("Show retired").check();
    await expect(row(page, RETIRED)).toContainText("Retired");
    await expect(row(page, RETIRED).getByRole("link")).toHaveCount(0);
  });

  test("8. the catalogue refuses a price change even for a test with no item", async () => {
    const api = await apiAs("admin");
    const response = await api.patch(`/api/giniflow/test-catalog/${seed.off.id}`, {
      data: { price: 999 },
    });
    expect(response.status()).toBe(409);
    expect((await response.json()).error).toBe(
      "Test prices are set on the test's billing item; create one in Settings → Services",
    );
    const glossOnly = await api.patch(`/api/giniflow/test-catalog/${seed.off.id}`, {
      data: { gloss: "Pancreas" },
    });
    expect(glossOnly.status()).toBe(200);
    await api.dispose();
    const stored = await one(`SELECT price::int, gloss FROM giniflow_test_catalog WHERE id = $1`, [
      seed.off.id,
    ]);
    expect(stored).toEqual({ price: 200, gloss: "Pancreas" });
  });
});
