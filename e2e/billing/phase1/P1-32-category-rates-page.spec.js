import crypto from "node:crypto";
import { test, expect } from "@playwright/test";
import { apiAs, loginAs } from "../../helpers/auth.mjs";
import { one, query } from "../../helpers/db.mjs";
import { gotoReady } from "../../helpers/browser.mjs";

const tag = crypto.randomBytes(3).toString("hex");
const TOP = { code: `p132_${tag}`, label: `P132 CGHS ${tag}` };
const SUBS = [
  { code: `p132_paid_${tag}`, label: "CGHS Paid" },
  { code: `p132_ref_${tag}`, label: "CGHS Referral" },
  { code: `p132_pen_${tag}`, label: "Pensioner" },
];
const CONSULT = `P132 Consultation ${tag}`;
const DRESSING = `P132 Dressing ${tag}`;
const seed = {};

const pickCategory = (page, value) =>
  page.getByLabel("Category", { exact: true }).selectOption(value);
const rates = (page) => page.getByRole("table", { name: "Rates" });
const row = (page, name) => rates(page).getByRole("row", { name: new RegExp(name) });
const rateOf = (scheme) =>
  query(
    `SELECT rate::text, bill_code, valid_from::text, valid_to::text FROM category_item_rates
      WHERE scheme_code = $1 AND service_item_id = $2 ORDER BY valid_from`,
    [scheme, seed.consult.id],
  ).then((r) => r.rows);

async function openRates(page) {
  await loginAs(page, "reception_admin");
  await gotoReady(page, "/settings/category-rates", () =>
    page.getByLabel("Category", { exact: true }),
  );
}

async function editRate(page, name, values) {
  await rates(page)
    .getByRole("button", { name: `Edit rate for ${name}`, exact: true })
    .click();
  for (const [label, value] of Object.entries(values)) {
    await rates(page).getByLabel(`${label} for ${name}`, { exact: true }).fill(value);
  }
  await row(page, name).getByRole("button", { name: "Save", exact: true }).click();
}

