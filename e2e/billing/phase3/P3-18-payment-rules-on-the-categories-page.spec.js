import crypto from "node:crypto";
import { test, expect } from "@playwright/test";
import { apiAs, loginAs } from "../../helpers/auth.mjs";
import { one, query } from "../../helpers/db.mjs";
import { gotoReady } from "../../helpers/browser.mjs";

const tag = crypto.randomBytes(3).toString("hex");
const T = tag.toUpperCase();
const PAYER = `Govt of India P318 ${tag}`;
const TOP = { code: `p318_${tag}`, label: `P318 CGHS ${tag}`, payer_name: PAYER };
const PAID = { code: `p318_paid_${tag}`, label: "CGHS Paid" };
const REF = { code: `p318_ref_${tag}`, label: "CGHS Referral" };
const PEN = { code: `p318_pen_${tag}`, label: "Pensioner" };
const NOPAYER = { code: `p318_np_${tag}`, label: `P318 Staff ${tag}` };
const RETIRED = { code: `p318_old_${tag}`, label: `P318 Old ${tag}` };
const RETIRED_RULE = `P318 old half ${tag}`;
const CONSULTS = `P318 Consultations ${tag}`;
const CARE = `P318 Care ${tag}`;
const GROUP = `P318 OPD ${tag}`;
const NEW = `P318 Consult New ${tag}`;
const FU = `P318 Consult FU ${tag}`;
const DRESSING = `P318 Dressing ${tag}`;
const MISC_GROUP = `P318 Misc ${tag}`;
const ODD = `P318 Odd ${tag}`;
const ODD_RULE = `P318 odd 12.7% ${tag}`;
const ODD_DISCOUNT = `P318 misc 10% ${tag}`;
const DRAFT_RULE = `P318 odd draft ${tag}`;
const STAFF_RULE = `P318 staff full ${tag}`;
const PARENT_RULE = `P318 CGHS care default ${tag}`;
const PAID_RULE = "CGHS Paid — consultation ₹700";
const REF_RULE = "CGHS Referral — consultation";
const PEN_RULE = "Pensioner — consultation";
const seed = {};

const tree = (page) => page.getByRole("region", { name: "Categories" });
const pick = (page, { label, code }) =>
  tree(page).getByRole("button", { name: new RegExp(`^${label} ${code}\\b`) });
const nameOf = (sub) => `${TOP.label} › ${sub.label}`;
const panel = (page, name) =>
  page.getByRole("region", { name: `What the patient pays for ${name}`, exact: true });
const ownTable = (page, name) =>
  panel(page, name).getByRole("table", { name: "Payment rules", exact: true });
const addForm = (page, name) =>
  panel(page, name).getByRole("form", { name: "Add a payment rule", exact: true });
const preview = (form) => form.getByRole("region", { name: "Test this rule" });
async function openTest(form) {
  const toggle = preview(form).getByRole("button", { name: /^Test this rule/ });
  if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
}
const split = (form, label) => preview(form).getByRole("group", { name: label, exact: true });

async function openCategory(page, category, role = "reception_admin") {
  await loginAs(page, role);
  await gotoReady(page, "/settings/schemes", () => tree(page));
  await pick(page, category).click();
}

async function openAdd(page, name) {
  await panel(page, name).getByRole("button", { name: "+ Payment rule", exact: true }).click();
  return addForm(page, name);
}

async function fillRule(form, { name, subgroup, group, visits = [], pays, value }) {
  await form.getByLabel("Rule name", { exact: true }).fill(name);
  if (subgroup) {
    await form.getByLabel("Applies to", { exact: true }).selectOption("subgroup");
    await form.getByLabel("Subgroup", { exact: true }).selectOption({ label: subgroup });
  }
  if (group) {
    await form.getByLabel("Applies to", { exact: true }).selectOption("group");
    await form.getByLabel("Group", { exact: true }).selectOption({ label: group });
  }
  for (const v of visits) await form.getByRole("checkbox", { name: v, exact: true }).check();
  await form.getByLabel("Patient pays", { exact: true }).selectOption(pays);
  if (value !== undefined) await form.getByLabel(/^(Amount \(₹\)|Percent \(%\))$/).fill(value);
}

