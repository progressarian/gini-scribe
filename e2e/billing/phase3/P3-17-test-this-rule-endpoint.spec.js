import crypto from "node:crypto";
import { test, expect } from "@playwright/test";
import { anonymousApi, apiAs } from "../../helpers/auth.mjs";
import { getPool, query } from "../../helpers/db.mjs";
import { USERS, CONSULTANTS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const rules = await import("../../../server/services/billing/paymentRules.js");
const discounts = await import("../../../server/services/billing/discountRules.js");
const schemes = await import("../../../server/services/patientSchemes.js");

const PREVIEW = "/api/billing/preview";
const TEST_RULE = "/api/billing/master/test-rule";
const db = getPool();
const ctx = { actorId: USERS.reception_admin.id, ip: "10.17.17.17" };
const tag = crypto.randomBytes(3).toString("hex");
const T = tag.toUpperCase();
const c = (name) => `p317_${name}_${tag}`;
const DAY = "2026-11-10";
const ids = {};

const one = (sql, params) => query(sql, params).then((r) => r.rows[0].id);

async function asRole(role, work) {
  const api = role ? await apiAs(role) : await anonymousApi();
  try {
    return await work(api);
  } finally {
    await api.dispose();
  }
}

const post = (role, url, data) =>
  asRole(role, async (api) => {
    const response = await api.post(url, { data });
    return { status: response.status(), json: await response.json() };
  });

const lines = () => [
  { item_id: ids.consult },
  { item_id: ids.test },
  { item_id: ids.dressing },
  { item_id: ids.swab, quantity: 3 },
];

const trial = (extra = {}) => ({
  age: 70,
  gender: "Female",
  category: c("paid"),
  date: DAY,
  visit_type: "New",
  lines: lines(),
  ...extra,
});

const sameCategory = (category) => {
  if (!category) return null;
  const { source: _source, rule: _rule, ...rest } = category;
  return rest;
};

const numbers = (priced) => ({
  date: priced.date,
  patient: { age: priced.patient.age, gender: priced.patient.gender },
  category: sameCategory(priced.category),
  payer_name: priced.payer_name,
  warnings: priced.warnings,
  visit_type: priced.visit_type,
  doctor_id: priced.doctor_id,
  settings: priced.settings,
  lines: priced.lines,
  applied_codes: priced.applied_codes,
  refused_codes: priced.refused_codes,
  bill_discounts: priced.bill_discounts,
  totals: priced.totals,
});

test.describe.serial("P3-17 test this rule endpoint", () => {
  test.beforeAll(async () => {
    await schemes.createScheme(
      { code: c("scheme"), label: `P317 Scheme ${tag}`, payer_name: `P317 Payer ${tag}` },
      db,
      ctx,
    );
    await schemes.createScheme(
      { code: c("paid"), label: "P317 Paid", parent_code: c("scheme") },
      db,
      ctx,
    );
    ids.group = await one(`INSERT INTO service_groups (code, name) VALUES ($1, $1) RETURNING id`, [
      `P317-G-${T}`,
    ]);
    const subgroup = (name) =>
      one(`INSERT INTO service_subgroups (group_id, code, name) VALUES ($1, $2, $2) RETURNING id`, [
        ids.group,
        `P317-${name}-${T}`,
      ]);
    ids.consults = await subgroup("CONS");
    ids.tests = await subgroup("TESTS");
    const item = (code, subgroupId, price, allowQuantity = false) =>
      one(
        `INSERT INTO service_items (code, name, subgroup_id, base_price, kind, allow_quantity)
         VALUES ($1, $1, $2, $3, 'procedure', $4) RETURNING id`,
        [`${code}-${T}`, subgroupId, price, allowQuantity],
      );
    ids.consult = await item("P317-CONSULT", ids.consults, 1500);
    ids.test = await item("P317-TEST", ids.tests, 400);
    ids.dressing = await item("P317-DRESS", ids.tests, 300);
    ids.swab = await item("P317-SWAB", ids.tests, 33.33, true);
    await rules.createPaymentRule(
      {
        scheme_code: c("paid"),
        valid_from: "2026-01-01",
        subgroup_id: ids.consults,
        name: `P317 consult ₹700 ${tag}`,
        patient_pays: "amount",
        patient_value: 700,
        remainder: "claim",
        visit_types: ["New"],
      },
      ctx,
      db,
    );
    await rules.createPaymentRule(
      {
        scheme_code: c("paid"),
        valid_from: "2025-01-01",
        name: `P317 all ${tag}`,
        patient_pays: "percent",
        patient_value: 100,
        remainder: "adjustment",
      },
      ctx,
      db,
    );
    const discount = (input) =>
      discounts.createDiscountRule(
        {
          kind: "percent",
          valid_from: "2026-01-01",
          applies_on_scheme_rate: true,
          ...input,
          name: `${input.name} ${tag}`,
        },
        ctx,
        db,
      );
    await discount({
      name: "P317 test 20",
      method: "code",
      code: `P317T20${T}`,
      value: 20,
      service_item_ids: [ids.test],
    });
    await discount({
      name: "P317 old",
      method: "code",
      code: `P317OLD${T}`,
      value: 10,
      valid_to: "2026-02-01",
    });
    await discount({
      name: "P317 admins",
      method: "code",
      code: `P317ADM${T}`,
      value: 25,
      service_item_ids: [ids.test],
      allowed_roles: ["admin"],
    });
    await discount({
      name: "P317 seniors",
      method: "auto",
      kind: "flat",
      value: 50,
      min_age: 60,
      scheme_codes: [c("scheme")],
      service_item_ids: [ids.dressing],
    });
    await discount({
      name: "P317 women",
      method: "auto",
      value: 10,
      gender: "Female",
      scheme_codes: [c("scheme")],
      service_item_ids: [ids.swab],
    });
    ids.patient = await one(
      `INSERT INTO patients (name, dob, sex, scheme_code) VALUES ($1, '1956-01-01', 'Female', $2)
       RETURNING id`,
      [`P317 patient ${tag}`, c("paid")],
    );
    ids.appointment = await one(
      `INSERT INTO appointments (patient_id, patient_name, appointment_date, visit_type, doctor_id, status)
       VALUES ($1, $2, $3, 'Follow Up', $4, 'scheduled') RETURNING id`,
      [ids.patient, `P317 patient ${tag}`, DAY, CONSULTANTS.banshali.id],
    );
  });

  test.afterAll(async () => {
    await query(
      `UPDATE discount_rules SET is_active = FALSE WHERE method = 'auto' AND name LIKE $1`,
      [`% ${tag}`],
    );
  });

  test("1. it returns the same numbers as the preview for the same inputs", async () => {
    const codes = [`P317T20${T}`, `P317OLD${T}`, `P317NONE${T}`];
    const pairs = [
      [
        { patient_id: ids.patient, date: DAY, visit_type: "New", lines: lines(), codes },
        trial({ codes }),
      ],
      [
        { appointment_id: ids.appointment, date: DAY, lines: lines() },
        trial({ visit_type: "Follow Up", doctor_id: CONSULTANTS.banshali.id }),
      ],
      [
        { patient_id: ids.patient, date: "2025-06-01", visit_type: "New", lines: lines() },
        trial({ date: "2025-06-01", age: 69 }),
      ],
    ];
    for (const [desk, rule] of pairs) {
      const preview = await post("reception_admin", PREVIEW, desk);
      const tested = await post("reception_admin", TEST_RULE, rule);
      expect(preview.status, JSON.stringify(preview.json)).toBe(200);
      expect(tested.status, JSON.stringify(tested.json)).toBe(200);
      expect(numbers(tested.json)).toEqual(numbers(preview.json));
      expect(tested.json.patient).toEqual({
        id: null,
        age: rule.age,
        gender: "Female",
        age_source: null,
      });
      expect(tested.json.appointment_id).toBeNull();
    }
    const first = await post("reception_admin", TEST_RULE, trial({ codes }));
    expect(first.json.lines.map((l) => [l.actual, l.discount, l.patient_payable, l.claim])).toEqual(
      [
        [150000, 0, 70000, 80000],
        [40000, 8000, 32000, 0],
        [30000, 5000, 25000, 0],
        [9999, 1000, 8999, 0],
      ],
    );
    expect(first.json.refused_codes.map((r) => r.reason)).toEqual(["expired", "unknown"]);
    expect(first.json.totals).toMatchObject({
      patient_payable: 135999,
      round_off: 1,
      payable: 136000,
    });
  });

  test("2. the age and gender typed in change the result", async () => {
    const senior = await post("reception_admin", TEST_RULE, trial());
    const young = await post("reception_admin", TEST_RULE, trial({ age: 40, gender: "Male" }));
    const unknown = await post("reception_admin", TEST_RULE, trial({ age: null, gender: null }));
    expect(senior.json.lines.slice(2).map((l) => l.discount)).toEqual([5000, 1000]);
    expect(young.json.lines.slice(2).map((l) => l.discount)).toEqual([0, 0]);
    expect(unknown.json.lines.slice(2).map((l) => l.discount)).toEqual([0, 0]);
    expect(young.json.patient).toMatchObject({ id: null, age: 40, gender: "Male" });
  });

  test("3. no real patient: a patient or appointment is refused, like any price", async () => {
    for (const [key, value] of [
      ["patient_id", ids.patient],
      ["appointment_id", ids.appointment],
    ]) {
      const refused = await post("reception_admin", TEST_RULE, trial({ [key]: value }));
      expect(refused.status, key).toBe(400);
      expect(refused.json.error).toBe(
        `${key === "patient_id" ? "Patient" : "Appointment"} can't be sent: a rule test uses an age, gender and category, not a real patient`,
      );
    }
    for (const extra of [
      { price: 100 },
      { patient_payable: 0 },
      { lines: [{ item_id: ids.test, rate: 100 }] },
      { settings: { discount_stacking: "per_rule" } },
      { patient: { age: 70 } },
    ]) {
      const refused = await post("reception_admin", TEST_RULE, trial(extra));
      expect(refused.status, JSON.stringify(extra)).toBe(400);
      expect(refused.json.error).toMatch(/^Unknown field: /);
    }
    const cases = [
      [{ age: 151 }, "Age must be at most 150"],
      [{ age: -1 }, "Age must be 0 or more"],
      [{ age: 7.5 }, "Age must be a whole number"],
      [{ gender: "F" }, "Gender must be one of: Male, Female, Other"],
      [{ age: "70" }, "Age must be a whole number"],
      [{ age: true }, "Age must be a whole number"],
      [{ role: "doctor" }, "Role must be one of: reception, reception_admin, admin"],
      [{ role: null }, "Role must be one of: reception, reception_admin, admin"],
      [{ category: 5 }, "Category must be a category code"],
      [{ date: "2026-02-30" }, "Bill date must be a date like 2026-10-01"],
      [{ lines: [] }, "Line list is empty: choose at least one item"],
    ];
    for (const [extra, message] of cases) {
      const refused = await post("reception_admin", TEST_RULE, trial(extra));
      expect(refused.status, message).toBe(400);
      expect(refused.json.error).toBe(message);
    }
  });

  test("4. without a category the lines are priced as General", async () => {
    const { status, json } = await post(
      "reception_admin",
      TEST_RULE,
      trial({ category: undefined }),
    );
    expect(status).toBe(200);
    expect(json.category).toBeNull();
    expect(json.payer_name).toBeNull();
    expect(json.lines.map((l) => [l.actual, l.claim, l.payment_rule_id])).toEqual([
      [150000, 0, null],
      [40000, 0, null],
      [30000, 0, null],
      [9999, 0, null],
    ]);
  });

  test("5. pricing errors come back as readable JSON with their status", async () => {
    const cases = [
      [{ category: c("scheme") }, 409, /has sub-categories/],
      [{ category: `p317_nope_${tag}` }, 404, /./],
      [{ lines: [{ item_id: 2147480000 }] }, 404, "Line 1: That item doesn't exist"],
      [{ lines: [{ item_id: ids.test, quantity: 2 }] }, 400, /^Line 1: .*quantity must be 1$/],
    ];
    for (const [extra, status, message] of cases) {
      const refused = await post("reception_admin", TEST_RULE, trial(extra));
      expect(refused.status, JSON.stringify(refused.json)).toBe(status);
      expect(refused.json.error).toMatch(message);
    }
    const third = await post(
      "reception_admin",
      TEST_RULE,
      trial({ lines: [...lines(), { item_id: ids.test, quantity: 2 }] }),
    );
    expect(third.status).toBe(400);
    expect(third.json.line_no).toBe(5);
    const whole = await asRole("reception_admin", async (api) => {
      const response = await api.post(TEST_RULE, {
        data: "[]",
        headers: { "content-type": "application/json" },
      });
      return { status: response.status(), json: await response.json() };
    });
    expect(whole.status).toBe(400);
    expect(whole.json.error).toBe("Send the bill as an object");
  });

  test("5b. the admin may test as another desk role; the default is their own", async () => {
    const codes = [`P317ADM${T}`];
    const own = await post("admin", TEST_RULE, trial({ codes }));
    expect(own.status, JSON.stringify(own.json)).toBe(200);
    expect(own.json.refused_codes).toEqual([]);
    expect(own.json.lines[1].discount).toBe(10000);
    const asDesk = await post("admin", TEST_RULE, trial({ codes, role: "reception" }));
    expect(asDesk.status).toBe(200);
    expect(asDesk.json.refused_codes.map((r) => [r.code, r.reason])).toEqual([
      [`P317ADM${T}`, "role"],
    ]);
    expect(asDesk.json.refused_codes[0].message).toMatch(/not reception$/);
    expect(asDesk.json.lines[1].discount).toBe(0);
    const master = await post("reception_admin", TEST_RULE, trial({ codes }));
    expect(master.json.refused_codes.map((r) => r.reason)).toEqual(["role"]);
    const lifted = await post("reception_admin", TEST_RULE, trial({ codes, role: "admin" }));
    expect(lifted.json.refused_codes).toEqual([]);
    expect(lifted.json.lines[1].discount).toBe(10000);
    const preview = await post("reception", PREVIEW, {
      patient_id: ids.patient,
      date: DAY,
      visit_type: "New",
      lines: lines(),
      codes,
    });
    expect(numbers(asDesk.json)).toEqual(numbers(preview.json));
  });

  test("6. BILLING_MASTER roles may test rules; the desk and others are refused", async () => {
    for (const role of ["reception_admin", "admin"]) {
      expect((await post(role, TEST_RULE, trial())).status, role).toBe(200);
    }
    for (const role of ["reception", "coordinator", "lab", "banshali"]) {
      const refused = await post(role, TEST_RULE, trial());
      expect(refused.status, role).toBe(403);
      expect(refused.json.error).toBe("Insufficient permissions");
    }
    const anonymous = await post(null, TEST_RULE, trial());
    expect(anonymous.status).toBe(403);
    expect(anonymous.json.error).toBe("Doctor account required");
  });
});
