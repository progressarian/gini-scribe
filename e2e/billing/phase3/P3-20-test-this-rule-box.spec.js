import crypto from "node:crypto";
import { test, expect } from "@playwright/test";
import { apiAs, loginAs } from "../../helpers/auth.mjs";
import { one, query } from "../../helpers/db.mjs";
import { gotoReady } from "../../helpers/browser.mjs";

const tag = crypto.randomBytes(3).toString("hex");
const T = tag.toUpperCase();
const TOP = { code: `p320_${tag}`, label: `P320 Scheme ${tag}`, payer_name: `P320 Payer ${tag}` };
const SUB = { code: `p320_paid_${tag}`, label: "P320 Paid", parent_code: TOP.code };
const ITEMS = {
  consult: { name: `P320 Consult ${tag}`, price: 1500, sub: "consults" },
  test: { name: `P320 Test ${tag}`, price: 400, sub: "tests" },
  dressing: { name: `P320 Dressing ${tag}`, price: 300, sub: "tests" },
  swab: { name: `P320 Swab ${tag}`, price: 33.33, sub: "tests", allow_quantity: true },
  gauze: {
    name: `P320 Gauze ${tag}`,
    price: 10,
    sub: "tests",
    allow_quantity: true,
    max_quantity: 2,
  },
};
const CODES = { t20: `P320T20${T}`, old: `P320OLD${T}`, adm: `P320ADM${T}`, none: `P320NONE${T}` };
const SENIORS = `P320 seniors ${tag}`;
const ids = {};

const money = (paise) => {
  const amount = paise / 100;
  const digits = Number.isInteger(amount) ? 0 : 2;
  return `₹${amount.toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: 2 })}`;
};
const signed = (paise) =>
  paise < 0 ? `−${money(-paise)}` : paise > 0 ? `+${money(paise)}` : money(0);

const box = (page) => page.getByRole("region", { name: "Test this rule" });
const result = (page) => box(page).getByRole("region", { name: "Test result" });

const numbers = (priced) => ({
  category: priced.category?.code ?? null,
  lines: priced.lines,
  applied_codes: priced.applied_codes,
  refused_codes: priced.refused_codes,
  bill_discounts: priced.bill_discounts,
  totals: priced.totals,
});

async function preview(role, body) {
  const api = await apiAs(role);
  try {
    const response = await api.post("/api/billing/preview", { data: body });
    expect(response.status(), JSON.stringify(await response.json())).toBe(200);
    return response.json();
  } finally {
    await api.dispose();
  }
}

async function openBox(page) {
  await loginAs(page, "reception_admin");
  await gotoReady(page, "/settings/discounts", () =>
    page.getByRole("heading", { name: "Test this rule" }),
  );
}

async function addItem(page, key, quantity) {
  const item = ITEMS[key];
  await box(page).getByLabel("Test items", { exact: true }).fill(item.name);
  await box(page)
    .getByRole("button", { name: `Add ${item.name}`, exact: true })
    .click();
  if (quantity) {
    await box(page).getByLabel(`Quantity of ${item.name}`, { exact: true }).fill(String(quantity));
  }
}

async function fillCase(page, { age, gender, category, visitType, role, codes }) {
  const b = box(page);
  await b.getByLabel("Test age", { exact: true }).fill(age);
  await b.getByLabel("Test gender", { exact: true }).selectOption(gender);
  await b.getByLabel("Test category", { exact: true }).selectOption(category);
  await b.getByLabel("Test visit type", { exact: true }).selectOption(visitType);
  if (role) await b.getByLabel("Test as role", { exact: true }).selectOption(role);
  await addItem(page, "consult");
  await addItem(page, "test");
  await addItem(page, "dressing");
  await addItem(page, "swab", 3);
  await b.getByLabel("Codes entered at the desk", { exact: true }).fill(codes.join(", "));
}

async function runTest(page) {
  const [response] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes("/api/billing/master/test-rule") && r.request().method() === "POST",
    ),
    box(page).getByRole("button", { name: "Test", exact: true }).click(),
  ]);
  return { status: response.status(), json: await response.json() };
}

async function boxLines(page) {
  const rows = result(page).getByRole("table", { name: "Priced lines" }).locator("tbody tr");
  await expect(rows.first()).toBeVisible();
  const out = [];
  for (let i = 0; i < (await rows.count()); i += 1) {
    const cells = await rows.nth(i).getByRole("cell").allInnerTexts();
    out.push(cells.map((c) => c.trim()));
  }
  return out;
}

