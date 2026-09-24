import crypto from "node:crypto";
import { test, expect } from "@playwright/test";
import { apiAs, loginAs } from "../../helpers/auth.mjs";
import { one, query } from "../../helpers/db.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { buildPatient } from "../../helpers/builders.mjs";

const tag = crypto.randomBytes(3).toString("hex");
const TOP = { code: `p131_${tag}`, label: `P131 CGHS ${tag}` };
const SUBS = [
  { code: `p131_paid_${tag}`, label: "CGHS Paid" },
  { code: `p131_ref_${tag}`, label: "CGHS Referral" },
  { code: `p131_pen_${tag}`, label: "Pensioner" },
];
const LONE = { code: `p131_lone_${tag}`, label: `P131 Lone ${tag}` };
const LONE_SUB = { code: `p131_lsub_${tag}`, label: "Lone Sub" };
const PENSIONER = `${TOP.label} › Pensioner`;

const tree = (page) => page.getByRole("region", { name: "Categories" });
const pick = (page, { label, code }) =>
  tree(page).getByRole("button", { name: new RegExp(`^${label} ${code}\\b`) });
const details = (page, name) => page.getByRole("form", { name: `${name} details` });
const rules = (page, name) => page.getByRole("region", { name: `Who belongs to ${name}` });

async function openCategories(page, role = "reception_admin") {
  await loginAs(page, role);
  await gotoReady(page, "/settings/schemes", () => tree(page));
}

const addDialog = (page, title) => page.getByRole("dialog", { name: title, exact: true });