test.describe.serial("P1-32 category rates page", () => {
  test.describe.configure({ retries: 1 });

  test.beforeAll(async () => {
    const api = await apiAs("admin");
    const post = async (path, data) => {
      const response = await api.post(`/api/billing/master/${path}`, { data });
      expect(response.status(), `${path} ${JSON.stringify(data)}`).toBe(201);
      return response.json();
    };
    seed.doctor = await one(
      `INSERT INTO doctors (name, role, pin, is_active) VALUES ($1, 'consultant', 'x', TRUE) RETURNING id`,
      [`Dr P132 ${tag}`],
    );
    const consultGroup = await post("groups", { code: `P132GC_${tag}`, name: `P132 Fees ${tag}` });
    const consultSub = await post("subgroups", {
      group_id: consultGroup.id,
      code: `P132SC_${tag}`,
      name: "OPD",
    });
    seed.otherGroup = await post("groups", { code: `P132GO_${tag}`, name: `P132 Care ${tag}` });
    const otherSub = await post("subgroups", {
      group_id: seed.otherGroup.id,
      code: `P132SO_${tag}`,
      name: "Wound care",
    });
    seed.consult = await post("items", {
      code: `P132C_${tag}`,
      name: CONSULT,
      subgroup_id: consultSub.id,
      base_price: 1000,
      kind: "consultation",
      doctor_id: seed.doctor.id,
      visit_type: "New",
    });
    await post("items", {
      code: `P132D_${tag}`,
      name: DRESSING,
      subgroup_id: otherSub.id,
      base_price: 250,
      kind: "procedure",
    });
    await post("categories", TOP);
    for (const sub of SUBS) await post("categories", { ...sub, parent_code: TOP.code });
    await api.dispose();
    seed.tomorrow = (
      await one(`SELECT ((NOW() AT TIME ZONE 'Asia/Kolkata')::date + 1)::text AS d`)
    ).d;
    seed.today = (await one(`SELECT (NOW() AT TIME ZONE 'Asia/Kolkata')::date::text AS d`)).d;
  });

  test.afterAll(async () => {
    await query(`DELETE FROM category_item_rates WHERE scheme_code LIKE $1`, [`p132%${tag}`]);
    await query(
      `DELETE FROM service_item_price_history WHERE service_item_id IN
         (SELECT id FROM service_items WHERE code LIKE $1)`,
      [`P132%${tag}`],
    );
    await query(`DELETE FROM service_items WHERE code LIKE $1`, [`P132%${tag}`]);
    await query(`DELETE FROM service_subgroups WHERE code LIKE $1`, [`P132%${tag}`]);
    await query(`DELETE FROM service_groups WHERE code LIKE $1`, [`P132%${tag}`]);
    await query(`DELETE FROM patient_schemes WHERE parent_code = $1`, [TOP.code]);
    await query(`DELETE FROM patient_schemes WHERE code = $1`, [TOP.code]);
    if (seed.doctor) await query(`DELETE FROM doctors WHERE id = $1`, [seed.doctor.id]);
  });

  test("1. a CGHS rate with bill code CC02 is saved for a consultation item", async ({ page }) => {
    await openRates(page);
    await pickCategory(page, TOP.code);
    await expect(row(page, CONSULT)).toContainText("Base price");
    await editRate(page, CONSULT, { Rate: "800", "Bill code": "CC02" });
    await expect(row(page, CONSULT)).toContainText("₹800");
    await expect(row(page, CONSULT)).toContainText("Own");
    await expect(row(page, CONSULT)).toContainText("CC02");
    expect(await rateOf(TOP.code)).toEqual([
      { rate: "800.00", bill_code: "CC02", valid_from: seed.today, valid_to: null },
    ]);
  });

  test("2. CGHS Paid, CGHS Referral and Pensioner show it as inherited", async ({ page }) => {
    await openRates(page);
    for (const sub of SUBS) {
      await pickCategory(page, sub.code);
      await expect(
        page.getByRole("heading", { level: 2, name: `${TOP.label} › ${sub.label}` }),
      ).toBeVisible();
      const r = row(page, CONSULT);
      await expect(r).toContainText("₹800");
      await expect(r).toContainText("CC02");
      await expect(r).toContainText(`From ${TOP.label}`);
      await expect(r).toContainText("Inherited");
      await expect(
        r.getByRole("button", { name: `Clear rate for ${CONSULT}`, exact: true }),
      ).toHaveCount(0);
    }
  });

  test("3. a sub-category's own rate overrides the parent's for that sub-category only", async ({
    page,
  }) => {
    await openRates(page);
    await pickCategory(page, SUBS[2].code);
    await editRate(page, CONSULT, { Rate: "600" });
    await expect(row(page, CONSULT)).toContainText("₹600");
    await expect(row(page, CONSULT)).toContainText("CC02");
    await pickCategory(page, SUBS[0].code);
    await expect(row(page, CONSULT)).toContainText("₹800");
    expect((await rateOf(SUBS[2].code))[0]).toMatchObject({ rate: "600.00", bill_code: null });
  });

  test("4. setting only a bill code keeps the inherited rate", async ({ page }) => {
    await openRates(page);
    await pickCategory(page, SUBS[0].code);
    await rates(page)
      .getByRole("button", { name: `Edit rate for ${CONSULT}`, exact: true })
      .click();
    await expect(rates(page).getByLabel(`Rate for ${CONSULT}`, { exact: true })).toHaveValue("");
    await rates(page).getByLabel(`Bill code for ${CONSULT}`, { exact: true }).fill("CC03");
    await row(page, CONSULT).getByRole("button", { name: "Save", exact: true }).click();
    const r = row(page, CONSULT);
    await expect(r).toContainText("CC03");
    await expect(r).toContainText("₹800");
    await expect(r).toContainText(`From ${TOP.label}`);
    expect((await rateOf(SUBS[0].code))[0]).toMatchObject({ rate: null, bill_code: "CC03" });
  });

  test("5. the group filter narrows the grid", async ({ page }) => {
    await openRates(page);
    await pickCategory(page, TOP.code);
    await expect(row(page, CONSULT)).toBeVisible();
    await page.getByLabel("Group", { exact: true }).selectOption(String(seed.otherGroup.id));
    await expect(row(page, DRESSING)).toBeVisible();
    await expect(row(page, CONSULT)).toHaveCount(0);
  });

  test("6. a change from tomorrow leaves today's rate and shows when it changes", async ({
    page,
  }) => {
    await openRates(page);
    await pickCategory(page, TOP.code);
    await editRate(page, CONSULT, { Rate: "900", From: seed.tomorrow });
    await expect(row(page, CONSULT)).toContainText("₹800");
    await expect(row(page, CONSULT)).toContainText(`Changes on ${seed.tomorrow}`);
    await page.getByLabel("As of", { exact: true }).fill(seed.tomorrow);
    await expect(row(page, CONSULT)).toContainText("₹900");
    expect(await rateOf(TOP.code)).toEqual([
      { rate: "800.00", bill_code: "CC02", valid_from: seed.today, valid_to: seed.today },
      { rate: "900.00", bill_code: "CC02", valid_from: seed.tomorrow, valid_to: null },
    ]);
  });

  test("7. clearing tomorrow's rate can go back to today's", async ({ page }) => {
    await openRates(page);
    await pickCategory(page, TOP.code);
    await page.getByLabel("As of", { exact: true }).fill(seed.tomorrow);
    await expect(row(page, CONSULT)).toContainText("₹900");
    await rates(page)
      .getByRole("button", { name: `Clear rate for ${CONSULT}`, exact: true })
      .click();
    await row(page, CONSULT)
      .getByRole("button", { name: "Clear and go back to ₹800", exact: true })
      .click();
    await expect(row(page, CONSULT)).toContainText("₹800");
    expect(await rateOf(TOP.code)).toEqual([
      { rate: "800.00", bill_code: "CC02", valid_from: seed.today, valid_to: null },
    ]);
  });

  test("8. clearing a sub-category's own rate goes back to the parent's", async ({ page }) => {
    await openRates(page);
    await pickCategory(page, SUBS[2].code);
    await expect(row(page, CONSULT)).toContainText("₹600");
    await rates(page)
      .getByRole("button", { name: `Clear rate for ${CONSULT}`, exact: true })
      .click();
    await expect(
      row(page, CONSULT).getByRole("button", { name: /^Clear and go back/ }),
    ).toHaveCount(0);
    await row(page, CONSULT).getByRole("button", { name: "Clear", exact: true }).click();
    await expect(row(page, CONSULT)).toContainText(`From ${TOP.label}`);
    await expect(row(page, CONSULT)).toContainText("₹800");
    expect(await rateOf(SUBS[2].code)).toEqual([]);
  });

  test("9. a refused save shows why in the row", async ({ page }) => {
    await openRates(page);
    await pickCategory(page, TOP.code);
    await editRate(page, CONSULT, { "Bill code": "CC 02" });
    await expect(row(page, CONSULT).getByRole("alert")).toBeVisible();
    expect(await rateOf(TOP.code)).toHaveLength(1);
  });
});