async function previewItem(form, itemName) {
  await openTest(form);
  await form.getByLabel("Find preview item", { exact: true }).fill(itemName);
  const select = form.getByLabel("Preview item", { exact: true });
  await expect(select.locator("option", { hasText: itemName })).toHaveCount(1);
  await select.selectOption({ label: await optionLabel(select, itemName) });
}

const optionLabel = async (select, itemName) =>
  (await select.locator("option", { hasText: itemName }).textContent()).trim();

const money = (amount) => {
  const rupee = amount / 100;
  return `₹${rupee.toLocaleString("en-IN", {
    minimumFractionDigits: Number.isInteger(rupee) ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
};

const ruleRow = (page, name, ruleName) =>
  ownTable(page, name).getByRole("row").filter({ hasText: ruleName });

const saved = (schemeCode) =>
  query(
    `SELECT name, group_id, subgroup_id, service_item_id, visit_types, patient_pays,
            patient_value::float8 AS patient_value, remainder, priority, valid_to::text AS valid_to,
            is_active
       FROM category_payment_rules WHERE scheme_code = $1 ORDER BY id`,
    [schemeCode],
  ).then((r) => r.rows);

test.describe.serial("P3-18 payment rules on the categories page", () => {
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
      [`Dr P318 ${tag}`],
    );
    const group = await post("groups", { code: `P318G_${T}`, name: GROUP });
    seed.group = group.id;
    seed.consults = (
      await post("subgroups", { group_id: group.id, code: `P318SC_${T}`, name: CONSULTS })
    ).id;
    seed.care = (
      await post("subgroups", { group_id: group.id, code: `P318SW_${T}`, name: CARE })
    ).id;
    for (const [code, name, price, visit] of [
      [`P318N_${T}`, NEW, 1500, "New"],
      [`P318F_${T}`, FU, 1000, "Follow Up"],
    ]) {
      await post("items", {
        code,
        name,
        subgroup_id: seed.consults,
        base_price: price,
        kind: "consultation",
        doctor_id: seed.doctor.id,
        visit_type: visit,
      });
    }
    await post("items", {
      code: `P318D_${T}`,
      name: DRESSING,
      subgroup_id: seed.care,
      base_price: 300,
      kind: "procedure",
    });
    const misc = await post("groups", { code: `P318M_${T}`, name: MISC_GROUP });
    seed.misc = misc.id;
    const miscSub = await post("subgroups", {
      group_id: misc.id,
      code: `P318MS_${T}`,
      name: `P318 Misc items ${tag}`,
    });
    seed.odd = (
      await post("items", {
        code: `P318O_${T}`,
        name: ODD,
        subgroup_id: miscSub.id,
        base_price: 205,
        kind: "procedure",
      })
    ).id;
    await post("categories", TOP);
    await post("categories", NOPAYER);
    await post("payment-rules", {
      scheme_code: NOPAYER.code,
      name: STAFF_RULE,
      group_id: misc.id,
      patient_pays: "full",
    });
    for (const sub of [PAID, REF, PEN]) await post("categories", { ...sub, parent_code: TOP.code });
    await post("payment-rules", {
      scheme_code: TOP.code,
      name: PARENT_RULE,
      subgroup_id: seed.care,
      patient_pays: "percent",
      patient_value: 20,
      remainder: "claim",
    });
    await api.dispose();
  });

  test.afterAll(async () => {
    await query(`DELETE FROM category_payment_rules WHERE scheme_code LIKE $1`, [`p318%${tag}`]);
    await query(
      `DELETE FROM service_item_price_history WHERE service_item_id IN
         (SELECT id FROM service_items WHERE code LIKE $1)`,
      [`P318%${T}`],
    );
    await query(`DELETE FROM service_items WHERE code LIKE $1`, [`P318%${T}`]);
    await query(`DELETE FROM service_subgroups WHERE code LIKE $1`, [`P318%${T}`]);
    await query(`DELETE FROM service_groups WHERE code LIKE $1`, [`P318%${T}`]);
    await query(`DELETE FROM patient_schemes WHERE parent_code = $1`, [TOP.code]);
    await query(`DELETE FROM patient_schemes WHERE code = ANY ($1)`, [
      [TOP.code, NOPAYER.code, RETIRED.code],
    ]);
    if (seed.doctor) await query(`DELETE FROM doctors WHERE id = $1`, [seed.doctor.id]);
  });

  test("1. reception can't reach the panel or its rules", async ({ page }) => {
    await loginAs(page, "reception");
    await page.goto("/settings/schemes");
    await expect(page).not.toHaveURL(/\/settings/);
    await expect(page.getByRole("region", { name: /^What the patient pays/ })).toHaveCount(0);
    const api = await apiAs("reception");
    const listed = await api.get(`/api/billing/master/payment-rules?schemeCode=${PAID.code}`);
    expect(listed.status()).toBe(403);
    await api.dispose();
  });

  test("2. the parent holds its own rule; a sub-category shows it read-only as inherited", async ({
    page,
  }) => {
    await openCategory(page, TOP);
    const own = ownTable(page, TOP.label);
    await expect(own.getByRole("row").filter({ hasText: PARENT_RULE })).toContainText(
      `Subgroup: ${CARE}`,
    );
    await expect(
      own.getByRole("button", { name: `Edit payment rule ${PARENT_RULE}` }),
    ).toBeVisible();
    await expect(
      panel(page, TOP.label).getByRole("table", { name: "Inherited payment rules" }),
    ).toHaveCount(0);

    await pick(page, PAID).click();
    const paid = panel(page, nameOf(PAID));
    await expect(paid).toContainText("No rules of its own yet");
    const inherited = paid.getByRole("table", { name: "Inherited payment rules" });
    const row = inherited.getByRole("row").filter({ hasText: PARENT_RULE });
    await expect(row).toContainText("20%");
    await expect(row).toContainText("Claim");
    await expect(paid).toContainText(`From ${TOP.label}`);
    await expect(paid.getByText("inherited", { exact: true })).toBeVisible();
    await expect(inherited.getByRole("button")).toHaveCount(0);
    await expect(paid.getByRole("table", { name: "Payment rules", exact: true })).toHaveCount(0);
  });

  test("3. validation messages are readable", async ({ page }) => {
    await openCategory(page, PAID);
    const form = await openAdd(page, nameOf(PAID));
    await form.getByRole("button", { name: "Add payment rule", exact: true }).click();
    await expect(form.getByRole("alert")).toHaveText("Give the rule a name");
    await form.getByLabel("Rule name", { exact: true }).fill("P318 bad");
    await form.getByLabel("Applies to", { exact: true }).selectOption("subgroup");
    await form.getByRole("button", { name: "Add payment rule", exact: true }).click();
    await expect(form.getByRole("alert")).toHaveText("Choose the subgroup the rule is for");
    await form.getByLabel("Subgroup", { exact: true }).selectOption({ label: CONSULTS });
    await form.getByRole("button", { name: "Add payment rule", exact: true }).click();
    await expect(form.getByRole("alert")).toHaveText("Enter the amount in rupees the patient pays");

    await form.getByLabel("Patient pays", { exact: true }).selectOption("percent");
    const percent = form.getByLabel("Percent (%)", { exact: true });
    await percent.fill("15x0");
    await expect(percent).toHaveValue("150");
    await form.getByRole("button", { name: "Add payment rule", exact: true }).click();
    await expect(form.getByRole("alert")).toHaveText("The percent must be from 0 to 100");

    await percent.fill("50");
    await form.getByLabel("From", { exact: true }).fill("2026-12-10");
    await form.getByLabel("To", { exact: true }).fill("2026-12-01");
    await form.getByRole("button", { name: "Add payment rule", exact: true }).click();
    await expect(form.getByRole("alert")).toHaveText("To date can't be before the From date");

    await form.getByLabel("Patient pays", { exact: true }).selectOption("full");
    await expect(form.getByLabel("Percent (%)", { exact: true })).toHaveCount(0);
    await expect(form.getByLabel("The rest", { exact: true })).toHaveCount(0);
    await form.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(addForm(page, nameOf(PAID))).toHaveCount(0);
    expect(await saved(PAID.code)).toEqual([]);
  });

  test("4. an amount above an item's price is refused with the items listed", async ({ page }) => {
    await openCategory(page, PAID);
    const form = await openAdd(page, nameOf(PAID));
    await fillRule(form, {
      name: "P318 whole group ₹700",
      group: GROUP,
      pays: "amount",
      value: "700",
    });
    await form.getByRole("button", { name: "Add payment rule", exact: true }).click();
    const list = form.getByRole("list", { name: "Items that cost less" });
    await expect(list.getByRole("listitem")).toHaveCount(1);
    await expect(list.getByRole("listitem")).toHaveText(`${DRESSING} (P318D_${T}) — ₹300`);
    await expect(form).toContainText("The patient can't pay ₹700 for this item — it costs less:");
    await expect(form).toContainText("Lower the amount, or put the rule on only the items");
    expect(await saved(PAID.code)).toEqual([]);
    await form.getByRole("button", { name: "Cancel", exact: true }).click();
  });

  test("5. CGHS Paid: ₹700 for New and Follow Up consultations, previewed and saved", async ({
    page,
  }) => {
    await openCategory(page, PAID);
    const form = await openAdd(page, nameOf(PAID));
    await fillRule(form, {
      name: PAID_RULE,
      subgroup: CONSULTS,
      visits: ["New", "Follow Up"],
      pays: "amount",
      value: "700",
    });
    await expect(form.getByLabel("The rest", { exact: true })).toHaveValue("claim");

    await previewItem(form, NEW);
    await expect(preview(form)).toContainText("This item is always a New visit.");
    const withRule = split(form, "With this rule");
    await expect(withRule).toContainText("Actual ₹1,500");
    await expect(withRule).toContainText("Patient pays ₹700");
    await expect(withRule).toContainText(`Rest ₹800 claimed from ${PAYER}`);
    await expect(split(form, "With the saved rules")).toContainText("Patient pays ₹1,500");

    await previewItem(form, FU);
    await expect(withRule).toContainText("Actual ₹1,000");
    await expect(withRule).toContainText("Patient pays ₹700");
    await expect(withRule).toContainText(`Rest ₹300 claimed from ${PAYER}`);

    await form.getByRole("button", { name: "Add payment rule", exact: true }).click();
    const row = ruleRow(page, nameOf(PAID), PAID_RULE);
    await expect(row).toContainText(`Subgroup: ${CONSULTS}`);
    await expect(row).toContainText("New, Follow Up");
    await expect(row).toContainText("₹700");
    await expect(row).toContainText("Claim");
    await expect(row.getByRole("cell", { name: "Active", exact: true })).toBeVisible();
    expect(await saved(PAID.code)).toEqual([
      {
        name: PAID_RULE,
        group_id: null,
        subgroup_id: seed.consults,
        service_item_id: null,
        visit_types: ["New", "Follow Up"],
        patient_pays: "amount",
        patient_value: 700,
        remainder: "claim",
        priority: 100,
        valid_to: null,
        is_active: true,
      },
    ]);
    await expect(
      panel(page, nameOf(PAID)).getByRole("table", { name: "Inherited payment rules" }),
    ).toContainText(PARENT_RULE);
  });

  for (const [sub, ruleName] of [
    [REF, REF_RULE],
    [PEN, PEN_RULE],
  ]) {
    test(`6. ${sub.label}: the patient pays nothing, previewed and saved`, async ({ page }) => {
      await openCategory(page, sub);
      const form = await openAdd(page, nameOf(sub));
      await fillRule(form, { name: ruleName, subgroup: CONSULTS, pays: "nothing" });
      await expect(form.getByLabel(/^(Amount|Percent)/)).toHaveCount(0);
      await previewItem(form, NEW);
      const withRule = split(form, "With this rule");
      await expect(withRule).toContainText("Actual ₹1,500");
      await expect(withRule).toContainText("Patient pays ₹0");
      await expect(withRule).toContainText(`Rest ₹1,500 claimed from ${PAYER}`);
      await form.getByRole("button", { name: "Add payment rule", exact: true }).click();
      const row = ruleRow(page, nameOf(sub), ruleName);
      await expect(row).toContainText("Nothing");
      await expect(row).toContainText("Any visit");
      expect(await saved(sub.code)).toMatchObject([
        {
          name: ruleName,
          subgroup_id: seed.consults,
          patient_pays: "nothing",
          patient_value: null,
        },
      ]);
    });
  }

  test("7. editing CGHS Paid shows the saved numbers and saves the change", async ({ page }) => {
    await openCategory(page, PAID);
    await panel(page, nameOf(PAID))
      .getByRole("button", { name: `Edit payment rule ${PAID_RULE}`, exact: true })
      .click();
    const form = panel(page, nameOf(PAID)).getByRole("form", {
      name: `Edit payment rule ${PAID_RULE}`,
    });
    await expect(form.getByLabel("Amount (₹)", { exact: true })).toHaveValue("700");
    await expect(form.getByRole("checkbox", { name: "New", exact: true })).toBeChecked();
    await expect(
      form.getByRole("checkbox", { name: "Investigation", exact: true }),
    ).not.toBeChecked();
    await previewItem(form, NEW);
    const atDesk = split(form, "With the saved rules");
    await expect(atDesk).toContainText("Patient pays ₹700");
    await expect(atDesk).toContainText("Rest ₹800 claimed");
    await expect(preview(form)).toContainText("Saved rules today: amount ₹700");

    await form.getByLabel("Amount (₹)", { exact: true }).fill("650");
    await expect(split(form, "With this rule")).toContainText("Patient pays ₹650");
    await form.getByLabel("Priority", { exact: true }).fill("5");
    await form.getByLabel("To", { exact: true }).fill("2027-03-31");
    await form.getByRole("button", { name: "Save payment rule", exact: true }).click();
    const row = ruleRow(page, nameOf(PAID), PAID_RULE);
    await expect(row).toContainText("₹650");
    await expect(row).toContainText("– 2027-03-31");
    expect(await saved(PAID.code)).toMatchObject([
      { patient_value: 650, priority: 5, valid_to: "2027-03-31" },
    ]);

    await row.getByRole("button", { name: `Edit payment rule ${PAID_RULE}` }).click();
    await form.getByLabel("Amount (₹)", { exact: true }).fill("700");
    await form.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(form).toHaveCount(0);
    await expect(row).toContainText("₹650");
    await row.getByRole("button", { name: `Edit payment rule ${PAID_RULE}` }).click();
    await form.getByLabel("Amount (₹)", { exact: true }).fill("700");
    await form.getByRole("button", { name: "Save payment rule", exact: true }).click();
    await expect(row).toContainText("₹700");
  });

  test("8. deactivate and activate", async ({ page }) => {
    await openCategory(page, REF);
    const row = ruleRow(page, nameOf(REF), REF_RULE);
    await row.getByRole("button", { name: `Deactivate payment rule ${REF_RULE}` }).click();
    await expect(row.getByRole("cell", { name: "Inactive", exact: true })).toBeVisible();
    await expect(row).toHaveClass(/fset__row--off/);
    expect(await saved(REF.code)).toMatchObject([{ is_active: false }]);
    await row.getByRole("button", { name: `Activate payment rule ${REF_RULE}` }).click();
    await expect(row.getByRole("cell", { name: "Active", exact: true })).toBeVisible();
    expect(await saved(REF.code)).toMatchObject([{ is_active: true }]);
  });

  test("9. delete asks first, inline like the rest of the page", async ({ page }) => {
    const api = await apiAs("admin");
    const made = await api.post("/api/billing/master/payment-rules", {
      data: {
        scheme_code: PEN.code,
        name: `P318 spare ${tag}`,
        patient_pays: "percent",
        patient_value: 10,
        remainder: "adjustment",
      },
    });
    expect(made.status()).toBe(201);
    await api.dispose();

    await openCategory(page, PEN);
    const row = ruleRow(page, nameOf(PEN), `P318 spare ${tag}`);
    await expect(row).toContainText("10%");
    await expect(row).toContainText("Adjustment");
    await row.getByRole("button", { name: `Delete payment rule P318 spare ${tag}` }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const keep = row.getByRole("button", {
      name: `Cancel deleting payment rule P318 spare ${tag}`,
    });
    await expect(keep).toBeFocused();
    await keep.click();
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: `Delete payment rule P318 spare ${tag}` }).click();
    await row
      .getByRole("button", { name: `Confirm delete payment rule P318 spare ${tag}`, exact: true })
      .click();
    await expect(row).toHaveCount(0);
    await expect(
      panel(page, nameOf(PEN)).getByRole("button", { name: "+ Payment rule", exact: true }),
    ).toBeFocused();
    expect((await saved(PEN.code)).map((r) => r.name)).toEqual([PEN_RULE]);
  });

  test("10. a percent rule's preview matches the saved price to the paisa (half-up, like the bill)", async ({
    page,
  }) => {
    await openCategory(page, PAID);
    const form = await openAdd(page, nameOf(PAID));
    await form.getByLabel("Rule name", { exact: true }).fill(ODD_RULE);
    await form.getByLabel("Applies to", { exact: true }).selectOption("item");
    await form.getByLabel("Find item", { exact: true }).fill(ODD);
    const select = form.getByLabel("Item", { exact: true });
    await expect(select.locator("option", { hasText: ODD })).toHaveCount(1);
    await select.selectOption({ label: await optionLabel(select, ODD) });
    await form.getByLabel("Patient pays", { exact: true }).selectOption("percent");
    await form.getByLabel("Percent (%)", { exact: true }).fill("12.7");
    await openTest(form);
    const withRule = split(form, "With this rule");
    await expect(withRule).toContainText("Actual ₹205");
    await expect(withRule).toContainText("Patient pays ₹26.04");
    await expect(withRule).toContainText("Rest ₹178.96");
    await form.getByRole("button", { name: "Add payment rule", exact: true }).click();
    const row = ruleRow(page, nameOf(PAID), ODD_RULE);
    await expect(row).toContainText(`Item: ${ODD}`);

    const api = await apiAs("reception_admin");
    const priced = await api.post("/api/billing/master/test-rule", {
      data: { category: PAID.code, visit_type: "New", lines: [{ item_id: seed.odd }] },
    });
    expect(priced.status()).toBe(200);
    expect((await priced.json()).lines[0]).toMatchObject({ patient_payable: 2604, claim: 17896 });
    await api.dispose();

    await row.getByRole("button", { name: `Edit payment rule ${ODD_RULE}` }).click();
    const edit = panel(page, nameOf(PAID)).getByRole("form", {
      name: `Edit payment rule ${ODD_RULE}`,
    });
    await openTest(edit);
    await expect(split(edit, "With this rule")).toContainText("Patient pays ₹26.04");
    await expect(split(edit, "With the saved rules")).toContainText("Patient pays ₹26.04");
    await edit.getByRole("button", { name: "Cancel", exact: true }).click();
  });

  test("10b. the draft preview is priced by the server, discounts and all", async ({ page }) => {
    const api = await apiAs("admin");
    const added = await api.post("/api/billing/master/discounts", {
      data: {
        name: ODD_DISCOUNT,
        method: "auto",
        kind: "percent",
        value: 10,
        group_ids: [seed.misc],
        applies_on_scheme_rate: true,
      },
    });
    expect(added.status(), await added.text()).toBe(201);
    const discountId = (await added.json()).id;
    try {
      const priced = await api.post("/api/billing/master/test-rule", {
        data: {
          category: PAID.code,
          visit_type: "New",
          lines: [{ item_id: seed.odd }],
          draft_rule: {
            service_item_id: seed.odd,
            patient_pays: "percent",
            patient_value: 12.7,
            remainder: "claim",
          },
        },
      });
      expect(priced.status()).toBe(200);
      const line = (await priced.json()).lines[0];
      expect(line.payment_rule_name).toBe("Draft rule");
      expect(line.discount).toBeGreaterThan(0);
      expect(line.patient_payable).not.toBe(2604);

      await openCategory(page, PAID);
      const form = await openAdd(page, nameOf(PAID));
      await form.getByLabel("Rule name", { exact: true }).fill(DRAFT_RULE);
      await form.getByLabel("Applies to", { exact: true }).selectOption("item");
      await form.getByLabel("Find item", { exact: true }).fill(ODD);
      const select = form.getByLabel("Item", { exact: true });
      await expect(select.locator("option", { hasText: ODD })).toHaveCount(1);
      await select.selectOption({ label: await optionLabel(select, ODD) });
      await form.getByLabel("Patient pays", { exact: true }).selectOption("percent");
      await form.getByLabel("Percent (%)", { exact: true }).fill("12.7");
      await openTest(form);

      const withRule = split(form, "With this rule");
      await expect(withRule).toContainText(`Patient pays ${money(line.patient_payable)}`);
      await expect(withRule).toContainText(`Rest ${money(line.claim + line.adjustment)}`);
      await expect(preview(form)).toContainText(`Discounts take off ${money(line.discount)}`);
      await expect(preview(form)).not.toContainText("Before discounts");
      await expect(withRule).not.toContainText("₹26.04");

      await form.getByLabel("Percent (%)", { exact: true }).fill("150");
      await expect(preview(form).getByRole("alert")).toContainText(
        "The percent must be from 0 to 100",
      );
      await expect(split(form, "With this rule")).toHaveCount(0);
      await form.getByRole("button", { name: "Cancel", exact: true }).click();
    } finally {
      await query(`DELETE FROM discount_rules WHERE id = $1`, [discountId]);
      await api.dispose();
    }
  });

  test("11. a rule's scope moves from one item to a group, and unticking every visit type means any visit", async ({
    page,
  }) => {
    await openCategory(page, PAID);
    const row = ruleRow(page, nameOf(PAID), ODD_RULE);
    await row.getByRole("button", { name: `Edit payment rule ${ODD_RULE}` }).click();
    const form = panel(page, nameOf(PAID)).getByRole("form", {
      name: `Edit payment rule ${ODD_RULE}`,
    });
    await form.getByLabel("Applies to", { exact: true }).selectOption("group");
    await form.getByLabel("Group", { exact: true }).selectOption({ label: MISC_GROUP });
    await form.getByRole("checkbox", { name: "Investigation", exact: true }).check();
    await form.getByRole("button", { name: "Save payment rule", exact: true }).click();
    await expect(row).toContainText(`Group: ${MISC_GROUP}`);
    await expect(row).toContainText("Investigation");
    expect((await saved(PAID.code)).find((r) => r.name === ODD_RULE)).toMatchObject({
      group_id: seed.misc,
      subgroup_id: null,
      service_item_id: null,
      visit_types: ["Investigation"],
    });

    await row.getByRole("button", { name: `Edit payment rule ${ODD_RULE}` }).click();
    await form.getByRole("checkbox", { name: "Investigation", exact: true }).uncheck();
    await form.getByRole("button", { name: "Save payment rule", exact: true }).click();
    await expect(row).toContainText("Any visit");
    expect((await saved(PAID.code)).find((r) => r.name === ODD_RULE).visit_types).toBeNull();
  });

  test("12. with no payer, turning a full-price rule into 'nothing' sends the rest to adjustment", async ({
    page,
  }) => {
    await openCategory(page, NOPAYER);
    const row = ruleRow(page, NOPAYER.label, STAFF_RULE);
    await expect(row).toContainText("Full price");
    await row.getByRole("button", { name: `Edit payment rule ${STAFF_RULE}` }).click();
    const form = panel(page, NOPAYER.label).getByRole("form", {
      name: `Edit payment rule ${STAFF_RULE}`,
    });
    await form.getByLabel("Patient pays", { exact: true }).selectOption("nothing");
    await expect(form.getByLabel("The rest", { exact: true })).toHaveValue("adjustment");
    await form.getByRole("button", { name: "Save payment rule", exact: true }).click();
    await expect(form).toHaveCount(0);
    await expect(row).toContainText("Nothing");
    await expect(row).toContainText("Adjustment");
    expect(await saved(NOPAYER.code)).toMatchObject([
      { patient_pays: "nothing", remainder: "adjustment" },
    ]);
  });

  test("13. the preview charges the rule on the price with tax, discounts counted in", async ({
    page,
  }) => {
    await page.route("**/api/billing/master/test-rule", async (route) => {
      const draft = Boolean(route.request().postDataJSON()?.draft_rule);
      const response = await route.fetch();
      const body = await response.json();
      const [line] = body.lines;
      const tax = Math.round(line.actual * 0.18);
      const total = line.actual + tax;
      const net = total - 10000;
      const payable = draft ? net / 2 : net;
      body.lines = [
        {
          ...line,
          tax,
          cgst: tax / 2,
          sgst: tax / 2,
          tax_rate: 18,
          total,
          patient_payable: payable,
          claim: net - payable,
          adjustment: 0,
          discount: 10000,
          payable_discount: 10000,
          payment_rule_name: draft ? "Draft rule" : line.payment_rule_name,
          discounts: [{ rule_id: 1, name: "P318 test discount", amount: 10000 }],
        },
      ];
      await route.fulfill({ response, json: body });
    });
    await openCategory(page, REF);
    const form = await openAdd(page, nameOf(REF));
    await fillRule(form, { name: "P318 tax preview", pays: "percent", value: "50" });
    await previewItem(form, NEW);
    const withRule = split(form, "With this rule");
    await expect(withRule).toContainText("Actual ₹1,500 (₹1,770 with tax)");
    await expect(withRule).toContainText("Patient pays ₹835");
    await expect(withRule).toContainText("Rest ₹835 claimed");
    await expect(preview(form)).toContainText("Discounts take off ₹100, already counted above.");
    await expect(preview(form)).not.toContainText("Before discounts");
    await form.getByRole("button", { name: "Cancel", exact: true }).click();
  });

  test("14. keyboard: the form takes focus when it opens and gives it back when it closes", async ({
    page,
  }) => {
    await openCategory(page, REF);
    const own = panel(page, nameOf(REF));
    const add = own.getByRole("button", { name: "+ Payment rule", exact: true });
    await add.focus();
    await page.keyboard.press("Enter");
    const form = addForm(page, nameOf(REF));
    await expect(form.getByLabel("Rule name", { exact: true })).toBeFocused();
    await form.getByRole("button", { name: "Cancel", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(form).toHaveCount(0);
    await expect(add).toBeFocused();

    const editButton = own.getByRole("button", { name: `Edit payment rule ${REF_RULE}` });
    await editButton.focus();
    await page.keyboard.press("Enter");
    const edit = own.getByRole("form", { name: `Edit payment rule ${REF_RULE}` });
    await expect(edit.getByLabel("Rule name", { exact: true })).toBeFocused();
    await edit.getByRole("button", { name: "Cancel", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(edit).toHaveCount(0);
    await expect(editButton).toBeFocused();
  });

  test("15. a failed load says so instead of loading forever", async ({ page }) => {
    await page.route(
      (url) => url.pathname.endsWith("/api/billing/master/payment-rules"),
      (route) => route.fulfill({ status: 500, json: { error: "boom" } }),
    );
    await openCategory(page, PAID);
    await expect(panel(page, nameOf(PAID))).toContainText("Could not load the payment rules.", {
      timeout: 20000,
    });
  });

  test("16. on a phone the add form and its preview fit without sideways scrolling", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await openCategory(page, PAID);
    const form = await openAdd(page, nameOf(PAID));
    await fillRule(form, { name: "P318 phone", subgroup: CONSULTS, pays: "amount", value: "700" });
    await previewItem(form, NEW);
    await expect(split(form, "With this rule")).toContainText("Patient pays ₹700");
    const widths = await page.evaluate(() => ({
      page: document.documentElement.scrollWidth,
      view: window.innerWidth,
    }));
    expect(widths.page).toBeLessThanOrEqual(widths.view);
    await form.getByRole("button", { name: "Cancel", exact: true }).click();
  });

  test("17. the item picker says when it shows only the first matches", async ({ page }) => {
    await page.route(
      (url) => url.pathname.endsWith("/api/billing/master/items"),
      async (route) => {
        const response = await route.fetch();
        const body = await response.json();
        await route.fulfill({ response, json: { ...body, total: body.items.length + 70 } });
      },
    );
    await openCategory(page, PAID);
    const form = await openAdd(page, nameOf(PAID));
    await form.getByLabel("Find preview item", { exact: true }).fill(NEW);
    await expect(form).toContainText(/Showing the first 1 of 71 — type more of the name or code/);
    await form.getByRole("button", { name: "Cancel", exact: true }).click();
  });

  test("18. a retired category keeps its rules visible but offers no way to change them", async ({
    page,
  }) => {
    const api = await apiAs("admin");
    const made = await api.post("/api/billing/master/categories", { data: RETIRED });
    expect(made.status()).toBe(201);
    const rule = await api.post("/api/billing/master/payment-rules", {
      data: {
        scheme_code: RETIRED.code,
        name: RETIRED_RULE,
        patient_pays: "percent",
        patient_value: 50,
        remainder: "adjustment",
      },
    });
    expect(rule.status()).toBe(201);
    const retire = await api.patch(`/api/billing/master/categories/${RETIRED.code}`, {
      data: { is_active: false },
    });
    expect(retire.status()).toBe(200);
    await api.dispose();

    await openCategory(page, RETIRED);
    const own = panel(page, RETIRED.label);
    const row = ruleRow(page, RETIRED.label, RETIRED_RULE);
    await expect(row).toContainText("50%");
    await expect(row).toContainText("Adjustment");
    await expect(own).toContainText("This category is retired; bring it back to change its rules.");
    await expect(own.getByRole("button")).toHaveCount(0);
    await expect(
      own.getByRole("button", { name: `Edit payment rule ${RETIRED_RULE}` }),
    ).toHaveCount(0);
    await expect(own.getByRole("button", { name: "+ Payment rule", exact: true })).toHaveCount(0);
  });
});