async function addCategory(page, title, { code, label }) {
  const parent = title.match(/^Add sub-category to (.+)$/)?.[1];
  await tree(page)
    .getByRole("button", {
      name: parent ? `New sub-category under ${parent}` : "+ Add category",
      exact: true,
    })
    .click();
  const dialog = addDialog(page, title);
  await dialog.getByLabel("Code", { exact: true }).fill(code);
  await dialog.getByLabel("Label", { exact: true }).fill(label);
  await dialog
    .getByRole("button", { name: parent ? "Add sub-category" : "Add category", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
}

test.describe.serial("P1-31 categories page", () => {
  test.describe.configure({ retries: 1 });

  test.afterAll(async () => {
    await query(`DELETE FROM category_rules WHERE scheme_code LIKE $1`, [`p131%${tag}`]);
    await query(`DELETE FROM patient_schemes WHERE parent_code LIKE $1`, [`p131%${tag}`]);
    await query(`DELETE FROM patient_schemes WHERE code LIKE $1`, [`p131%${tag}`]);
  });

  test("1. reception_admin opens the page; reception can't", async ({ page }) => {
    await openCategories(page);
    await expect(tree(page).getByRole("heading", { level: 2 })).toHaveText("Categories");
    const other = await page.context().newPage();
    await loginAs(other, "reception");
    await other.goto("/settings/schemes");
    await expect(other).not.toHaveURL(/\/settings/);
    await other.close();
  });

  test("2. CGHS with its three sub-categories is created from the screen", async ({ page }) => {
    await openCategories(page);
    await addCategory(page, "Add category", TOP);
    await expect(details(page, TOP.label)).toBeVisible();
    for (const sub of SUBS) {
      await addCategory(page, `Add sub-category to ${TOP.label}`, sub);
      await expect(details(page, `${TOP.label} › ${sub.label}`)).toBeVisible();
    }
    const rows = await query(
      `SELECT code, parent_code FROM patient_schemes WHERE parent_code = $1 ORDER BY code`,
      [TOP.code],
    );
    expect(rows.rows.map((r) => r.code).sort()).toEqual(SUBS.map((s) => s.code).sort());
    for (const sub of SUBS) {
      await expect(
        tree(page).getByRole("button", { name: `New sub-category under ${sub.label}` }),
      ).toHaveCount(0);
    }
  });

  test("3. the new fields save, and a sub-category shows the payer it inherits", async ({
    page,
  }) => {
    await openCategories(page);
    await pick(page, TOP).click();
    const form = details(page, TOP.label);
    await form.getByLabel("Payer name", { exact: true }).fill("Govt of India");
    await form.getByLabel("Pay later", { exact: true }).selectOption("false");
    await form.getByLabel("Needs a referral", { exact: true }).check();
    await form.getByLabel("Print the category on the bill", { exact: true }).check();
    await form.getByRole("button", { name: "Save", exact: true }).click();
    const saved = () =>
      one(
        `SELECT payer_name, daily_cap, allow_pay_later, requires_referral, requires_referral_doc,
                print_category_on_bill
           FROM patient_schemes WHERE code = $1`,
        [TOP.code],
      );
    await expect.poll(saved).toEqual({
      payer_name: "Govt of India",
      daily_cap: null,
      allow_pay_later: false,
      requires_referral: true,
      requires_referral_doc: false,
      print_category_on_bill: true,
    });

    await pick(page, SUBS[2]).click();
    await expect(
      details(page, PENSIONER).getByLabel("Payer name", { exact: true }),
    ).toHaveAttribute("placeholder", `Same as ${TOP.label}: Govt of India`);
  });

  test("3b. only an admin can change the patients-per-day limit", async ({ page }) => {
    const reception = await apiAs("reception_admin");
    const refused = await reception.patch(`/api/billing/master/categories/${TOP.code}`, {
      data: { daily_cap: 99 },
    });
    expect(refused.status()).toBe(403);
    expect((await refused.json()).error).toMatch(/Only an admin/);
    const createWithCap = await reception.post("/api/billing/master/categories", {
      data: { code: `p131_cap_${tag}`, label: `P131 Cap ${tag}`, daily_cap: 5 },
    });
    expect(createWithCap.status()).toBe(403);
    const createBlank = await reception.post("/api/billing/master/categories", {
      data: { code: `p131_cap_${tag}`, label: `P131 Cap ${tag}`, daily_cap: "" },
    });
    expect(createBlank.status()).toBe(201);
    await reception.dispose();

    await openCategories(page);
    await pick(page, TOP).click();
    const capField = details(page, TOP.label).getByLabel("Patients per day", { exact: true });
    await expect(capField).toHaveAttribute("readonly", "");
    await expect(details(page, TOP.label)).toContainText("Only an admin can change");

    const adminPage = await page.context().browser().newPage();
    await openCategories(adminPage, "admin");
    await pick(adminPage, TOP).click();
    const adminForm = details(adminPage, TOP.label);
    await adminForm.getByLabel("Patients per day", { exact: true }).fill("30");
    await adminForm.getByRole("button", { name: "Save", exact: true }).click();
    await expect
      .poll(
        async () =>
          (await one(`SELECT daily_cap FROM patient_schemes WHERE code = $1`, [TOP.code]))
            .daily_cap,
      )
      .toBe(30);
    await adminPage.close();
  });

  test("3c. switching category with unsaved changes asks first", async ({ page }) => {
    await openCategories(page);
    await pick(page, TOP).click();
    const form = details(page, TOP.label);
    await form.getByLabel("Payer name", { exact: true }).fill("Changed payer");
    await pick(page, SUBS[2]).click();
    const ask = page.getByRole("dialog", { name: `Discard your changes to ${TOP.label}?` });
    await ask.getByRole("button", { name: "Keep editing", exact: true }).click();
    await expect(ask).toHaveCount(0);
    await expect(form.getByLabel("Payer name", { exact: true })).toHaveValue("Changed payer");
    await pick(page, SUBS[2]).click();
    await ask.getByRole("button", { name: "Discard", exact: true }).click();
    await expect(details(page, PENSIONER)).toBeVisible();
    expect(
      (await one(`SELECT payer_name FROM patient_schemes WHERE code = $1`, [TOP.code])).payer_name,
    ).toBe("Govt of India");
  });

  test("4. a sub-category gets its own who-belongs rules", async ({ page }) => {
    await openCategories(page);
    await pick(page, SUBS[2]).click();
    const panel = rules(page, PENSIONER);
    const addForm = panel.getByRole("form", { name: "Add a rule" });
    await addForm.getByLabel("Rule name", { exact: true }).fill("Retired, 60 and over");
    await addForm.getByLabel("From age", { exact: true }).fill("60");
    await addForm.getByLabel("Has a card", { exact: true }).check();
    await addForm.getByLabel("How it applies", { exact: true }).selectOption("auto");
    await addForm.getByRole("button", { name: "+ Add rule", exact: true }).click();
    const row = panel.getByRole("row", { name: /Retired, 60 and over/ });
    await expect(row).toContainText("60+");
    await expect(row).toContainText("Automatic");

    await panel
      .getByRole("button", { name: "Edit rule Retired, 60 and over", exact: true })
      .click();
    const edit = panel.getByRole("form", { name: "Edit rule Retired, 60 and over" });
    await edit.getByLabel("Priority", { exact: true }).fill("5");
    await edit.getByRole("button", { name: "Save rule", exact: true }).click();
    await expect(edit).toHaveCount(0);
    const rule = await one(
      `SELECT min_age, requires_card, mode, priority FROM category_rules WHERE scheme_code = $1`,
      [SUBS[2].code],
    );
    expect(rule).toEqual({ min_age: 60, requires_card: true, mode: "auto", priority: 5 });

    await panel
      .getByRole("button", { name: "Deactivate rule Retired, 60 and over", exact: true })
      .click();
    await expect(
      panel.getByRole("button", { name: "Activate rule Retired, 60 and over", exact: true }),
    ).toBeVisible();
  });

  test("4b. review: ages and priority take digits only, priority is explained, delete can be cancelled", async ({
    page,
  }) => {
    await openCategories(page);
    await pick(page, SUBS[2]).click();
    const panel = rules(page, PENSIONER);
    await expect(panel).toContainText("the one with the smaller priority number is used");
    const addForm = panel.getByRole("form", { name: "Add a rule" });
    await addForm.getByLabel("From age", { exact: true }).pressSequentially("6a0-");
    await expect(addForm.getByLabel("From age", { exact: true })).toHaveValue("60");
    await addForm.getByLabel("To age", { exact: true }).pressSequentially("7e0.");
    await expect(addForm.getByLabel("To age", { exact: true })).toHaveValue("70");
    await addForm.getByLabel("Priority", { exact: true }).pressSequentially("1x0");
    await expect(addForm.getByLabel("Priority", { exact: true })).toHaveValue("10");
    await expect(addForm).toContainText("Smaller is checked first");

    await panel
      .getByRole("button", { name: "Delete rule Retired, 60 and over", exact: true })
      .click();
    await panel
      .getByRole("button", { name: "Cancel deleting rule Retired, 60 and over", exact: true })
      .click();
    await expect(
      panel.getByRole("button", { name: "Delete rule Retired, 60 and over", exact: true }),
    ).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "Confirm delete rule Retired, 60 and over", exact: true }),
    ).toHaveCount(0);
    expect(
      (
        await one(`SELECT count(*)::int AS n FROM category_rules WHERE scheme_code = $1`, [
          SUBS[2].code,
        ])
      ).n,
    ).toBe(1);
  });

  test("4c. review: codes, limits and lengths are checked as they are typed", async ({ page }) => {
    await openCategories(page, "admin");
    await tree(page).getByRole("button", { name: "+ Add category", exact: true }).click();
    const add = addDialog(page, "Add category");
    const addCode = add.getByLabel("Code", { exact: true });
    await addCode.pressSequentially("My Cat-1");
    await expect(addCode).toHaveValue("mycat1");
    await expect(addCode).toHaveAttribute("maxlength", "32");
    await expect(add.getByLabel("Label", { exact: true })).toHaveAttribute("maxlength", "200");
    await add.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(add).toHaveCount(0);

    await pick(page, SUBS[2]).click();
    const form = details(page, PENSIONER);
    const cap = form.getByLabel("Patients per day", { exact: true });
    await cap.pressSequentially("1a2.");
    await expect(cap).toHaveValue("12");
    await expect(form.getByLabel("Label", { exact: true })).toHaveAttribute("maxlength", "200");
    await expect(form.getByLabel("Payer name", { exact: true })).toHaveAttribute(
      "maxlength",
      "200",
    );

    const addRule = rules(page, PENSIONER).getByRole("form", { name: "Add a rule" });
    await expect(addRule.getByLabel("Rule name", { exact: true })).toHaveAttribute(
      "maxlength",
      "200",
    );
    await addRule.getByLabel("Rule name", { exact: true }).fill("Backwards");
    await addRule.getByLabel("From age", { exact: true }).fill("70");
    await addRule.getByLabel("To age", { exact: true }).fill("60");
    await addRule.getByRole("button", { name: "+ Add rule", exact: true }).click();
    await expect(addRule.getByRole("alert")).toHaveText("From age can't be more than To age");
  });

  test("5. a rule that matches everyone is refused in the form", async ({ page }) => {
    await openCategories(page);
    await pick(page, SUBS[0]).click();
    const addForm = rules(page, `${TOP.label} › CGHS Paid`).getByRole("form", {
      name: "Add a rule",
    });
    await addForm.getByLabel("Rule name", { exact: true }).fill("Everyone");
    await addForm.getByRole("button", { name: "+ Add rule", exact: true }).click();
    await expect(addForm.getByRole("alert")).toContainText("at least one condition");
  });

  test("6. a category with sub-categories takes no rules of its own", async ({ page }) => {
    await openCategories(page);
    await pick(page, TOP).click();
    const panel = rules(page, TOP.label);
    await expect(panel).toContainText("has sub-categories");
    await expect(panel.getByRole("form", { name: "Add a rule" })).toHaveCount(0);
  });

  test("7. adding the first sub-category offers to move the parent's rules", async ({ page }) => {
    await openCategories(page);
    await addCategory(page, "Add category", LONE);
    const loneRules = rules(page, LONE.label);
    const addForm = loneRules.getByRole("form", { name: "Add a rule" });
    await addForm.getByLabel("Rule name", { exact: true }).fill("Women");
    await addForm.getByLabel("Gender", { exact: true }).selectOption("Female");
    await addForm.getByRole("button", { name: "+ Add rule", exact: true }).click();
    await expect(loneRules.getByRole("row", { name: /Women/ })).toBeVisible();

    await addCategory(page, `Add sub-category to ${LONE.label}`, LONE_SUB);
    const retiredSub = { code: `p131_lold_${tag}`, label: "Old Sub" };
    const admin = await apiAs("admin");
    await admin.post("/api/billing/master/categories", {
      data: { ...retiredSub, parent_code: LONE.code },
    });
    await admin.patch(`/api/billing/master/categories/${retiredSub.code}`, {
      data: { is_active: false },
    });
    await admin.dispose();
    await gotoReady(page, "/settings/schemes", () => tree(page));
    await pick(page, LONE).click();
    const moves = rules(page, LONE.label).getByRole("list", { name: "Rules to move" });
    await expect(moves).toContainText("Women");
    const moveTo = moves.getByLabel("Move Women to", { exact: true });
    await expect(moveTo.locator("option", { hasText: retiredSub.label })).toHaveCount(0);
    await moveTo.selectOption(LONE_SUB.code);
    await moves.getByRole("button", { name: "Move", exact: true }).click();
    await expect(moves).toHaveCount(0);
    const moved = await one(
      `SELECT scheme_code FROM category_rules WHERE name = 'Women' AND scheme_code LIKE $1`,
      [`p131%${tag}`],
    );
    expect(moved.scheme_code).toBe(LONE_SUB.code);
  });

  test("8. deleting a category that is in use shows where; retiring it waits for its sub-categories", async ({
    page,
  }) => {
    await openCategories(page);
    await pick(page, TOP).click();
    await details(page, TOP.label)
      .getByRole("button", { name: `Delete ${TOP.label}`, exact: true })
      .click();
    await details(page, TOP.label)
      .getByRole("button", { name: `Confirm delete ${TOP.label}`, exact: true })
      .click();
    const blocked = page.getByRole("dialog", { name: `${TOP.label} can't be deleted` });
    await expect(blocked.getByRole("list", { name: "Used in" })).toContainText("sub-categor");
    await blocked.getByRole("button", { name: "Retire instead", exact: true }).click();
    await expect(blocked.getByRole("alert")).toContainText("active sub-categories");
    await blocked.getByRole("button", { name: "Close", exact: true }).click();
  });

  test("9. an unused sub-category is retired, brought back and deleted", async ({ page }) => {
    await openCategories(page);
    await pick(page, SUBS[1]).click();
    const name = `${TOP.label} › CGHS Referral`;
    await details(page, name).getByRole("button", { name: "Retire", exact: true }).click();
    await expect(pick(page, SUBS[1])).toContainText("retired");
    await details(page, name).getByRole("button", { name: "Bring back", exact: true }).click();
    await expect(pick(page, SUBS[1])).not.toContainText("retired");
    await details(page, name)
      .getByRole("button", { name: `Delete ${name}`, exact: true })
      .click();
    await details(page, name)
      .getByRole("button", { name: `Confirm delete ${name}`, exact: true })
      .click();
    await expect(pick(page, SUBS[1])).toHaveCount(0);
    expect(
      (await query(`SELECT 1 FROM patient_schemes WHERE code = $1`, [SUBS[1].code])).rows,
    ).toHaveLength(0);
  });

  test("10. the GHM sheet still renders its category pills, sub-categories included", async ({
    page,
  }) => {
    const patient = await buildPatient();
    await query(
      `INSERT INTO appointments (appointment_date, patient_name, file_no, patient_category, status)
       VALUES ((NOW() AT TIME ZONE 'Asia/Kolkata')::date, $1, $2, $3, 'scheduled')`,
      [patient.name, patient.file_no, SUBS[2].code],
    );
    try {
      await loginAs(page, "reception_admin");
      await gotoReady(page, "/ghm", () => page.getByText("Categories", { exact: true }));
      await expect(page.locator(".spill").filter({ hasText: "CGHS" }).first()).toBeVisible();
    } finally {
      await query(`DELETE FROM appointments WHERE file_no = $1`, [patient.file_no]);
      await query(`DELETE FROM patients WHERE id = $1`, [patient.id]);
    }
    const labels = await page.evaluate(async () => {
      const mod = await import("/shared/patientCategories.js");
      return mod.PATIENT_CATEGORIES.map((c) => c.label);
    });
    expect(labels).toContain(PENSIONER);
  });
});
