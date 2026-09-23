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
const { MAX_BILL_LINES } = await import("../../../server/services/billing/priceBill.js");

const URL = "/api/billing/preview";
const db = getPool();
const ctx = { actorId: USERS.reception_admin.id, ip: "10.16.16.16" };
const tag = crypto.randomBytes(3).toString("hex");
const T = tag.toUpperCase();
const c = (name) => `p316_${name}_${tag}`;
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

const post = (role, data, url = URL) =>
  asRole(role, async (api) => {
    const response = await api.post(url, { data });
    return { status: response.status(), json: await response.json() };
  });

const postRaw = (role, text) =>
  asRole(role, async (api) => {
    const response = await api.post(URL, {
      data: text,
      headers: { "content-type": "application/json" },
    });
    return { status: response.status(), json: await response.json() };
  });

const bill = (extra = {}) => ({
  patient_id: ids.patient,
  date: DAY,
  visit_type: "New",
  lines: [{ item_id: ids.consult }, { item_id: ids.test }, { item_id: ids.dressing }],
  ...extra,
});

test.describe.serial("P3-16 preview endpoint", () => {
  test.beforeAll(async () => {
    await schemes.createScheme(
      { code: c("scheme"), label: `P316 Scheme ${tag}`, payer_name: `P316 Payer ${tag}` },
      db,
      ctx,
    );
    await schemes.createScheme(
      { code: c("paid"), label: "P316 Paid", parent_code: c("scheme") },
      db,
      ctx,
    );
    ids.group = await one(`INSERT INTO service_groups (code, name) VALUES ($1, $1) RETURNING id`, [
      `P316-G-${T}`,
    ]);
    const subgroup = (name) =>
      one(`INSERT INTO service_subgroups (group_id, code, name) VALUES ($1, $2, $2) RETURNING id`, [
        ids.group,
        `P316-${name}-${T}`,
      ]);
    ids.consults = await subgroup("CONS");
    ids.tests = await subgroup("TESTS");
    const item = (code, subgroupId, price) =>
      one(
        `INSERT INTO service_items (code, name, subgroup_id, base_price, kind)
         VALUES ($1, $1, $2, $3, 'procedure') RETURNING id`,
        [`${code}-${T}`, subgroupId, price],
      );
    ids.consult = await item("P316-CONSULT", ids.consults, 1500);
    ids.test = await item("P316-TEST", ids.tests, 400);
    ids.dressing = await item("P316-DRESS", ids.tests, 300);
    await rules.createPaymentRule(
      {
        scheme_code: c("paid"),
        valid_from: "2026-01-01",
        subgroup_id: ids.consults,
        name: `P316 consult ₹700 ${tag}`,
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
        name: `P316 all ${tag}`,
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
      name: "P316 test 20",
      method: "code",
      code: `P316T20${T}`,
      value: 20,
      service_item_ids: [ids.test],
    });
    await discount({
      name: "P316 old",
      method: "code",
      code: `P316OLD${T}`,
      value: 10,
      service_item_ids: [ids.test],
      valid_to: "2026-02-01",
    });
    await discount({
      name: "P316 admins",
      method: "code",
      code: `P316ADM${T}`,
      value: 10,
      service_item_ids: [ids.test],
      allowed_roles: ["reception_admin", "admin"],
    });
    await discount({
      name: "P316 seniors",
      method: "auto",
      kind: "flat",
      value: 50,
      min_age: 60,
      scheme_codes: [c("scheme")],
      service_item_ids: [ids.dressing],
    });
    ids.patient = await one(
      `INSERT INTO patients (name, dob, sex, scheme_code) VALUES ($1, '1956-01-01', 'Female', $2)
       RETURNING id`,
      [`P316 patient ${tag}`, c("paid")],
    );
    ids.parentPatient = await one(
      `INSERT INTO patients (name, dob, sex, scheme_code) VALUES ($1, '1980-01-01', 'Male', $2)
       RETURNING id`,
      [`P316 parent ${tag}`, c("scheme")],
    );
    ids.other = await one(
      `INSERT INTO patients (name, dob, sex) VALUES ($1, '1990-01-01', 'Male') RETURNING id`,
      [`P316 other ${tag}`],
    );
    ids.appointment = await one(
      `INSERT INTO appointments (patient_id, patient_name, appointment_date, visit_type, doctor_id, status)
       VALUES ($1, $2, $3, 'Follow Up', $4, 'scheduled') RETURNING id`,
      [ids.patient, `P316 patient ${tag}`, DAY, CONSULTANTS.banshali.id],
    );
  });

  test.afterAll(async () => {
    await query(
      `UPDATE discount_rules SET is_active = FALSE WHERE method = 'auto' AND name LIKE $1`,
      [`% ${tag}`],
    );
  });

  test("1. a request carrying a price, rate, discount, total or settings is rejected with 400", async () => {
    const money = {
      price: 100,
      rate: 100,
      base_price: 100,
      discount: 50,
      amount: 100,
      actual: 100,
      patient_payable: 0,
      total: 0,
      claim: 0,
    };
    for (const [key, value] of Object.entries(money)) {
      const inLine = await post(
        "reception",
        bill({ lines: [{ item_id: ids.test, [key]: value }] }),
      );
      expect(inLine.status, `line ${key}`).toBe(400);
      expect(inLine.json.error).toBe(`Unknown field: ${key}`);
      const onBill = await post("reception", bill({ [key]: value }));
      expect(onBill.status, `bill ${key}`).toBe(400);
      expect(onBill.json.error).toBe(`Unknown field: ${key}`);
    }
    for (const extra of [
      { settings: { discount_stacking: "per_rule" } },
      { totals: { payable: 0 } },
      { role: "admin" },
      { patient: { age: 5 } },
    ]) {
      const refused = await post("reception", bill(extra));
      expect(refused.status, JSON.stringify(extra)).toBe(400);
      expect(refused.json.error).toBe(`Unknown field: ${Object.keys(extra)[0]}`);
    }
  });

  test("2. other malformed requests are refused with readable 400s", async () => {
    const cases = [
      [{ patient_id: undefined }, "Choose the patient or the appointment to bill"],
      [{ lines: [] }, "Line list is empty: choose at least one item"],
      [
        { lines: Array.from({ length: MAX_BILL_LINES + 1 }, () => ({ item_id: ids.test })) },
        `Line list can have at most ${MAX_BILL_LINES} items`,
      ],
      [{ lines: [{ quantity: 1 }] }, "Line item is required"],
      [{ lines: [{ item_id: ids.test, quantity: 0 }] }, "Line quantity must be 1 or more"],
      [{ lines: [{ item_id: "abc" }] }, "Line item must be an id"],
      [{ visit_type: "Emergency" }, "Visit type must be one of: New, Follow Up, Investigation"],
      [{ codes: ["A B"] }, "Discount codes can't contain spaces"],
      [{ date: "10/11/2026" }, "Bill date must be a date like 2026-10-01"],
    ];
    for (const [extra, message] of cases) {
      const refused = await post("reception", bill(extra));
      expect(refused.status, message).toBe(400);
      expect(refused.json.error).toBe(message);
    }
  });

  test("3. prices the bill: payment rules, codes with reasons, automatic rules and totals", async () => {
    const { status, json } = await post(
      "reception",
      bill({ codes: [`p316t20${tag}`, `P316OLD${T}`, `P316NONE${T}`, `P316ADM${T}`] }),
    );
    expect(status, JSON.stringify(json)).toBe(200);
    expect(json.patient).toMatchObject({ id: ids.patient, age: 70, gender: "Female" });
    expect(json.category).toMatchObject({ code: c("paid"), source: "patient" });
    expect(json.payer_name).toBe(`P316 Payer ${tag}`);
    expect(json.lines.map((l) => l.service_item_id ?? l.item_id)).toEqual([
      ids.consult,
      ids.test,
      ids.dressing,
    ]);
    const figures = json.lines.map((l) => [l.actual, l.discount, l.patient_payable, l.claim]);
    expect(figures).toEqual([
      [150000, 0, 70000, 80000],
      [40000, 8000, 32000, 0],
      [30000, 5000, 25000, 0],
    ]);
    expect(json.lines[1].discounts.map((d) => d.name)).toEqual([`P316 test 20 ${tag}`]);
    expect(json.lines[2].discounts.map((d) => [d.name, d.method])).toEqual([
      [`P316 seniors ${tag}`, "auto"],
    ]);
    expect(json.applied_codes.map((a) => [a.code, a.amount])).toEqual([[`p316t20${tag}`, 8000]]);
    expect(json.refused_codes.map((r) => [r.code, r.reason])).toEqual([
      [`P316OLD${T}`, "expired"],
      [`P316NONE${T}`, "unknown"],
      [`P316ADM${T}`, "role"],
    ]);
    for (const refused of json.refused_codes) expect(refused.message).toBeTruthy();
    expect(json.totals).toMatchObject({
      actual: 220000,
      discount: 13000,
      patient_payable: 127000,
      claim: 80000,
      adjustment: 0,
      round_off: 0,
      payable: 127000,
    });
  });

  test("4. the role comes from the signed-in user, not the body", async () => {
    const codes = [`P316ADM${T}`];
    const desk = await post("reception", bill({ codes }));
    expect(desk.json.refused_codes.map((r) => r.reason)).toEqual(["role"]);
    const senior = await post("reception_admin", bill({ codes }));
    expect(senior.status).toBe(200);
    expect(senior.json.refused_codes).toEqual([]);
    expect(senior.json.lines[1].discount).toBe(4000);
  });

  test("5. an appointment supplies the patient, visit type and doctor", async () => {
    const { status, json } = await post(
      "reception",
      bill({ patient_id: undefined, visit_type: undefined, appointment_id: ids.appointment }),
    );
    expect(status, JSON.stringify(json)).toBe(200);
    expect(json.appointment_id).toBe(ids.appointment);
    expect(json.patient.id).toBe(ids.patient);
    expect(json.visit_type).toBe("Follow Up");
    expect(json.doctor_id).toBe(CONSULTANTS.banshali.id);
    expect(json.lines[0]).toMatchObject({ actual: 150000, patient_payable: 150000, claim: 0 });
  });

  test("6. the desk may choose the category and the bill date", async () => {
    const { status, json } = await post("reception", bill({ category: c("paid") }));
    expect(status).toBe(200);
    expect(json.category).toMatchObject({ code: c("paid"), source: "chosen" });
    const early = await post("reception", bill({ date: "2025-06-01" }));
    expect(early.status).toBe(200);
    expect(early.json.date).toBe("2025-06-01");
    expect(early.json.lines[0]).toMatchObject({ patient_payable: 150000, claim: 0 });
  });

  test("6b. without a chosen category the patient's own is used; General must be named", async () => {
    const own = await post("reception", bill());
    expect(own.status).toBe(200);
    expect(own.json.category).toMatchObject({ code: c("paid"), source: "patient" });
    expect(own.json.lines[0]).toMatchObject({ patient_payable: 70000, claim: 80000 });
    for (const general of ["general", "GENERAL"]) {
      const { status, json } = await post("reception", bill({ category: general }));
      expect(status, general).toBe(200);
      expect(json.category).toBeNull();
      expect(json.payer_name).toBeNull();
      expect(json.lines.map((l) => [l.claim, l.payment_rule_id])).toEqual([
        [0, null],
        [0, null],
        [0, null],
      ]);
    }
    for (const [category, message] of [
      ["", "Category can't be blank"],
      ["  ", "Category can't be blank"],
      [null, "Category must be a category code"],
    ]) {
      const refused = await post("reception", bill({ category }));
      expect(refused.status, JSON.stringify(category)).toBe(400);
      expect(refused.json.error).toBe(message);
    }
  });

  test("7. pricing errors come back as readable JSON with their status", async () => {
    const cases = [
      [{ patient_id: 2147480000 }, 404, "That patient doesn't exist"],
      [{ lines: [{ item_id: 2147480000 }] }, 404, "Line 1: That item doesn't exist"],
      [{ lines: [{ item_id: ids.test, quantity: 2 }] }, 400, /^Line 1: .*quantity must be 1$/],
      [{ category: c("scheme") }, 409, /has sub-categories/],
      [{ category: `p316_nope_${tag}` }, 404, /./],
      [{ patient_id: ids.other, appointment_id: ids.appointment }, 409, /another patient/],
    ];
    for (const [extra, status, message] of cases) {
      const refused = await post("reception", bill(extra));
      expect(refused.status, JSON.stringify(refused.json)).toBe(status);
      expect(refused.json.error).toMatch(message);
      expect(refused.json.error).not.toMatch(/Something went wrong/);
    }
  });

  test("7b. a refused bill carries what the desk needs to fix it", async () => {
    const parent = await post("reception", bill({ patient_id: ids.parentPatient }));
    expect(parent.status, JSON.stringify(parent.json)).toBe(409);
    expect(parent.json.needs_sub_category).toBe(true);
    expect(parent.json.error).toMatch(/choose one of P316 Scheme .* › P316 Paid/);
    expect(parent.json.suggestions.map((s) => [s.category.code, s.reason])).toEqual([
      [c("paid"), "choose_sub_category"],
    ]);
    const chosenParent = await post("reception", bill({ category: c("scheme") }));
    expect(chosenParent.status, JSON.stringify(chosenParent.json)).toBe(409);
    expect(
      chosenParent.json.needs_sub_category,
      "a chosen parent is refused like a resolved one",
    ).toBe(true);
    expect(chosenParent.json.suggestions.map((sub) => sub.category.code)).toEqual([c("paid")]);
    expect(chosenParent.json.line_no, "the category is no line's fault").toBeUndefined();
    const chosen = await post(
      "reception",
      bill({ patient_id: ids.parentPatient, category: c("paid") }),
    );
    expect(chosen.status, JSON.stringify(chosen.json)).toBe(200);
    for (const [lines, status, lineNo] of [
      [[{ item_id: ids.test }, { item_id: 2147480000 }], 404, 2],
      [
        [{ item_id: ids.test }, { item_id: ids.consult }, { item_id: ids.dressing, quantity: 3 }],
        400,
        3,
      ],
    ]) {
      const refused = await post("reception", bill({ lines }));
      expect(refused.status, JSON.stringify(refused.json)).toBe(status);
      expect(refused.json.line_no).toBe(lineNo);
      expect(refused.json.error).toMatch(new RegExp(`^Line ${lineNo}: `));
    }
    const other = await post("reception", bill({ patient_id: 2147480000 }));
    expect(Object.keys(other.json)).toEqual(["error"]);
  });

  test("7c. odd shapes and values get readable 400s, never a database error", async () => {
    const cases = [
      [{ category: 5 }, "Category must be a category code"],
      [{ category: { code: c("paid") } }, "Category must be a category code"],
      [{ codes: [5] }, "Discount codes must be a list of codes"],
      [
        { codes: Array.from({ length: 21 }, (_, i) => `P316X${i}`) },
        "Discount codes can be at most 20",
      ],
      [{ lines: [5] }, "Line must be an item, like { item_id: 12 }"],
      [{ lines: [{ item_id: -3 }] }, "Line item must be an id"],
      [{ lines: [{ item_id: ids.test, doctor_id: "0" }] }, "Line doctor must be an id"],
      [{ doctor_id: -1 }, "Consultant must be 1 or more"],
      [{ date: "2026-02-30" }, "Bill date must be a date like 2026-10-01"],
      [{ date: "2026-13-01" }, "Bill date must be a date like 2026-10-01"],
    ];
    for (const [extra, message] of cases) {
      const refused = await post("reception", bill(extra));
      expect(refused.status, message).toBe(400);
      expect(refused.json.error).toBe(message);
    }
    const leap = await post("reception", bill({ date: "2028-02-29" }));
    expect(leap.status).toBe(200);
    for (const [text, message] of [
      ["[1, 2]", "Send the bill as an object"],
      [
        `{"patient_id": ${ids.patient}, "lines": [{"item_id": ${ids.test}}], "__proto__": {"price": 1}}`,
        "Unknown field: __proto__",
      ],
      [
        `{"patient_id": ${ids.patient}, "lines": [{"item_id": ${ids.test}, "constructor": {"price": 1}}]}`,
        "Unknown field: constructor",
      ],
    ]) {
      const refused = await postRaw("reception", text);
      expect(refused.status, text).toBe(400);
      expect(refused.json.error).toBe(message);
    }
  });

  test("8. BILLING_DESK roles may preview; others are refused", async () => {
    for (const role of ["reception", "reception_admin", "admin"]) {
      expect((await post(role, bill())).status, role).toBe(200);
    }
    for (const role of ["coordinator", "lab", "banshali"]) {
      const refused = await post(role, bill());
      expect(refused.status, role).toBe(403);
      expect(refused.json.error).toBe("Insufficient permissions");
    }
    const anonymous = await post(null, bill());
    expect(anonymous.status).toBe(403);
    expect(anonymous.json.error).toBe("Doctor account required");
  });
});