async function boxTotals(page) {
  const list = result(page).getByRole("definition");
  const terms = await result(page).getByRole("term").allInnerTexts();
  const values = await list.allInnerTexts();
  return Object.fromEntries(terms.map((t, i) => [t.trim(), values[i].trim()]));
}

const lineRows = (priced) =>
  priced.lines.map((l) => [
    String(l.line_no),
    String(l.quantity),
    money(l.actual),
    money(l.discount),
    money(l.tax),
    money(l.patient_payable),
    money(l.claim),
    money(l.adjustment),
  ]);

const totalsOf = (priced) => ({
  Actual: money(priced.totals.actual),
  "Line discounts": money(priced.totals.discount),
  "Bill discounts": money(priced.totals.bill_discount),
  Tax: money(priced.totals.tax),
  "Patient pays": money(priced.totals.patient_payable),
  Claim: money(priced.totals.claim),
  Adjustment: money(priced.totals.adjustment),
  "Round-off": signed(priced.totals.round_off),
  Payable: money(priced.totals.payable),
});

test.describe.serial("P3-20 test this rule box", () => {
  test.describe.configure({ retries: 1 });

  test.beforeAll(async () => {
    const api = await apiAs("admin");
    const post = async (path, data) => {
      const response = await api.post(`/api/billing/master/${path}`, { data });
      expect(response.status(), `${path} ${JSON.stringify(data)}`).toBe(201);
      return response.json();
    };
    await post("categories", TOP);
    await post("categories", SUB);
    const group = await post("groups", { code: `P320G_${tag}`, name: `P320 Group ${tag}` });
    ids.consults = (
      await post("subgroups", { group_id: group.id, code: `P320C_${tag}`, name: "Consults" })
    ).id;
    ids.tests = (
      await post("subgroups", { group_id: group.id, code: `P320T_${tag}`, name: "Tests" })
    ).id;
    for (const [key, item] of Object.entries(ITEMS)) {
      ids[key] = (
        await post("items", {
          code: `P320${key.toUpperCase()}_${tag}`,
          name: item.name,
          subgroup_id: item.sub === "consults" ? ids.consults : ids.tests,
          base_price: item.price,
          kind: "procedure",
          allow_quantity: Boolean(item.allow_quantity),
          ...(item.max_quantity ? { max_quantity: item.max_quantity } : {}),
        })
      ).id;
    }
    await post("payment-rules", {
      scheme_code: SUB.code,
      name: `P320 consult ₹700 ${tag}`,
      subgroup_id: ids.consults,
      patient_pays: "amount",
      patient_value: 700,
      remainder: "claim",
      visit_types: ["New"],
      valid_from: "2026-01-01",
    });
    await post("payment-rules", {
      scheme_code: SUB.code,
      name: `P320 all ${tag}`,
      patient_pays: "percent",
      patient_value: 100,
      remainder: "adjustment",
      valid_from: "2025-01-01",
    });
    const discount = (body) =>
      post("discounts", {
        kind: "percent",
        valid_from: "2026-01-01",
        applies_on_scheme_rate: true,
        ...body,
      });
    await discount({
      name: `P320 test 20 ${tag}`,
      method: "code",
      code: CODES.t20,
      value: 20,
      service_item_ids: [ids.test],
    });
    await discount({
      name: `P320 old ${tag}`,
      method: "code",
      code: CODES.old,
      value: 10,
      valid_to: "2026-02-01",
    });
    await discount({
      name: `P320 admins ${tag}`,
      method: "code",
      code: CODES.adm,
      value: 25,
      service_item_ids: [ids.test],
      allowed_roles: ["admin"],
    });
    await discount({
      name: SENIORS,
      method: "auto",
      kind: "flat",
      value: 50,
      min_age: 60,
      scheme_codes: [TOP.code],
      service_item_ids: [ids.dressing],
    });
    await api.dispose();
    ids.patient = (
      await one(
        `INSERT INTO patients (name, dob, sex, scheme_code)
         VALUES ($1, ((NOW() AT TIME ZONE 'Asia/Kolkata')::date - INTERVAL '70 years' - INTERVAL '1 day')::date,
                 'Female', $2)
         RETURNING id`,
        [`P320 patient ${tag}`, SUB.code],
      )
    ).id;
  });

  test.afterAll(async () => {
    await query(`UPDATE discount_rules SET is_active = FALSE WHERE name LIKE $1`, [`% ${tag}`]);
    await query(`DELETE FROM discount_rules WHERE name LIKE $1`, [`% ${tag}`]);
    await query(`DELETE FROM category_payment_rules WHERE scheme_code = $1`, [SUB.code]);
    if (ids.patient) await query(`DELETE FROM patients WHERE id = $1`, [ids.patient]);
    await query(`DELETE FROM service_items WHERE code LIKE $1`, [`P320%${tag}`]);
    await query(`DELETE FROM service_subgroups WHERE code LIKE $1`, [`P320%${tag}`]);
    await query(`DELETE FROM service_groups WHERE code LIKE $1`, [`P320%${tag}`]);
    await query(`DELETE FROM patient_schemes WHERE parent_code = $1`, [TOP.code]);
    await query(`DELETE FROM patient_schemes WHERE code = $1`, [TOP.code]);
  });

  const deskLines = () => [
    { item_id: ids.consult },
    { item_id: ids.test },
    { item_id: ids.dressing },
    { item_id: ids.swab, quantity: 3 },
  ];

  test("1. the box's numbers match the preview for a real patient, line by line", async ({
    page,
  }) => {
    const codes = [CODES.t20, CODES.old, CODES.none];
    await openBox(page);
    await fillCase(page, {
      age: "70",
      gender: "Female",
      category: SUB.code,
      visitType: "New",
      codes,
    });
    const tested = await runTest(page);
    expect(tested.status, JSON.stringify(tested.json)).toBe(200);
    expect(tested.json.patient).toMatchObject({ id: null, age: 70, gender: "Female" });

    const desk = await preview("reception_admin", {
      patient_id: ids.patient,
      visit_type: "New",
      lines: deskLines(),
      codes,
    });
    expect(desk.patient).toMatchObject({ age: 70, gender: "Female" });
    expect(numbers(tested.json)).toEqual(numbers(desk));

    const shown = await boxLines(page);
    expect(shown.map((cells) => [cells[0], ...cells.slice(2)])).toEqual(lineRows(desk));
    expect(shown.map((cells) => cells[1].split("\n")[0])).toEqual(
      desk.lines.map((l) => l.bill_name),
    );
    expect(desk.lines.map((l) => [l.actual, l.discount, l.patient_payable, l.claim])).toEqual([
      [150000, 0, 70000, 80000],
      [40000, 8000, 32000, 0],
      [30000, 5000, 25000, 0],
      [9999, 0, 9999, 0],
    ]);
    expect(await boxTotals(page)).toEqual(totalsOf(desk));
    expect(desk.totals).toMatchObject({ round_off: 1, payable: 137000 });

    const applied = result(page).getByRole("region", { name: "Discounts that applied" });
    await expect(applied).toContainText(`P320 test 20 ${tag} (${CODES.t20})`);
    await expect(applied).toContainText(`${SENIORS} · Automatic · −₹50`);
    await expect(result(page).getByRole("cell", { name: /P320 Test/ })).toContainText(
      `P320 test 20 ${tag} (${CODES.t20}) −₹80 off what the patient pays`,
    );
    const refused = result(page).getByRole("region", { name: "Codes refused" });
    for (const r of desk.refused_codes) {
      await expect(refused).toContainText(`${r.code} — ${r.message}`);
    }
    expect(desk.refused_codes.map((r) => r.reason)).toEqual(["expired", "unknown"]);
    await expect(result(page)).toContainText(`Priced as ${TOP.label} › ${SUB.label}`);
  });

  test("2. testing as reception refuses an admin-only code, as the reception desk would", async ({
    page,
  }) => {
    const codes = [CODES.adm];
    await openBox(page);
    await fillCase(page, {
      age: "70",
      gender: "Female",
      category: SUB.code,
      visitType: "New",
      role: "reception",
      codes,
    });
    const tested = await runTest(page);
    expect(tested.status).toBe(200);
    const desk = await preview("reception", {
      patient_id: ids.patient,
      visit_type: "New",
      lines: deskLines(),
      codes,
    });
    expect(numbers(tested.json)).toEqual(numbers(desk));
    expect(desk.refused_codes.map((r) => r.reason)).toEqual(["role"]);
    await expect(result(page).getByRole("region", { name: "Codes refused" })).toContainText(
      `${CODES.adm} — ${desk.refused_codes[0].message}`,
    );
    expect(await boxTotals(page)).toEqual(totalsOf(desk));

    await box(page).getByLabel("Test as role", { exact: true }).selectOption("admin");
    const asAdmin = await runTest(page);
    expect(asAdmin.json.applied_codes.map((c) => c.code)).toEqual([CODES.adm]);
    await expect(
      result(page).getByRole("region", { name: "Discounts that applied" }),
    ).toContainText(`P320 admins ${tag} (${CODES.adm})`);
  });

  test("3. a younger man without the category gets no senior or scheme numbers", async ({
    page,
  }) => {
    await openBox(page);
    await fillCase(page, {
      age: "40",
      gender: "Male",
      category: "",
      visitType: "New",
      codes: [],
    });
    const tested = await runTest(page);
    expect(tested.status).toBe(200);
    expect(tested.json.category).toBeNull();
    const shown = await boxLines(page);
    expect(shown.map((cells) => [cells[0], ...cells.slice(2)])).toEqual(lineRows(tested.json));
    expect(await boxTotals(page)).toEqual(totalsOf(tested.json));
    await expect(result(page)).toContainText("Priced as General");
    expect(tested.json.lines.map((l) => l.claim)).toEqual([0, 0, 0, 0]);
    await expect(
      result(page).getByRole("region", { name: "Discounts that applied" }),
    ).not.toContainText(SENIORS);
  });

  test("4. a parent with sub-categories isn't offered on its own; a refused line is pointed at", async ({
    page,
  }) => {
    await openBox(page);
    const category = box(page).getByLabel("Test category", { exact: true });
    await expect(category.locator(`option[value="${TOP.code}"]`)).toHaveCount(0);
    await expect(category.locator(`optgroup[label="${TOP.label}"] option`)).toHaveText([
      `${TOP.label} › ${SUB.label}`,
    ]);
    await fillCase(page, {
      age: "70",
      gender: "Female",
      category: SUB.code,
      visitType: "New",
      codes: [],
    });
    await addItem(page, "gauze", 5);
    const lines = box(page).getByRole("list", { name: "Items on the test bill" });
    await expect(lines.getByRole("listitem").nth(4)).toContainText(`Line 5: ${ITEMS.gauze.name}`);
    const tested = await runTest(page);
    expect(tested.status).toBe(400);
    expect(tested.json.line_no).toBe(5);
    expect(tested.json.error).toContain("at most 2");
    await expect(box(page).getByRole("alert")).toHaveText(tested.json.error);
    await expect(box(page).getByRole("alert")).toContainText("Line 5:");
    await expect(result(page)).toHaveCount(0);
    await expect(lines.getByRole("listitem").nth(4)).toContainText("This line was refused");
    await expect(lines.getByText("This line was refused")).toHaveCount(1);

    await box(page).getByLabel("Test age", { exact: true }).fill("7y0");
    await expect(box(page).getByLabel("Test age", { exact: true })).toHaveValue("70");
    await box(page)
      .getByRole("button", { name: `Remove ${ITEMS.test.name} from the test` })
      .click();
    await expect(lines).not.toContainText(ITEMS.test.name);
    await expect(lines.getByRole("listitem").nth(3)).toContainText(`Line 4: ${ITEMS.gauze.name}`);
    await expect(lines.getByRole("listitem").nth(3)).toContainText("This line was refused");
    await box(page).getByLabel(`Quantity of ${ITEMS.gauze.name}`, { exact: true }).fill("2");
    expect((await runTest(page)).status).toBe(200);
    await expect(lines.getByText("This line was refused")).toHaveCount(0);
    await expect(result(page)).toBeVisible();
  });

  test("5. numbers left over from an earlier test are marked out of date", async ({ page }) => {
    await openBox(page);
    await fillCase(page, {
      age: "70",
      gender: "Female",
      category: SUB.code,
      visitType: "New",
      codes: [],
    });
    const stale = box(page).getByRole("status");
    expect((await runTest(page)).status).toBe(200);
    await expect(result(page)).toBeVisible();
    await expect(stale).toHaveCount(0);

    await box(page).getByLabel("Test age", { exact: true }).fill("40");
    await expect(stale).toContainText("these numbers are out of date");
    expect((await runTest(page)).status).toBe(200);
    await expect(stale).toHaveCount(0);

    await page.getByLabel("Search", { exact: true }).fill(tag);
    await page.getByRole("button", { name: `Edit discount ${SENIORS}`, exact: true }).click();
    await page.getByRole("dialog").getByLabel("₹ off", { exact: true }).fill("60");
    await page.getByRole("dialog").getByRole("button", { name: "Save discount" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(stale).toContainText("these numbers are out of date");
    const again = await runTest(page);
    expect(again.status).toBe(200);
    await expect(stale).toHaveCount(0);

    await box(page).getByRole("button", { name: "Clear", exact: true }).click();
    await expect(result(page)).toHaveCount(0);
    await expect(stale).toHaveCount(0);
  });
});
