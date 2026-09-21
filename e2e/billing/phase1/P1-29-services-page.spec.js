import crypto from "node:crypto";
import { test, expect } from "@playwright/test";
import { apiAs, loginAs } from "../../helpers/auth.mjs";
import { one, query } from "../../helpers/db.mjs";
import { buildCatalogTest, buildScheme } from "../../helpers/builders.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { LAB_ONLY_DOCTOR } from "../../../shared/labOnly.js";

const tag = crypto.randomBytes(3).toString("hex");
const G = { code: `P129G_${tag}`, name: `P129 Group ${tag}`, renamed: `P129 Renamed ${tag}` };
const S1 = { code: `P129S1_${tag}`, name: `P129 Sub One ${tag}` };
const S2 = { code: `P129S2_${tag}`, name: `P129 Sub Two ${tag}` };
const ITEM = { code: `P129I_${tag}`, name: `P129 Dressing ${tag}` };
const TEST_ITEM = { code: `P129T_${tag}`, name: `P129 Test Item ${tag}` };
const CONSULT = { code: `P129C_${tag}`, name: `P129 Consult ${tag}` };
const TAX = `P129TX_${tag}`;
const seed = {};

async function holdRequests(page, pattern, method) {
  let release;
  const held = new Promise((resolve) => (release = resolve));
  await page.route(pattern, async (route) => {
    if (method && route.request().method() !== method) return route.fallback();
    await held;
    await route.fallback();
  });
  return release;
}

const groups = (page) => page.getByRole("region", { name: "Groups" });
const itemsTable = (page) => page.getByRole("table", { name: "Items" });
const dialog = (page) => page.getByRole("dialog");
const field = (page, label) => dialog(page).getByLabel(label, { exact: true });

async function ensureSeed() {
  seed.test ??= await buildCatalogTest({ test_name: `P129 Catalogue Test ${tag}` });
  seed.doctor ??= await one(
    `INSERT INTO doctors (name, role, pin, is_active) VALUES ($1, 'consultant', 'x', TRUE) RETURNING id`,
    [`Dr P129 ${tag}`],
  );
}

async function openServices(page) {
  await loginAs(page, "reception_admin");
  await gotoReady(page, "/settings/services", () => groups(page));
}

async function pickSubgroup(page, name) {
  await groups(page)
    .getByRole("button", { name: new RegExp(`^${name}`) })
    .click();
  await expect(page.getByRole("heading", { level: 2, name: new RegExp(name) })).toBeVisible();
}

