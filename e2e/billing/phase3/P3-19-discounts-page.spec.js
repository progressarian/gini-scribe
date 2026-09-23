import crypto from "node:crypto";
import { test, expect } from "@playwright/test";
import { apiAs, loginAs } from "../../helpers/auth.mjs";
import { one, query } from "../../helpers/db.mjs";
import { gotoReady } from "../../helpers/browser.mjs";

const tag = crypto.randomBytes(3).toString("hex");
const T = tag.toUpperCase();
const GROUP = `P319 OPD ${tag}`;
const OTHER_GROUP = `P319 Lab ${tag}`;
const TOP = { code: `p319_${tag}`, label: `P319 CGHS ${tag}`, payer_name: `P319 Payer ${tag}` };
const SUB = { code: `p319_pen_${tag}`, label: "Pensioner", parent_code: TOP.code };
const DOCTORS = [`Dr P319 Anand ${tag}`, `Dr P319 Bhatia ${tag}`];
const CC50 = { name: `CC50 ${tag}`, code: `CC50${T}` };
const AGE = `Seniors 70+ ${tag}`;
const COUPON = { name: `Dr coupon ${tag}`, code: `DOC${T}` };
const ITEM = `P319 Dressing ${tag}`;
const seed = {};

const ruleOf = (name) =>
  one(
    `SELECT code, method, kind, value::text, max_discount::text, applies_per, group_ids,
            subgroup_ids, service_item_ids, doctor_ids, visit_types, scheme_codes, min_age,
            max_age, gender, valid_from::text, valid_to::text, max_uses_total,
            max_uses_per_patient, max_uses_per_day, max_uses_per_doctor_per_day, priority,
            stackable, applies_on_scheme_rate, allowed_roles, is_active
       FROM discount_rules WHERE name = $1`,
    [name],
  );

const list = (page) => page.getByRole("table", { name: "Discounts" });
const row = (page, name) => list(page).getByRole("row").filter({ hasText: name });
const dialog = (page) => page.getByRole("dialog");
const field = (page, label) => dialog(page).getByLabel(label, { exact: true });
const check = (page, name) => dialog(page).getByRole("checkbox", { name, exact: true });

async function openPage(page, role = "reception_admin") {
  await loginAs(page, role);
  await gotoReady(page, "/settings/discounts", () =>
    page.getByRole("button", { name: "+ New discount" }),
  );
  await page.getByLabel("Search", { exact: true }).fill(tag);
}

