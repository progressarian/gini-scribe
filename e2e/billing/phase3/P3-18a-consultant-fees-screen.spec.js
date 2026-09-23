import crypto from "node:crypto";
import { test, expect } from "@playwright/test";
import { apiAs, loginAs } from "../../helpers/auth.mjs";
import { one, query } from "../../helpers/db.mjs";
import { gotoReady } from "../../helpers/browser.mjs";

const tag = crypto.randomBytes(3).toString("hex");
const T = tag.toUpperCase();
const TOP = { code: `p318a_${tag}`, label: `P318A CGHS ${tag}` };
const SUBS = {
  pensioner: { code: `p318a_pen_${tag}`, label: "Pensioner" },
  referral: { code: `p318a_ref_${tag}`, label: "CGHS Referral" },
  paid: { code: `p318a_paid_${tag}`, label: "CGHS Paid" },
};
const col = (key) => (key === "top" ? TOP.label : `${TOP.label} › ${SUBS[key].label}`);
const DOCTORS = {
  alpha: { name: `Dr Alpha P318A ${tag}`, price: 1000, fee: "350" },
  beta: { name: `Dr Beta P318A ${tag}`, price: 1000, fee: "350" },
  gamma: { name: `Dr Gamma P318A ${tag}`, price: 1500, fee: "700" },
};
const NOFEE = `Dr Delta P318A ${tag}`;
const BOTH = `Dr Eps P318A ${tag}`;
const STAFF = { code: `p318a_np_${tag}`, label: `P318A Staff ${tag}` };
const TAKEN = `P318AX${T}`;
const VISITS = ["New", "Follow Up"];
const seed = { items: {} };

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const cellOf = (page, key, doctor, visit) =>
  page.getByRole("table", { name: "Consultant fees" }).getByRole("button", {
    name: new RegExp(`^${esc(col(key))} for ${esc(doctor)} \\(${visit}\\):`),
  });
const dialog = (page) => page.getByRole("dialog");

async function openFees(page, role = "reception_admin") {
  await loginAs(page, role);
  await gotoReady(page, "/settings/consultant-fees", () =>
    page.getByLabel("Category", { exact: true }),
  );
}

async function onlyOurs(page) {
  await page.getByLabel("Category", { exact: true }).selectOption(TOP.code);
  await expect(page.getByRole("columnheader", { name: col("paid"), exact: true })).toBeVisible();
}

async function setCell(page, key, doctor, visit, { fee, pays, value }) {
  await cellOf(page, key, doctor, visit).click();
  const box = dialog(page);
  await expect(box).toBeVisible();
  if (fee !== undefined) await box.getByLabel("Fee (₹)", { exact: true }).fill(fee);
  if (pays) await box.getByLabel("Patient pays", { exact: true }).selectOption(pays);
  if (value !== undefined) await box.getByLabel(/^(Amount \(₹\)|Percent \(%\))$/).fill(value);
  await box.getByRole("button", { name: "Save", exact: true }).click();
}

const dbCell = async (scheme, itemId) => {
  const rate = await query(
    `SELECT rate::text FROM category_item_rates WHERE scheme_code = $1 AND service_item_id = $2`,
    [scheme, itemId],
  );
  const rule = await query(
    `SELECT patient_pays, remainder FROM category_payment_rules
      WHERE scheme_code = $1 AND service_item_id = $2 AND is_active`,
    [scheme, itemId],
  );
  return { rates: rate.rows.map((r) => Number(r.rate)), rules: rule.rows };
};