async function addItem(page, values) {
  await page.getByRole("button", { name: "+ Add item", exact: true }).click();
  await field(page, "Name").fill(values.name);
  await field(page, "Code").fill(values.code);
  await field(page, "Kind").selectOption(values.kind ?? "other");
  await field(page, "Price (₹)").fill(values.price);
  if (values.extra) await values.extra();
  await dialog(page).getByRole("button", { name: "Add item", exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(itemsTable(page).getByRole("cell", { name: values.code })).toBeVisible();
}

test.describe("P1-29 services page — pickers endpoint", () => {
  test.beforeAll(ensureSeed);

  test("1. items/choices gives kinds, visit types, active tests and consultants", async () => {
    const labOnly = await one(
      `INSERT INTO doctors (name, role, pin, is_active) VALUES ($1, 'consultant', 'x', TRUE) RETURNING id`,
      [LAB_ONLY_DOCTOR],
    );
    const api = await apiAs("reception_admin");
    const response = await api.get("/api/billing/master/items/choices");
    await query(`DELETE FROM doctors WHERE id = $1`, [labOnly.id]);
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.kinds).toEqual(["consultation", "test", "procedure", "medicine", "other"]);
    expect(body.visitTypes).toEqual(["New", "Follow Up"]);
    expect(body.tests.find((t) => t.id === seed.test.id)).toMatchObject({ item_id: null });
    expect(body.consultants.map((d) => d.id)).toContain(seed.doctor.id);
    expect(body.consultants.map((d) => d.id)).not.toContain(labOnly.id);
    await api.dispose();
  });

  test("2. items/choices is refused to roles without billing master", async () => {
    for (const role of ["reception", "coordinator"]) {
      const api = await apiAs(role);
      expect((await api.get("/api/billing/master/items/choices")).status(), role).toBe(403);
      await api.dispose();
    }
  });
});

test.describe.serial("P1-29 services page — screen", () => {
  test.describe.configure({ retries: 1 });

  test.beforeAll(ensureSeed);

  test.afterAll(async () => {
    await query(
      `DELETE FROM service_item_price_history WHERE service_item_id IN
         (SELECT id FROM service_items WHERE code LIKE $1)`,
      [`P129%${tag}`],
    );
    await query(
      `DELETE FROM category_item_rates WHERE service_item_id IN
         (SELECT id FROM service_items WHERE code LIKE $1)`,
      [`P129%${tag}`],
    );
    await query(`DELETE FROM service_items WHERE code LIKE $1`, [`P129%${tag}`]);
    await query(`DELETE FROM patient_schemes WHERE code = $1`, [`p129_${tag}`]);
    await query(`DELETE FROM tax_codes WHERE code = $1`, [TAX]);
    await query(`DELETE FROM service_subgroups WHERE code LIKE $1`, [`P129%${tag}`]);
    await query(`DELETE FROM service_groups WHERE code LIKE $1`, [`P129%${tag}`]);
    if (seed.test) await query(`DELETE FROM giniflow_test_catalog WHERE id = $1`, [seed.test.id]);
    if (seed.doctor) await query(`DELETE FROM doctors WHERE id = $1`, [seed.doctor.id]);
    delete seed.test;
    delete seed.doctor;
  });

  test("3. a group is created and renamed from the screen", async ({ page }) => {
    await openServices(page);
    const add = groups(page).getByRole("form", { name: "Add group" });
    await add.getByLabel("Add group code").fill(G.code);
    await add.getByLabel("Add group name").fill(G.name);
    await add.getByRole("button", { name: "+ Add", exact: true }).click();
    await expect(
      groups(page).getByRole("button", { name: new RegExp(`^${G.name}`) }),
    ).toBeVisible();

    await groups(page)
      .getByRole("button", { name: `Rename ${G.name}`, exact: true })
      .click();
    await groups(page).getByLabel(`New name for ${G.name}`).fill(G.renamed);
    await groups(page).getByRole("button", { name: "Save", exact: true }).click();
    await expect(
      groups(page).getByRole("button", { name: new RegExp(`^${G.renamed}`) }),
    ).toBeVisible();
    const row = await one(`SELECT name FROM service_groups WHERE code = $1`, [G.code]);
    expect(row.name).toBe(G.renamed);
  });

  test("4. subgroups are added and reordered", async ({ page }) => {
    await openServices(page);
    const add = groups(page).getByRole("form", { name: `Add subgroup to ${G.renamed}` });
    for (const sub of [S1, S2]) {
      await add.getByLabel(`Add subgroup to ${G.renamed} code`).fill(sub.code);
      await add.getByLabel(`Add subgroup to ${G.renamed} name`).fill(sub.name);
      await add.getByRole("button", { name: "+ Add", exact: true }).click();
      await expect(
        groups(page).getByRole("button", { name: new RegExp(`^${sub.name}`) }),
      ).toBeVisible();
    }
    const order = async () =>
      (
        await query(
          `SELECT code FROM service_subgroups WHERE code = ANY($1) ORDER BY sort_order, name`,
          [[S1.code, S2.code]],
        )
      ).rows.map((r) => r.code);
    expect(await order()).toEqual([S1.code, S2.code]);
    await groups(page)
      .getByRole("button", { name: `Move ${S2.name} up`, exact: true })
      .click();
    await expect.poll(order).toEqual([S2.code, S1.code]);
    await expect(
      groups(page).getByRole("button", { name: `Move ${S2.name} up`, exact: true }),
    ).toBeDisabled();
  });

  test("4b. the move buttons are locked while a move is saving", async ({ page }) => {
    await openServices(page);
    const release = await holdRequests(page, "**/api/billing/master/subgroups/*", "PATCH");
    await groups(page)
      .getByRole("button", { name: `Move ${S1.name} up`, exact: true })
      .click();
    await expect(
      groups(page).getByRole("button", { name: `Move ${S2.name} down`, exact: true }),
    ).toBeDisabled();
    await expect(
      groups(page).getByRole("button", { name: `Move ${G.renamed} down`, exact: true }),
    ).toBeDisabled();
    release();
    await expect
      .poll(async () =>
        (
          await query(
            `SELECT code FROM service_subgroups WHERE code = ANY($1) ORDER BY sort_order, name`,
            [[S1.code, S2.code]],
          )
        ).rows.map((r) => r.code),
      )
      .toEqual([S1.code, S2.code]);
    await expect(
      groups(page).getByRole("button", { name: `Move ${S2.name} up`, exact: true }),
    ).toBeEnabled();
  });

  test("5. items of every kind are created in the chosen subgroup", async ({ page }) => {
    await openServices(page);
    await expect(page.getByRole("button", { name: "+ Add item", exact: true })).toBeDisabled();
    await pickSubgroup(page, S1.name);
    await addItem(page, { ...ITEM, price: "150" });
    await addItem(page, {
      ...TEST_ITEM,
      kind: "test",
      price: "450",
      extra: () => field(page, "Catalogue test").selectOption(seed.test.id),
    });
    await addItem(page, {
      ...CONSULT,
      kind: "consultation",
      price: "900",
      extra: async () => {
        await field(page, "Consultant").selectOption(String(seed.doctor.id));
        await field(page, "Visit type").selectOption("New");
      },
    });
    const saved = await query(
      `SELECT code, subgroup_id, kind, base_price::text, test_catalog_id, doctor_id, visit_type
         FROM service_items WHERE code = ANY($1) ORDER BY code`,
      [[ITEM.code, TEST_ITEM.code, CONSULT.code]],
    );
    const sub = await one(`SELECT id FROM service_subgroups WHERE code = $1`, [S1.code]);
    expect(saved.rows.every((r) => r.subgroup_id === sub.id)).toBe(true);
    const byCode = Object.fromEntries(saved.rows.map((r) => [r.code, r]));
    expect(byCode[ITEM.code]).toMatchObject({ kind: "other", base_price: "150.00" });
    expect(byCode[TEST_ITEM.code]).toMatchObject({ kind: "test", test_catalog_id: seed.test.id });
    expect(byCode[CONSULT.code]).toMatchObject({
      kind: "consultation",
      doctor_id: seed.doctor.id,
      visit_type: "New",
    });
    await expect(
      itemsTable(page).getByRole("cell", { name: `Dr P129 ${tag} · New` }),
    ).toBeVisible();
  });

  test("5b. switching subgroup never shows the previous subgroup's items", async ({ page }) => {
    await openServices(page);
    await pickSubgroup(page, S1.name);
    await expect(itemsTable(page).getByRole("cell", { name: ITEM.code })).toBeVisible();
    const s2 = await one(`SELECT id FROM service_subgroups WHERE code = $1`, [S2.code]);
    const release = await holdRequests(page, `**/api/billing/master/items?*subgroupId=${s2.id}*`);
    await groups(page)
      .getByRole("button", { name: new RegExp(`^${S2.name}`) })
      .click();
    const items = page.getByRole("region", { name: "Items" });
    await expect(items.getByText("Loading…")).toBeVisible();
    await expect(page.getByRole("table", { name: "Items" })).toHaveCount(0);
    release();
    await expect(items.getByText("No items here yet.")).toBeVisible();
  });

  test("6. a server refusal is shown in the form", async ({ page }) => {
    await openServices(page);
    await pickSubgroup(page, S1.name);
    await page.getByRole("button", { name: "+ Add item", exact: true }).click();
    await field(page, "Name").fill(`P129 Duplicate ${tag}`);
    await field(page, "Code").fill(ITEM.code.toLowerCase());
    await field(page, "Price (₹)").fill("10");
    await dialog(page).getByRole("button", { name: "Add item", exact: true }).click();
    await expect(dialog(page).getByRole("alert")).toContainText(/already/i);
    await dialog(page).getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog(page)).toHaveCount(0);
  });

  test("6b. review: the price box takes only an amount", async ({ page }) => {
    await openServices(page);
    await pickSubgroup(page, S1.name);
    await page.getByRole("button", { name: "+ Add item", exact: true }).click();
    await field(page, "Price (₹)").pressSequentially("₹1,2a00.5.67");
    await expect(field(page, "Price (₹)")).toHaveValue("1200.56");
    await page.keyboard.press("Escape");
    await dialog(page)
      .getByRole("group", { name: "Discard changes?" })
      .getByRole("button", { name: "Discard", exact: true })
      .click();
    await expect(dialog(page)).toHaveCount(0);
  });

  test("6c. review: code, max quantity and text boxes stop bad input as it is typed", async ({
    page,
  }) => {
    await openServices(page);
    await pickSubgroup(page, S1.name);
    const addGroupCode = groups(page).getByLabel("Add group code", { exact: true });
    await addGroupCode.pressSequentially("LAB 01");
    await expect(addGroupCode).toHaveValue("LAB01");
    await expect(addGroupCode).toHaveAttribute("maxlength", "40");
    await expect(groups(page).getByLabel("Add group name", { exact: true })).toHaveAttribute(
      "maxlength",
      "200",
    );
    await addGroupCode.fill("");

    await page.getByRole("button", { name: "+ Add item", exact: true }).click();
    await field(page, "Code").pressSequentially("CBC 2");
    await expect(field(page, "Code")).toHaveValue("CBC2");
    await expect(field(page, "Code")).toHaveAttribute("maxlength", "40");
    await expect(field(page, "Name")).toHaveAttribute("maxlength", "200");
    await expect(field(page, "Unit")).toHaveAttribute("maxlength", "30");
    await dialog(page).getByText("Quantity can be more than 1").click();
    await field(page, "Max quantity").pressSequentially("1a0.5");
    await expect(field(page, "Max quantity")).toHaveValue("105");
    await page.keyboard.press("Escape");
    await dialog(page)
      .getByRole("group", { name: "Discard changes?" })
      .getByRole("button", { name: "Discard", exact: true })
      .click();
    await expect(dialog(page)).toHaveCount(0);
  });

  test("7. a price change asks for a reason and shows in the history drawer", async ({ page }) => {
    await openServices(page);
    await pickSubgroup(page, S1.name);
    await page.getByRole("button", { name: `Edit ${ITEM.name}`, exact: true }).click();
    await expect(field(page, "Reason for the price change")).toHaveCount(0);
    await field(page, "Price (₹)").fill("175.50");
    await expect(field(page, "Reason for the price change")).toBeVisible();
    await dialog(page).getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog(page)).toBeVisible();
    await field(page, "Reason for the price change").fill("Supplier rate went up");
    await dialog(page).getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(itemsTable(page).getByRole("cell", { name: "₹175.50" })).toBeVisible();

    await page.getByRole("button", { name: `Price history of ${ITEM.name}`, exact: true }).click();
    const drawer = page.getByRole("dialog", { name: `Price history · ${ITEM.name}` });
    const past = drawer.getByRole("table", { name: "Past prices" });
    await expect(past.getByRole("cell", { name: "₹150 → ₹175.50" })).toBeVisible();
    await expect(past.getByRole("cell", { name: "Supplier rate went up" })).toBeVisible();
    await expect(past.getByRole("cell", { name: "Created" })).toBeVisible();
    await drawer.getByRole("button", { name: "Close", exact: true }).click();
  });

  test("7b. the form keeps focus and asks before throwing away changes", async ({ page }) => {
    await openServices(page);
    await pickSubgroup(page, S1.name);
    const edit = page.getByRole("button", { name: `Edit ${ITEM.name}`, exact: true });
    await edit.click();
    await expect(dialog(page)).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => Boolean(document.activeElement?.closest("[role=dialog]"))))
      .toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
    await expect(edit).toBeFocused();

    await edit.click();
    await field(page, "Unit").fill("box");
    for (let i = 0; i < 25; i += 1) await page.keyboard.press("Tab");
    expect(
      await page.evaluate(() => Boolean(document.activeElement?.closest("[role=dialog]"))),
    ).toBe(true);
    await page.mouse.click(8, 400);
    const discard = dialog(page).getByRole("group", { name: "Discard changes?" });
    await expect(discard).toBeVisible();
    await discard.getByRole("button", { name: "Keep editing", exact: true }).click();
    await expect(field(page, "Unit")).toHaveValue("box");
    await page.keyboard.press("Escape");
    await discard.getByRole("button", { name: "Discard", exact: true }).click();
    await expect(dialog(page)).toHaveCount(0);
    expect((await one(`SELECT unit FROM service_items WHERE code = $1`, [ITEM.code])).unit).toBe(
      "each",
    );
  });

  test("8. editing without a price change needs no reason and writes no history", async ({
    page,
  }) => {
    await openServices(page);
    await pickSubgroup(page, S1.name);
    await page.getByRole("button", { name: `Edit ${ITEM.name}`, exact: true }).click();
    await field(page, "Unit").fill("roll");
    await dialog(page).getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(itemsTable(page).getByRole("cell", { name: "roll" })).toBeVisible();
    const history = await one(
      `SELECT count(*)::int AS n FROM service_item_price_history h
         JOIN service_items i ON i.id = h.service_item_id WHERE i.code = $1`,
      [ITEM.code],
    );
    expect(history.n).toBe(2);
  });

  test("9. search and kind filters narrow the list", async ({ page }) => {
    await openServices(page);
    await page.getByLabel("Search items").fill(TEST_ITEM.code);
    await expect(itemsTable(page).getByRole("cell", { name: TEST_ITEM.code })).toBeVisible();
    await expect(itemsTable(page).getByRole("cell", { name: ITEM.code })).toHaveCount(0);
    await page.getByLabel("Search items").fill(tag);
    await page.getByLabel("Kind").selectOption("consultation");
    await expect(itemsTable(page).getByRole("cell", { name: CONSULT.code })).toBeVisible();
    await expect(itemsTable(page).getByRole("cell", { name: TEST_ITEM.code })).toHaveCount(0);
  });

  test("10. an item is deactivated and activated again", async ({ page }) => {
    await openServices(page);
    await pickSubgroup(page, S1.name);
    await page.getByRole("button", { name: `Deactivate ${ITEM.name}`, exact: true }).click();
    await expect(
      page.getByRole("button", { name: `Activate ${ITEM.name}`, exact: true }),
    ).toBeVisible();
    expect(
      (await one(`SELECT is_active FROM service_items WHERE code = $1`, [ITEM.code])).is_active,
    ).toBe(false);
    await page.getByRole("button", { name: `Activate ${ITEM.name}`, exact: true }).click();
    await expect(
      page.getByRole("button", { name: `Deactivate ${ITEM.name}`, exact: true }),
    ).toBeVisible();
  });

  test("10b. the form still shows a consultant, tax code or test that was switched off", async ({
    page,
  }) => {
    const admin = await apiAs("admin");
    const tax = await (
      await admin.post("/api/billing/settings/tax-codes", {
        data: { code: TAX, sac_hsn: "999312", rate_pct: 5 },
      })
    ).json();
    await admin.dispose();
    await query(`UPDATE service_items SET tax_code_id = $1 WHERE code = $2`, [
      tax.id,
      CONSULT.code,
    ]);
    await query(`UPDATE tax_codes SET is_active = FALSE WHERE id = $1`, [tax.id]);
    await query(`UPDATE doctors SET is_active = FALSE WHERE id = $1`, [seed.doctor.id]);
    await query(`UPDATE giniflow_test_catalog SET is_active = FALSE WHERE id = $1`, [seed.test.id]);
    try {
      await openServices(page);
      await pickSubgroup(page, S1.name);
      await page.getByRole("button", { name: `Edit ${CONSULT.name}`, exact: true }).click();
      await expect(field(page, "Consultant").locator("option:checked")).toHaveText(
        `Dr P129 ${tag} (inactive)`,
      );
      await expect(field(page, "Tax code").locator("option:checked")).toHaveText(
        `${TAX} (inactive)`,
      );
      await dialog(page).getByRole("button", { name: "Cancel", exact: true }).click();
      await page.getByRole("button", { name: `Edit ${TEST_ITEM.name}`, exact: true }).click();
      await expect(field(page, "Catalogue test").locator("option:checked")).toHaveText(
        `P129 Catalogue Test ${tag} (retired)`,
      );
      await dialog(page).getByRole("button", { name: "Cancel", exact: true }).click();
    } finally {
      await query(`UPDATE service_items SET tax_code_id = NULL WHERE code = $1`, [CONSULT.code]);
      await query(`DELETE FROM tax_codes WHERE id = $1`, [tax.id]);
      await query(`UPDATE doctors SET is_active = TRUE WHERE id = $1`, [seed.doctor.id]);
      await query(`UPDATE giniflow_test_catalog SET is_active = TRUE WHERE id = $1`, [
        seed.test.id,
      ]);
    }
  });

  test("10c. the heading follows a rename and an off subgroup can't take items", async ({
    page,
  }) => {
    await openServices(page);
    await pickSubgroup(page, S2.name);
    const addItem = page.getByRole("button", { name: "+ Add item", exact: true });
    await expect(addItem).toBeEnabled();
    const renamed = `${S2.name} Renamed`;
    await groups(page)
      .getByRole("button", { name: `Rename ${S2.name}`, exact: true })
      .click();
    await groups(page).getByLabel(`New name for ${S2.name}`).fill(renamed);
    await groups(page).getByRole("button", { name: "Save", exact: true }).click();
    await expect(
      page.getByRole("heading", { level: 2, name: `${G.renamed} › ${renamed}` }),
    ).toBeVisible();
    await groups(page)
      .getByRole("button", { name: `Deactivate ${renamed}`, exact: true })
      .click();
    await expect(addItem).toBeDisabled();
    await expect(addItem).toHaveAttribute("title", /This subgroup is off/);
    await groups(page)
      .getByRole("button", { name: `Activate ${renamed}`, exact: true })
      .click();
    await expect(addItem).toBeEnabled();
    await groups(page)
      .getByRole("button", { name: `Rename ${renamed}`, exact: true })
      .click();
    await groups(page).getByLabel(`New name for ${renamed}`).fill(S2.name);
    await groups(page).getByRole("button", { name: "Save", exact: true }).click();
    await expect(
      page.getByRole("heading", { level: 2, name: `${G.renamed} › ${S2.name}` }),
    ).toBeVisible();
  });

  test("11. deleting a subgroup that has items shows where it is used", async ({ page }) => {
    await openServices(page);
    await groups(page)
      .getByRole("button", { name: `Delete ${S1.name}`, exact: true })
      .click();
    await groups(page)
      .getByRole("button", { name: `Confirm delete ${S1.name}`, exact: true })
      .click();
    const blocked = page.getByRole("dialog", { name: `${S1.name} can't be deleted` });
    await expect(blocked.getByRole("list", { name: "Used in" })).toContainText(
      `3 items in ${S1.name}`,
    );
    await blocked.getByRole("button", { name: "Close", exact: true }).click();
    expect(await one(`SELECT is_active FROM service_subgroups WHERE code = $1`, [S1.code])).toEqual(
      {
        is_active: true,
      },
    );
  });

  test("12. deactivating instead is refused while the subgroup has active items", async ({
    page,
  }) => {
    await openServices(page);
    await groups(page)
      .getByRole("button", { name: `Delete ${S1.name}`, exact: true })
      .click();
    await groups(page)
      .getByRole("button", { name: `Confirm delete ${S1.name}`, exact: true })
      .click();
    const blocked = page.getByRole("dialog", { name: `${S1.name} can't be deleted` });
    await blocked.getByRole("button", { name: "Deactivate instead", exact: true }).click();
    await expect(blocked.getByRole("alert")).toContainText("still has 3 active items");
    await blocked.getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(
      (await one(`SELECT is_active FROM service_subgroups WHERE code = $1`, [S1.code])).is_active,
    ).toBe(true);
  });

  test("12b. an item used by a category rate deactivates instead of deleting", async ({ page }) => {
    const api = await apiAs("admin");
    const item = await one(`SELECT id FROM service_items WHERE code = $1`, [ITEM.code]);
    const scheme = await buildScheme({ code: `p129_${tag}` });
    expect(
      (
        await api.put("/api/billing/master/category-rates", {
          data: { scheme_code: scheme.code, service_item_id: item.id, rate: 100 },
        })
      ).status(),
    ).toBe(200);
    await api.dispose();

    await openServices(page);
    await pickSubgroup(page, S1.name);
    await page.getByRole("button", { name: `Delete ${ITEM.name}`, exact: true }).click();
    await page.getByRole("button", { name: `Confirm delete ${ITEM.name}`, exact: true }).click();
    const blocked = page.getByRole("dialog", { name: `${ITEM.name} can't be deleted` });
    await expect(blocked.getByRole("list", { name: "Used in" })).toBeVisible();
    await blocked.getByRole("button", { name: "Deactivate instead", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: `Activate ${ITEM.name}`, exact: true }),
    ).toBeVisible();
    await query(`DELETE FROM category_item_rates WHERE service_item_id = $1`, [item.id]);
  });

  test("13. an item, a subgroup and a group are deleted from the screen", async ({ page }) => {
    await openServices(page);
    await pickSubgroup(page, S1.name);
    for (const item of [ITEM, TEST_ITEM, CONSULT]) {
      await page.getByRole("button", { name: `Delete ${item.name}`, exact: true }).click();
      await page.getByRole("button", { name: `Confirm delete ${item.name}`, exact: true }).click();
      await expect(itemsTable(page).getByRole("cell", { name: item.code })).toHaveCount(0);
    }
    await expect(page.getByText("No items here yet.")).toBeVisible();
    for (const sub of [S1, S2]) {
      await groups(page)
        .getByRole("button", { name: `Delete ${sub.name}`, exact: true })
        .click();
      await groups(page)
        .getByRole("button", { name: `Confirm delete ${sub.name}`, exact: true })
        .click();
      await expect(
        groups(page).getByRole("button", { name: new RegExp(`^${sub.name}`) }),
      ).toHaveCount(0);
    }
    await groups(page)
      .getByRole("button", { name: `Delete ${G.renamed}`, exact: true })
      .click();
    await groups(page)
      .getByRole("button", { name: `Confirm delete ${G.renamed}`, exact: true })
      .click();
    await expect(
      groups(page).getByRole("button", { name: new RegExp(`^${G.renamed}`) }),
    ).toHaveCount(0);
    const left = await one(
      `SELECT (SELECT count(*) FROM service_items WHERE code LIKE $1)::int
            + (SELECT count(*) FROM service_subgroups WHERE code LIKE $1)::int
            + (SELECT count(*) FROM service_groups WHERE code LIKE $1)::int AS n`,
      [`P129%${tag}`],
    );
    expect(left.n).toBe(0);
  });
});