async function save(page, label) {
  await dialog(page).getByRole("button", { name: label, exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
}

test.describe.serial("P3-19 discounts page", () => {
  test.describe.configure({ retries: 1 });

  test.beforeAll(async () => {
    const api = await apiAs("admin");
    const post = async (path, data) => {
      const response = await api.post(`/api/billing/master/${path}`, { data });
      expect(response.status(), `${path} ${JSON.stringify(data)}`).toBe(201);
      return response.json();
    };
    seed.group = await post("groups", { code: `P319G_${tag}`, name: GROUP });
    seed.subgroup = await post("subgroups", {
      group_id: seed.group.id,
      code: `P319S_${tag}`,
      name: "Consults",
    });
    seed.otherGroup = await post("groups", { code: `P319L_${tag}`, name: OTHER_GROUP });
    seed.item = await post("items", {
      code: `P319I_${tag}`,
      name: ITEM,
      subgroup_id: seed.subgroup.id,
      base_price: 300,
      kind: "procedure",
    });
    await post("categories", TOP);
    await post("categories", SUB);
    await api.dispose();
    seed.doctors = [];
    for (const name of DOCTORS) {
      seed.doctors.push(
        await one(
          `INSERT INTO doctors (name, role, pin, is_active) VALUES ($1, 'consultant', 'x', TRUE)
           RETURNING id`,
          [name],
        ),
      );
    }
  });

  test.afterAll(async () => {
    await query(`UPDATE discount_rules SET is_active = FALSE WHERE name LIKE $1`, [`% ${tag}`]);
    await query(`DELETE FROM discount_rules WHERE name LIKE $1`, [`% ${tag}`]);
    await query(`DELETE FROM service_items WHERE code LIKE $1`, [`P319%${tag}`]);
    await query(`DELETE FROM service_subgroups WHERE code LIKE $1`, [`P319%${tag}`]);
    await query(`DELETE FROM service_groups WHERE code LIKE $1`, [`P319%${tag}`]);
    await query(`DELETE FROM patient_schemes WHERE parent_code = $1`, [TOP.code]);
    await query(`DELETE FROM patient_schemes WHERE code = $1`, [TOP.code]);
    for (const d of seed.doctors ?? []) {
      await query(`DELETE FROM doctors WHERE id = $1`, [d.id]);
    }
  });

  test("1. CC50 (a code, 50% on the OPD group) is created through the form", async ({ page }) => {
    await openPage(page);
    await page.getByRole("button", { name: "+ New discount" }).click();
    await expect(dialog(page).getByRole("heading", { name: "New discount" })).toBeVisible();
    await field(page, "Name").fill(CC50.name);
    await field(page, "How it applies").selectOption("code");
    await field(page, "Code").fill(`CC50 ${T}`);
    await expect(field(page, "Code")).toHaveValue(CC50.code);
    await field(page, "Kind").selectOption("percent");
    await field(page, "Percent").fill("50");
    await check(page, GROUP).check();
    await save(page, "Add discount");

    const r = row(page, CC50.name);
    await expect(r).toContainText(CC50.code);
    await expect(r).toContainText("Code");
    await expect(r).toContainText("50%");
    await expect(r).toContainText(`Groups: ${GROUP}`);
    await expect(r).toContainText("Everyone");
    await expect(r).toContainText("Always");
    await expect(r).toContainText("0 used");
    await expect(r).toContainText("Active");
    expect(await ruleOf(CC50.name)).toMatchObject({
      code: CC50.code,
      method: "code",
      kind: "percent",
      value: "50.00",
      max_discount: null,
      applies_per: "line",
      group_ids: [seed.group.id],
      service_item_ids: null,
      doctor_ids: null,
      min_age: null,
      allowed_roles: null,
      is_active: true,
    });
  });

  test("2. CC50 is edited: cap, dates and every limit, shown against today's use", async ({
    page,
  }) => {
    await openPage(page);
    await page.getByRole("button", { name: `Edit discount ${CC50.name}`, exact: true }).click();
    await expect(field(page, "Name")).toHaveValue(CC50.name);
    await expect(field(page, "Code")).toHaveValue(CC50.code);
    await expect(field(page, "Percent")).toHaveValue("50");
    await expect(check(page, GROUP)).toBeChecked();
    await field(page, "Largest discount ₹").fill("2a00");
    await expect(field(page, "Largest discount ₹")).toHaveValue("200");
    await field(page, "Valid from").fill("2026-01-01");
    await field(page, "Valid to").fill("2027-03-31");
    for (const [label, value] of [
      ["Uses in all", "500"],
      ["Uses per patient", "2"],
      ["Uses per day", "1x0"],
      ["Uses per doctor per day", "3"],
    ]) {
      await field(page, label).fill(value);
    }
    await expect(field(page, "Uses per day")).toHaveValue("10");
    await check(page, "Reception").check();
    await check(page, "Stacks with other discounts").check();
    await save(page, "Save discount");

    const r = row(page, CC50.name);
    await expect(r).toContainText("50% up to ₹200");
    await expect(r).toContainText("2026-01-01 → 2027-03-31");
    await expect(r).toContainText("0 / 500 in all");
    await expect(r).toContainText("2 per patient");
    await expect(r).toContainText("0 / 10 today");
    await expect(r).toContainText("Each doctor: 0 / 3 today");
    expect(await ruleOf(CC50.name)).toMatchObject({
      value: "50.00",
      max_discount: "200.00",
      valid_from: "2026-01-01",
      valid_to: "2027-03-31",
      max_uses_total: 500,
      max_uses_per_patient: 2,
      max_uses_per_day: 10,
      max_uses_per_doctor_per_day: 3,
      allowed_roles: ["reception"],
      stackable: true,
      group_ids: [seed.group.id],
    });

    await page.getByRole("button", { name: `Edit discount ${CC50.name}`, exact: true }).click();
    await field(page, "Percent").fill("40");
    await save(page, "Save discount");
    await expect(row(page, CC50.name)).toContainText("40% up to ₹200");
    expect((await ruleOf(CC50.name)).value).toBe("40.00");
  });

  test("3. an automatic age rule (10% for 70+) is created and edited", async ({ page }) => {
    await openPage(page);
    await page.getByRole("button", { name: "+ New discount" }).click();
    await field(page, "Name").fill(AGE);
    await field(page, "How it applies").selectOption("auto");
    await expect(field(page, "Code")).toHaveCount(0);
    await expect(dialog(page).getByRole("group", { name: "Who may enter this code" })).toHaveCount(
      0,
    );
    await field(page, "Percent").fill("10");
    await field(page, "From age").fill("7x0");
    await expect(field(page, "From age")).toHaveValue("70");
    await check(page, GROUP).check();
    await check(page, TOP.label).check();
    await save(page, "Add discount");

    const r = row(page, AGE);
    await expect(r).toContainText("Automatic");
    await expect(r).toContainText("10%");
    await expect(r).toContainText("Age 70+");
    await expect(r).toContainText(TOP.label);
    expect(await ruleOf(AGE)).toMatchObject({
      code: null,
      method: "auto",
      value: "10.00",
      min_age: 70,
      max_age: null,
      scheme_codes: [TOP.code],
      allowed_roles: null,
    });

    await page.getByRole("button", { name: `Edit discount ${AGE}`, exact: true }).click();
    await expect(field(page, "From age")).toHaveValue("70");
    await expect(check(page, TOP.label)).toBeChecked();
    await field(page, "Percent").fill("15");
    await field(page, "To age").fill("120");
    await field(page, "Gender").selectOption("Female");
    await check(page, TOP.label).uncheck();
    await check(page, `${TOP.label} › ${SUB.label}`).check();
    await save(page, "Save discount");
    await expect(row(page, AGE)).toContainText("15%");
    await expect(row(page, AGE)).toContainText("Age 70–120");
    await expect(row(page, AGE)).toContainText("Female");
    await expect(row(page, AGE)).toContainText(`${TOP.label} › ${SUB.label}`);
    expect(await ruleOf(AGE)).toMatchObject({
      value: "15.00",
      min_age: 70,
      max_age: 120,
      gender: "Female",
      scheme_codes: [SUB.code],
    });
  });

  test("4. a doctors coupon: flat ₹100 off for two consultants on New visits", async ({ page }) => {
    await openPage(page);
    await page.getByRole("button", { name: "+ New discount" }).click();
    await field(page, "Name").fill(COUPON.name);
    await field(page, "Code").fill(COUPON.code);
    await field(page, "Kind").selectOption("flat");
    await expect(field(page, "Largest discount ₹")).toHaveCount(0);
    await field(page, "₹ off").fill("100");
    for (const name of DOCTORS) await check(page, name).check();
    await check(page, "New").check();
    await field(page, "Uses per doctor per day").fill("5");
    await save(page, "Add discount");

    const r = row(page, COUPON.name);
    await expect(r).toContainText("₹100 off");
    await expect(r).toContainText(`Doctors: ${DOCTORS.join(", ")}`);
    await expect(r).toContainText("Visits: New");
    await expect(r).toContainText("Each doctor: 0 / 5 today");
    expect(await ruleOf(COUPON.name)).toMatchObject({
      kind: "flat",
      value: "100.00",
      doctor_ids: seed.doctors.map((d) => d.id).sort((a, b) => a - b),
      visit_types: ["New"],
      max_uses_per_doctor_per_day: 5,
    });

    await page.getByRole("button", { name: `Edit discount ${COUPON.name}`, exact: true }).click();
    await check(page, DOCTORS[1]).uncheck();
    await save(page, "Save discount");
    await expect(row(page, COUPON.name)).toContainText(`Doctors: ${DOCTORS[0]}`);
    expect((await ruleOf(COUPON.name)).doctor_ids).toEqual([seed.doctors[0].id]);
  });

  test("5. the list shows today's use against each limit, per doctor too", async ({ page }) => {
    await page.route("**/api/billing/master/discounts**", async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      const response = await route.fetch();
      const rows = await response.json();
      const patched = rows.map((rule) =>
        rule.name === CC50.name
          ? {
              ...rule,
              uses_total: 42,
              usage_today: {
                date: "2026-09-22",
                count: 7,
                by_doctor: [
                  { doctor_id: seed.doctors[0].id, name: DOCTORS[0], count: 2 },
                  { doctor_id: seed.doctors[1].id, name: DOCTORS[1], count: 3 },
                ],
              },
            }
          : rule,
      );
      return route.fulfill({ response, json: patched });
    });
    await openPage(page);
    const r = row(page, CC50.name);
    await expect(r).toContainText("42 / 500 in all");
    await expect(r).toContainText("7 / 10 today");
    await expect(r).toContainText(`${DOCTORS[0]}: 2 / 3 today`);
    await expect(r).toContainText(`${DOCTORS[1]}: 3 / 3 today`);
  });

  test("6. refusals are shown readably and Cancel leaves nothing saved", async ({ page }) => {
    await openPage(page);
    await page.getByRole("button", { name: "+ New discount" }).click();
    const name = `Nothing off ${tag}`;
    await field(page, "Name").fill(name);
    await field(page, "Code").fill(`ZERO${T}`);
    await field(page, "Percent").fill("0");
    await dialog(page).getByRole("button", { name: "Add discount", exact: true }).click();
    await expect(dialog(page).getByRole("alert")).toHaveText(
      "A 0% discount takes nothing off; enter more than 0",
    );

    await field(page, "Percent").fill("5");
    await check(page, TOP.label).check();
    await check(page, `${TOP.label} › ${SUB.label}`).check();
    await dialog(page).getByRole("button", { name: "Add discount", exact: true }).click();
    await expect(dialog(page).getByRole("alert")).toContainText(
      `${TOP.label} already covers its sub-categories`,
    );

    await check(page, `${TOP.label} › ${SUB.label}`).uncheck();
    await field(page, "Code").fill(CC50.code);
    await dialog(page).getByRole("button", { name: "Add discount", exact: true }).click();
    await expect(dialog(page).getByRole("alert")).toContainText(CC50.code);
    await expect(dialog(page).getByRole("alert")).not.toContainText("server answered");

    await page.keyboard.press("Escape");
    await expect(dialog(page).getByRole("group", { name: "Discard changes?" })).toBeVisible();
    await dialog(page).getByRole("button", { name: "Keep editing", exact: true }).click();
    await expect(field(page, "Name")).toHaveValue(name);
    await dialog(page).getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog(page)).toHaveCount(0);
    expect(await ruleOf(name)).toBeNull();
  });

  test("6b. a coupon's doctors are named from the rule while the doctor list loads", async ({
    page,
  }) => {
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    await page.route("**/api/billing/master/items/choices", async (route) => {
      await held;
      return route.continue();
    });
    await openPage(page);
    await page.getByRole("button", { name: `Edit discount ${COUPON.name}`, exact: true }).click();
    const doctors = dialog(page).getByRole("group", { name: "Doctors" });
    await expect(doctors).toContainText(DOCTORS[0]);
    await expect(doctors).not.toContainText(`Doctor ${seed.doctors[0].id}`);
    await expect(doctors).not.toContainText("switched off");
    release();
    await expect(check(page, DOCTORS[0])).toBeChecked();
    await expect(doctors).not.toContainText("switched off");
  });

  test("7. deactivate, activate, and delete only after confirming", async ({ page }) => {
    await openPage(page);
    await page.getByRole("button", { name: `Deactivate discount ${COUPON.name}` }).click();
    await expect(row(page, COUPON.name)).toContainText("Inactive");
    expect((await ruleOf(COUPON.name)).is_active).toBe(false);
    await page.getByLabel("Active only", { exact: true }).check();
    await expect(row(page, COUPON.name)).toHaveCount(0);
    await page.getByLabel("Active only", { exact: true }).uncheck();
    await page.getByRole("button", { name: `Activate discount ${COUPON.name}` }).click();
    await expect(row(page, COUPON.name)).toContainText("Active");
    expect((await ruleOf(COUPON.name)).is_active).toBe(true);

    await page.getByRole("button", { name: `Delete discount ${COUPON.name}` }).click();
    await expect(page.getByRole("button", { name: `Keep discount ${COUPON.name}` })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("button", { name: `Delete discount ${COUPON.name}` }),
    ).toBeFocused();
    expect(await ruleOf(COUPON.name)).not.toBeNull();
    await page.getByRole("button", { name: `Delete discount ${COUPON.name}` }).click();
    await page.getByRole("button", { name: `Confirm delete discount ${COUPON.name}` }).click();
    await expect(row(page, COUPON.name)).toHaveCount(0);
    expect(await ruleOf(COUPON.name)).toBeNull();
  });

  test("9. Enter in the item search looks for items and doesn't save the discount", async ({
    page,
  }) => {
    const name = `Enter probe ${tag}`;
    await openPage(page);
    await page.getByRole("button", { name: "+ New discount" }).click();
    await field(page, "Name").fill(name);
    await field(page, "Code").fill(`ENTER${T}`);
    await field(page, "Percent").fill("5");
    await field(page, "Items").fill(ITEM);
    await expect(dialog(page).getByRole("button", { name: `Add ${ITEM}` })).toBeVisible();
    await field(page, "Items").press("Enter");
    await page.waitForTimeout(500);
    await expect(dialog(page)).toBeVisible();
    expect(await ruleOf(name)).toBeNull();
    await dialog(page)
      .getByRole("button", { name: `Add ${ITEM}` })
      .click();
    await expect(dialog(page).getByRole("list", { name: "Chosen items" })).toContainText(ITEM);
    await save(page, "Add discount");
    await expect(row(page, name)).toContainText(`Items: ${ITEM}`);
    expect((await ruleOf(name)).service_item_ids).toEqual([seed.item.id]);
  });

  test("9b. an item switched off since is still named, in the list and in the form", async ({
    page,
  }) => {
    const name = `Enter probe ${tag}`;
    await query(`UPDATE service_items SET is_active = FALSE WHERE id = $1`, [seed.item.id]);
    try {
      await openPage(page);
      await expect(row(page, name)).toContainText(`Items: ${ITEM} (switched off)`);
      await page.getByRole("button", { name: `Edit discount ${name}`, exact: true }).click();
      await expect(dialog(page).getByRole("list", { name: "Chosen items" })).toContainText(
        `${ITEM} (switched off)`,
      );
      await field(page, "Items").fill(ITEM);
      await expect(dialog(page).getByRole("button", { name: `Add ${ITEM}` })).toHaveCount(0);
      await dialog(page).getByRole("button", { name: "Cancel", exact: true }).click();
    } finally {
      await query(`UPDATE service_items SET is_active = TRUE WHERE id = $1`, [seed.item.id]);
    }
  });

  test("10. a fixed price puts 'Applies to' back on each line and bill rules say what they cover", async ({
    page,
  }) => {
    await openPage(page);
    await page.getByRole("button", { name: "+ New discount" }).click();
    await field(page, "Applies to").selectOption("bill");
    await expect(dialog(page)).toContainText(
      "On the whole bill it comes off the total of the lines it covers",
    );
    await field(page, "Kind").selectOption("fixed_price");
    await expect(field(page, "Applies to")).toHaveValue("line");
    await expect(dialog(page)).toContainText("Nothing chosen means every service.");
    await expect(field(page, "Uses in all")).toHaveAccessibleDescription("Empty = no limit");
    await expect(field(page, "Priority")).toHaveAccessibleDescription("Smaller wins a tie");
  });

  test("11. an automatic discount with nothing chosen asks before discounting every bill", async ({
    page,
  }) => {
    const name = `Everyone ${tag}`;
    await openPage(page);
    await page.getByRole("button", { name: "+ New discount" }).click();
    await field(page, "Name").fill(name);
    await field(page, "How it applies").selectOption("auto");
    await field(page, "Percent").fill("5");
    await field(page, "Valid from").fill("2099-01-01");
    await dialog(page).getByRole("button", { name: "Add discount", exact: true }).click();
    const ask = dialog(page).getByRole("group", { name: "Discount every bill?" });
    await expect(ask).toContainText("comes off every bill for every patient");
    await expect(ask.getByRole("button", { name: "Go back" })).toBeFocused();
    expect(await ruleOf(name)).toBeNull();
    await ask.getByRole("button", { name: "Go back" }).click();
    await expect(ask).toHaveCount(0);

    await check(page, OTHER_GROUP).check();
    await save(page, "Add discount");
    expect((await ruleOf(name)).group_ids).toEqual([seed.otherGroup.id]);

    await page.getByRole("button", { name: `Edit discount ${name}`, exact: true }).click();
    await check(page, OTHER_GROUP).uncheck();
    await dialog(page).getByRole("button", { name: "Save discount", exact: true }).click();
    await expect(ask).toBeVisible();
    expect((await ruleOf(name)).group_ids).toEqual([seed.otherGroup.id]);
    await ask.getByRole("button", { name: "Save for every bill" }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(row(page, name)).toContainText("Every service");
    expect(await ruleOf(name)).toMatchObject({ group_ids: null, valid_from: "2099-01-01" });

    await page.getByRole("button", { name: `Edit discount ${name}`, exact: true }).click();
    await field(page, "Percent").fill("6");
    await save(page, "Save discount");
    expect((await ruleOf(name)).value).toBe("6.00");
  });

  test("12. on a phone the page and the form fit the screen", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await openPage(page);
    await expect(row(page, CC50.name)).toBeVisible();
    const fits = () =>
      page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    expect(await fits()).toBe(true);
    await page.getByRole("button", { name: `Edit discount ${CC50.name}`, exact: true }).click();
    await expect(field(page, "Name")).toBeVisible();
    expect(await fits()).toBe(true);
  });

  test("8. reception can't open the page", async ({ page }) => {
    await loginAs(page, "reception");
    await gotoReady(page, "/settings/discounts", () => page.locator(".tabs"));
    await expect(page).not.toHaveURL(/\/settings|\/login/);
    await expect(page.getByRole("button", { name: "+ New discount" })).toHaveCount(0);
  });
});