test.describe.serial("P3-18a consultant fees screen", () => {
  test.describe.configure({ retries: 1 });

  test.beforeAll(async () => {
    const api = await apiAs("admin");
    const post = async (path, data) => {
      const response = await api.post(`/api/billing/master/${path}`, { data });
      expect(response.status(), `${path} ${JSON.stringify(data)}`).toBe(201);
      return response.json();
    };
    const group = await post("groups", { code: `P318AG_${T}`, name: `P318A OPD ${tag}` });
    seed.subgroup = await post("subgroups", {
      group_id: group.id,
      code: `P318AS_${T}`,
      name: `P318A Consults ${tag}`,
    });
    for (const [key, doctor] of Object.entries(DOCTORS)) {
      doctor.id = (
        await one(
          `INSERT INTO doctors (name, role, pin, is_active) VALUES ($1, 'consultant', 'x', TRUE) RETURNING id`,
          [doctor.name],
        )
      ).id;
      for (const visit of VISITS) {
        const item = await post("items", {
          code: `P318A_${key.toUpperCase()}_${visit === "New" ? "NEW" : "FU"}_${T}`,
          name: `P318A consult ${key} ${visit} ${tag}`,
          subgroup_id: seed.subgroup.id,
          base_price: doctor.price,
          kind: "consultation",
          doctor_id: doctor.id,
          visit_type: visit,
        });
        seed.items[`${key}:${visit}`] = item.id;
      }
    }
    seed.nofee = (
      await one(
        `INSERT INTO doctors (name, role, pin, is_active) VALUES ($1, 'consultant', 'x', TRUE) RETURNING id`,
        [NOFEE],
      )
    ).id;
    seed.both = (
      await one(
        `INSERT INTO doctors (name, role, pin, is_active) VALUES ($1, 'consultant', 'x', TRUE) RETURNING id`,
        [BOTH],
      )
    ).id;
    await post("categories", { ...TOP, payer_name: "CGHS Wellness Centre" });
    await post("categories", STAFF);
    await post("discounts", {
      code: TAKEN,
      name: `P318A coupon ${tag}`,
      method: "code",
      kind: "percent",
      value: 5,
    });
    for (const sub of Object.values(SUBS)) {
      await post("categories", { ...sub, parent_code: TOP.code });
    }
    await api.dispose();
  });

  test.afterAll(async () => {
    const codes = [TOP.code, STAFF.code, ...Object.values(SUBS).map((s) => s.code)];
    await query(`DELETE FROM discount_rules WHERE code = $1`, [TAKEN]);
    await query(`DELETE FROM category_payment_rules WHERE scheme_code = ANY ($1)`, [codes]);
    await query(`DELETE FROM category_item_rates WHERE scheme_code = ANY ($1)`, [codes]);
    await query(
      `DELETE FROM service_item_price_history WHERE service_item_id IN
         (SELECT id FROM service_items WHERE subgroup_id = $1)`,
      [seed.subgroup?.id ?? 0],
    );
    await query(`DELETE FROM service_items WHERE subgroup_id = $1`, [seed.subgroup?.id ?? 0]);
    await query(`DELETE FROM service_subgroups WHERE code = $1`, [`P318AS_${T}`]);
    await query(`DELETE FROM service_groups WHERE code = $1`, [`P318AG_${T}`]);
    await query(`DELETE FROM patient_schemes WHERE parent_code = $1`, [TOP.code]);
    await query(`DELETE FROM patient_schemes WHERE code = ANY ($1)`, [[TOP.code, STAFF.code]]);
    await query(`DELETE FROM doctors WHERE name LIKE $1`, [`% P318A ${tag}`]);
  });

  test("1. reception can't open the page", async ({ page }) => {
    await loginAs(page, "reception");
    await gotoReady(page, "/settings/consultant-fees", () => page.locator(".tabs"), {
      timeout: 30000,
    });
    await expect(page).not.toHaveURL(/\/settings|\/login/);
    await expect(page.getByRole("table", { name: "Consultant fees" })).toHaveCount(0);
  });

  test("2. columns are General then the category and its sub-categories; inherited cells are greyed and say so", async ({
    page,
  }) => {
    await openFees(page);
    await onlyOurs(page);
    const headers = page.getByRole("table", { name: "Consultant fees" }).getByRole("columnheader");
    await expect(headers).toHaveText([
      "Doctor",
      "Visit",
      "General",
      TOP.label,
      col("paid"),
      col("referral"),
      col("pensioner"),
    ]);
    const { alpha } = DOCTORS;
    const pensioner = cellOf(page, "pensioner", alpha.name, "New");
    await expect(pensioner).toHaveAccessibleName(/₹1,000 fee inherited from the base price/);
    await expect(pensioner).toHaveClass(/cf-cell__btn--inherited/);
    await expect(pensioner).toContainText("inherited");

    await setCell(page, "top", alpha.name, "New", { fee: "500" });
    await expect(dialog(page)).toBeHidden();
    await expect(cellOf(page, "top", alpha.name, "New")).toHaveAccessibleName(/₹500 own fee/);
    await expect(pensioner).toHaveAccessibleName(/₹500 fee inherited from P318A CGHS/);
    await expect(pensioner).toContainText("₹500");
    await expect(pensioner.locator(".cf-dim").first()).toHaveText("₹500");
  });

  test("3. the three doctors' Pensioner fees are set with pays nothing and survive a reload", async ({
    page,
  }) => {
    await openFees(page);
    await onlyOurs(page);
    for (const doctor of Object.values(DOCTORS)) {
      for (const visit of VISITS) {
        await setCell(page, "pensioner", doctor.name, visit, { fee: doctor.fee, pays: "nothing" });
        await expect(dialog(page)).toBeHidden();
        await expect(cellOf(page, "pensioner", doctor.name, visit)).toHaveAccessibleName(
          new RegExp(`₹${doctor.fee} own fee, pays nothing \\(own rule\\)`),
        );
      }
    }
    await page.reload();
    await onlyOurs(page);
    for (const [key, doctor] of Object.entries(DOCTORS)) {
      for (const visit of VISITS) {
        const cell = cellOf(page, "pensioner", doctor.name, visit);
        await expect(cell).toContainText(`₹${doctor.fee}`);
        await expect(cell).toContainText("pays nothing");
        await expect(cell).not.toHaveClass(/cf-cell__btn--inherited/);
        expect(await dbCell(SUBS.pensioner.code, seed.items[`${key}:${visit}`])).toEqual({
          rates: [Number(doctor.fee)],
          rules: [{ patient_pays: "nothing", remainder: "claim" }],
        });
      }
    }
  });

  test("4. Copy column to… copies Pensioner to CGHS Referral after a confirmation", async ({
    page,
  }) => {
    await openFees(page);
    await onlyOurs(page);
    await page.getByRole("button", { name: "Copy column to…" }).click();
    const box = dialog(page);
    await box.getByLabel("Copy from", { exact: true }).selectOption(SUBS.pensioner.code);
    await box.getByLabel("Copy to", { exact: true }).selectOption(SUBS.referral.code);
    await box.getByRole("button", { name: "Copy…" }).click();
    const confirm = box.getByRole("group", { name: "Confirm the copy" });
    await expect(confirm).toContainText(`Copy ${col("pensioner")} to ${col("referral")}?`);
    expect((await dbCell(SUBS.referral.code, seed.items["alpha:New"])).rates).toEqual([]);
    await confirm.getByRole("button", { name: "Copy", exact: true }).click();
    await expect(box).toBeHidden();
    await page.reload();
    await onlyOurs(page);
    for (const [key, doctor] of Object.entries(DOCTORS)) {
      for (const visit of VISITS) {
        await expect(cellOf(page, "referral", doctor.name, visit)).toHaveAccessibleName(
          new RegExp(`₹${doctor.fee} own fee, pays nothing \\(own rule\\)`),
        );
        expect(await dbCell(SUBS.referral.code, seed.items[`${key}:${visit}`])).toEqual({
          rates: [Number(doctor.fee)],
          rules: [{ patient_pays: "nothing", remainder: "claim" }],
        });
      }
    }
  });

  test("5. a pays-amount above the fee is refused with a readable message and nothing is saved", async ({
    page,
  }) => {
    await openFees(page);
    await onlyOurs(page);
    const { alpha } = DOCTORS;
    await setCell(page, "pensioner", alpha.name, "New", { pays: "amount", value: "400" });
    const alert = dialog(page).getByRole("alert");
    await expect(alert).toContainText("can't pay ₹400");
    await expect(alert).toContainText("the fee there is ₹350");
    await dialog(page).getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog(page)).toBeHidden();
    await expect(cellOf(page, "pensioner", alpha.name, "New")).toHaveAccessibleName(
      /₹350 own fee, pays nothing/,
    );
    expect((await dbCell(SUBS.pensioner.code, seed.items["alpha:New"])).rules).toEqual([
      { patient_pays: "nothing", remainder: "claim" },
    ]);
  });

  test("6. Clear drops the cell's own fee and rule, and it falls back to what it inherits", async ({
    page,
  }) => {
    await openFees(page);
    await onlyOurs(page);
    const { alpha } = DOCTORS;
    await cellOf(page, "pensioner", alpha.name, "New").click();
    await dialog(page).getByRole("button", { name: "Clear", exact: true }).click();
    const confirm = dialog(page).getByRole("group", { name: "Clear this cell?" });
    await confirm.getByRole("button", { name: "Clear", exact: true }).click();
    await expect(dialog(page)).toBeHidden();
    const cell = cellOf(page, "pensioner", alpha.name, "New");
    await expect(cell).toHaveAccessibleName(
      new RegExp(`₹500 fee inherited from ${esc(TOP.label)}, pays full`),
    );
    await expect(cell).toHaveClass(/cf-cell__btn--inherited/);
    expect(await dbCell(SUBS.pensioner.code, seed.items["alpha:New"])).toEqual({
      rates: [],
      rules: [],
    });
    await expect(cellOf(page, "pensioner", alpha.name, "Follow Up")).toHaveAccessibleName(
      /₹350 own fee/,
    );
  });

  test("7. the doctor and category filters narrow the grid", async ({ page }) => {
    await openFees(page);
    await page.getByLabel("Doctor", { exact: true }).selectOption(String(DOCTORS.beta.id));
    const table = page.getByRole("table", { name: "Consultant fees" });
    await expect(table.getByRole("rowheader")).toHaveCount(2);
    await expect(table.getByRole("rowheader").first()).toContainText(DOCTORS.beta.name);
    await expect(table.getByRole("columnheader", { name: col("paid"), exact: true })).toBeVisible();
    await page.getByLabel("Category", { exact: true }).selectOption(SUBS.referral.code);
    await expect(table.getByRole("columnheader")).toHaveText([
      "Doctor",
      "Visit",
      "General",
      col("referral"),
    ]);
    await expect(table.getByRole("rowheader")).toHaveCount(2);
    await expect(cellOf(page, "referral", DOCTORS.beta.name, "Follow Up")).toHaveAccessibleName(
      /₹350 own fee/,
    );
    await expect(table).not.toContainText(DOCTORS.alpha.name);
  });

  test("8. a doctor with no item is listed as not priced, and Create item adds one at the asked price", async ({
    page,
  }) => {
    await openFees(page);
    await page.getByLabel("Doctor", { exact: true }).selectOption(String(seed.nofee));
    const list = page.getByRole("table", { name: "Not priced" });
    await expect(list.getByRole("row")).toHaveCount(3);
    await list.getByRole("button", { name: `Create item for ${NOFEE} (New)` }).click();
    const box = dialog(page);
    await box.getByRole("button", { name: "Create item", exact: true }).click();
    await expect(box).toBeVisible();
    await box.getByLabel("Price (₹)", { exact: true }).pressSequentially("8a00");
    await expect(box.getByLabel("Price (₹)", { exact: true })).toHaveValue("800");
    await box.getByLabel("Subgroup", { exact: true }).selectOption(String(seed.subgroup.id));
    await box.getByRole("button", { name: "Create item", exact: true }).click();
    await expect(box).toBeHidden();
    await expect(list.getByRole("row")).toHaveCount(2);
    await expect(list).toContainText("Follow Up");
    const table = page.getByRole("table", { name: "Consultant fees" });
    await expect(table.getByRole("rowheader")).toHaveCount(1);
    await expect(table.getByRole("row").nth(1)).toContainText("₹800");
    const item = await one(
      `SELECT base_price::text, subgroup_id, visit_type, kind FROM service_items
        WHERE doctor_id = $1 AND is_active`,
      [seed.nofee],
    );
    expect(item).toEqual({
      base_price: "800.00",
      subgroup_id: seed.subgroup.id,
      visit_type: "New",
      kind: "consultation",
    });
  });

  test("9. on a phone the page doesn't scroll sideways; the grid scrolls inside its own box", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await openFees(page);
    await onlyOurs(page);
    await expect(cellOf(page, "pensioner", DOCTORS.beta.name, "New")).toBeAttached();
    const widths = await page.evaluate(() => ({
      page: document.documentElement.scrollWidth,
      view: window.innerWidth,
    }));
    expect(widths.page).toBeLessThanOrEqual(widths.view);
    await cellOf(page, "pensioner", DOCTORS.beta.name, "New").click();
    const box = await dialog(page).boundingBox();
    expect(box.width).toBeLessThanOrEqual(390);
    await dialog(page).getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog(page)).toBeHidden();
  });

  test("10. a failed load says so instead of loading forever", async ({ page }) => {
    await page.route(
      (url) => url.pathname.endsWith("/api/billing/master/consultant-fees"),
      (route) => route.fulfill({ status: 500, json: { error: "boom" } }),
    );
    await openFees(page);
    await expect(page.getByText("Could not load the consultant fees.")).toBeVisible({
      timeout: 20000,
    });
  });

  test("11. a bill code already used by a discount is refused with the server's words; the editor stays open", async ({
    page,
  }) => {
    await openFees(page);
    await onlyOurs(page);
    const { beta } = DOCTORS;
    await cellOf(page, "paid", beta.name, "New").click();
    const box = dialog(page);
    await box.getByLabel("Fee (₹)", { exact: true }).fill("600");
    await box.getByLabel("Bill code", { exact: true }).fill(TAKEN);
    await box.getByRole("button", { name: "Save", exact: true }).click();
    await expect(box.getByRole("alert")).toHaveText(
      `${TAKEN} is already the code of the discount "P318A coupon ${tag}"; choose another bill code`,
    );
    await expect(box).toBeVisible();
    expect(await dbCell(SUBS.paid.code, seed.items["beta:New"])).toEqual({ rates: [], rules: [] });
    await box.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(box).toBeHidden();
  });

  test("12. keyboard: Enter opens a cell's editor with focus inside, Escape closes it and focus returns to the cell", async ({
    page,
  }) => {
    await openFees(page);
    await onlyOurs(page);
    const cell = cellOf(page, "paid", DOCTORS.gamma.name, "Follow Up");
    await cell.focus();
    await page.keyboard.press("Enter");
    const box = dialog(page);
    await expect(box).toBeVisible();
    await expect(box.getByLabel("Fee (₹)", { exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(box).toBeHidden();
    await expect(cell).toBeFocused();

    await page.keyboard.press("Enter");
    await page.keyboard.type("900");
    await page.keyboard.press("Enter");
    await expect(box).toBeHidden();
    await expect(cell).toHaveAccessibleName(/₹900 own fee/);
    await expect(cell).toBeFocused();
  });

  test("13. with no payer, turning a cell's 'full fee' into 'nothing' sends the rest to adjustment", async ({
    page,
  }) => {
    await openFees(page);
    await page.getByLabel("Category", { exact: true }).selectOption(STAFF.code);
    const cell = page.getByRole("table", { name: "Consultant fees" }).getByRole("button", {
      name: new RegExp(`^${esc(STAFF.label)} for ${esc(DOCTORS.alpha.name)} \\(New\\):`),
    });
    await cell.click();
    await dialog(page).getByLabel("Patient pays", { exact: true }).selectOption("full");
    await dialog(page).getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog(page)).toBeHidden();
    await expect(cell).toHaveAccessibleName(/pays full \(own rule\)/);

    await cell.click();
    await dialog(page).getByLabel("Patient pays", { exact: true }).selectOption("nothing");
    await expect(dialog(page).getByLabel("The rest goes to", { exact: true })).toHaveValue(
      "adjustment",
    );
    await dialog(page).getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog(page)).toBeHidden();
    await expect(cell).toHaveAccessibleName(/pays nothing \(own rule\)/);
    expect((await dbCell(STAFF.code, seed.items["alpha:New"])).rules).toEqual([
      { patient_pays: "nothing", remainder: "adjustment" },
    ]);
  });

  test("14. when the category list fails the Category filter says so and the grid still works", async ({
    page,
  }) => {
    await page.route(
      (url) => url.pathname.endsWith("/api/billing/master/categories"),
      (route) => route.fulfill({ status: 500, json: { error: "boom" } }),
    );
    await openFees(page);
    await expect(
      page.getByText("Could not load the categories — the grid below still shows every category."),
    ).toBeVisible({ timeout: 20000 });
    await expect(page.getByText(/Could not load the doctors/)).toHaveCount(0);
    await expect(
      page
        .getByRole("table", { name: "Consultant fees" })
        .getByRole("columnheader", { name: col("paid"), exact: true }),
    ).toBeVisible();
  });

  test("15. when the doctor list fails the Doctor filter says so and the grid still works", async ({
    page,
  }) => {
    await page.route(
      (url) => url.pathname.endsWith("/api/billing/master/items/choices"),
      (route) => route.fulfill({ status: 500, json: { error: "boom" } }),
    );
    await openFees(page);
    await expect(
      page.getByText("Could not load the doctors — the grid below still shows every doctor."),
    ).toBeVisible({ timeout: 20000 });
    await expect(page.getByText(/Could not load the categories/)).toHaveCount(0);
    await onlyOurs(page);
    await expect(cellOf(page, "pensioner", DOCTORS.beta.name, "New")).toBeVisible();
  });

  test("16. after Create item focus moves to the next Not priced row, then to the grid when the list empties", async ({
    page,
  }) => {
    await openFees(page);
    await page.getByLabel("Doctor", { exact: true }).selectOption(String(seed.both));
    const list = page.getByRole("table", { name: "Not priced" });
    await expect(list.getByRole("row")).toHaveCount(3);
    const create = async () => {
      const box = dialog(page);
      await box.getByLabel("Price (₹)", { exact: true }).fill("400");
      await box.getByLabel("Subgroup", { exact: true }).selectOption(String(seed.subgroup.id));
      await box.getByRole("button", { name: "Create item", exact: true }).click();
      await expect(box).toBeHidden();
    };

    await list.getByRole("button", { name: `Create item for ${BOTH} (New)` }).click();
    await create();
    await expect(list.getByRole("row")).toHaveCount(2);
    await expect(
      list.getByRole("button", { name: `Create item for ${BOTH} (Follow Up)` }),
    ).toBeFocused();

    await page.keyboard.press("Enter");
    await create();
    await expect(list).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Fees", exact: true })).toBeFocused();
  });
});
