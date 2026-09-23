import crypto from "node:crypto";
import { test, expect } from "@playwright/test";
import { apiAs } from "../../helpers/auth.mjs";
import { getPool, query } from "../../helpers/db.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const schemes = await import("../../../server/services/patientSchemes.js");
const discountService = await import("../../../server/services/billing/discountRules.js");
const { indiaToday } = await import("../../../server/services/billing/categoryResolver.js");

const MASTER = "/api/billing/master";
const RULES = `${MASTER}/payment-rules`;
const DISCOUNTS = `${MASTER}/discounts`;
const FEES = `${MASTER}/consultant-fees`;
const ctx = { actorId: USERS.reception_admin.id, ip: "10.18.1.18" };
const tag = crypto.randomBytes(3).toString("hex");
const T = tag.toUpperCase();
const c = (name) => `p318r_${name}_${tag}`;
const ids = {};

const one = (sql, params) => query(sql, params).then((r) => r.rows[0].id);

async function call(role, method, url, data) {
  const api = await apiAs(role);
  try {
    const response = await api[method](url, data === undefined ? {} : { data });
    return { status: response.status(), json: await response.json() };
  } finally {
    await api.dispose();
  }
}

const admin = (method, url, data) => call("reception_admin", method, url, data);
const expectStatus = (response, status) =>
  expect(response.status, JSON.stringify(response.json)).toBe(status);

test.describe.serial("P3-18 payment rule, discount and consultant fee routes", () => {
  test.beforeAll(async () => {
    await schemes.createScheme(
      { code: c("cghs"), label: `P318R CGHS ${tag}`, payer_name: "CGHS Wellness Centre" },
      getPool(),
      ctx,
    );
    await schemes.createScheme(
      { code: c("pensioner"), label: "Pensioner", parent_code: c("cghs") },
      getPool(),
      ctx,
    );
    ids.opd = await one(`INSERT INTO service_groups (code, name) VALUES ($1, $1) RETURNING id`, [
      `P318R-OPD-${T}`,
    ]);
    ids.consults = await one(
      `INSERT INTO service_subgroups (group_id, code, name) VALUES ($1, $2, $2) RETURNING id`,
      [ids.opd, `P318R-CONS-${T}`],
    );
    ids.dressing = await one(
      `INSERT INTO service_items (code, name, subgroup_id, base_price, kind)
       VALUES ($1, $2, $3, 300, 'procedure') RETURNING id`,
      [`P318R-DRESS-${T}`, `Dressing ${tag}`, ids.consults],
    );
    ids.doctor = await one(
      `INSERT INTO doctors (name, short_name, role) VALUES ($1, 'Dr Route', 'consultant') RETURNING id`,
      [`Dr Route P318R ${tag}`],
    );
    ids.consult = await one(
      `INSERT INTO service_items (code, name, subgroup_id, base_price, kind, doctor_id, visit_type)
       VALUES ($1, $1, $2, 1500, 'consultation', $3, 'New') RETURNING id`,
      [`P318R-CONSULT-${T}`, ids.consults, ids.doctor],
    );
  });

  test.afterAll(async () => {
    await query(
      `UPDATE discount_rules SET is_active = FALSE WHERE method = 'auto' AND name LIKE $1`,
      [`% ${tag}`],
    );
    await query(`UPDATE service_items SET is_active = FALSE WHERE code LIKE $1`, [`P318R-%-${T}`]);
    await query(`UPDATE doctors SET is_active = FALSE WHERE name LIKE $1`, [`% P318R ${tag}`]);
  });

  test("1. payment rules: create, list with the parent's rules inherited, update, deactivate, delete", async () => {
    const parent = await admin("post", RULES, {
      scheme_code: c("cghs"),
      name: `CGHS consults ${tag}`,
      subgroup_id: ids.consults,
      patient_pays: "percent",
      patient_value: 50,
      remainder: "claim",
      valid_from: "2026-01-01",
    });
    expectStatus(parent, 201);
    expect(parent.json).toMatchObject({ patient_pays: "percent", patient_value: 50 });
    ids.parentRule = parent.json.id;
    const own = await admin("post", RULES, {
      scheme_code: c("pensioner"),
      name: `Pensioner consult ${tag}`,
      service_item_id: ids.consult,
      visit_types: ["New"],
      patient_pays: "nothing",
    });
    expectStatus(own, 201);
    ids.ownRule = own.json.id;
    expect(own.json.valid_from).toBe(indiaToday());

    const list = await admin("get", `${RULES}?schemeCode=${c("pensioner")}`);
    expectStatus(list, 200);
    expect(
      list.json.map((r) => ({
        id: r.id,
        inherited: r.inherited,
        scope: r.scope,
        label: r.scope_label,
      })),
    ).toEqual([
      { id: ids.ownRule, inherited: false, scope: "item", label: `P318R-CONSULT-${T}` },
      { id: ids.parentRule, inherited: true, scope: "subgroup", label: `P318R-CONS-${T}` },
    ]);
    expect(list.json[0].category_label).toBe(`P318R CGHS ${tag} › Pensioner`);

    const updated = await admin("patch", `${RULES}/${ids.ownRule}`, {
      patient_pays: "amount",
      patient_value: "200",
      remainder: "adjustment",
    });
    expectStatus(updated, 200);
    expect(updated.json).toMatchObject({
      patient_pays: "amount",
      patient_value: 200,
      remainder: "adjustment",
    });
    const off = await admin("put", `${RULES}/${ids.ownRule}/active`, { is_active: false });
    expectStatus(off, 200);
    expect(off.json.is_active).toBe(false);
    const activeOnly = await admin("get", `${RULES}?schemeCode=${c("pensioner")}&activeOnly=true`);
    expect(activeOnly.json.map((r) => r.id)).toEqual([ids.parentRule]);
    const on = await admin("put", `${RULES}/${ids.ownRule}/active`, { is_active: true });
    expectStatus(on, 200);
    const gone = await admin("delete", `${RULES}/${ids.ownRule}`);
    expectStatus(gone, 200);
    expect(gone.json).toEqual({ deleted: true, id: ids.ownRule });
    expectStatus(await admin("delete", `${RULES}/${ids.ownRule}`), 404);
  });

  test("2. payment rules: the cheaper-items refusal reaches the client as a list", async () => {
    const refused = await admin("post", RULES, {
      scheme_code: c("cghs"),
      name: `CGHS flat ${tag}`,
      subgroup_id: ids.consults,
      patient_pays: "amount",
      patient_value: 700,
    });
    expectStatus(refused, 409);
    expect(refused.json.error).toContain("items that cost less");
    expect(refused.json.items).toEqual([
      expect.objectContaining({ id: ids.dressing, name: `Dressing ${tag}`, price: 300 }),
    ]);
    const onUpdate = await admin("patch", `${RULES}/${ids.parentRule}`, {
      patient_pays: "amount",
      patient_value: 700,
    });
    expectStatus(onUpdate, 409);
    expect(onUpdate.json.items.map((i) => i.id)).toEqual([ids.dressing]);
  });

  test("3. payment rules: readable 400s, and 404 for an unknown rule", async () => {
    const cases = [
      [
        { scheme_code: c("cghs"), name: "x", patient_pays: "full", price: 1 },
        "Unknown field: price",
      ],
      [{ scheme_code: c("cghs"), name: " ", patient_pays: "full" }, "Name can't be blank"],
      [{ scheme_code: c("cghs"), name: "x", patient_pays: "half" }, "Patient pays must be one of"],
      [{ name: "x", patient_pays: "full" }, "Category"],
      [
        { scheme_code: c("cghs"), name: "x", patient_pays: "full", visit_types: ["Walk-in"] },
        "Visit types",
      ],
      [
        { scheme_code: c("cghs"), name: "x", patient_pays: "full", valid_from: "2026-02-30" },
        "From must be a date",
      ],
      [
        { scheme_code: c("cghs"), name: "x", patient_pays: "percent", patient_value: 120 },
        "percent must be from 0 to 100",
      ],
    ];
    for (const [body, message] of cases) {
      const response = await admin("post", RULES, body);
      expectStatus(response, 400);
      expect(response.json.error).toContain(message);
    }
    const empty = await admin("patch", `${RULES}/${ids.parentRule}`, {});
    expectStatus(empty, 400);
    const unknown = await admin("patch", `${RULES}/999999999`, { name: "x" });
    expectStatus(unknown, 404);
    const badQuery = await admin("get", `${RULES}?activeOnly=maybe`);
    expectStatus(badQuery, 400);
  });

  test("4. discounts: CC50 and an age rule are created, listed with names and today's usage, edited, switched off and deleted", async () => {
    const code = `CC50${T}`;
    const coupon = await admin("post", DISCOUNTS, {
      code,
      name: `CC50 ${tag}`,
      method: "code",
      kind: "percent",
      value: 50,
      max_discount: 500,
      group_ids: [ids.opd],
      doctor_ids: [ids.doctor],
      scheme_codes: [c("cghs")],
      max_uses_per_day: 10,
      max_uses_per_doctor_per_day: 3,
      allowed_roles: ["reception", "reception_admin"],
    });
    expectStatus(coupon, 201);
    ids.coupon = coupon.json.id;
    const age = await admin("post", DISCOUNTS, {
      name: `Senior 70 ${tag}`,
      method: "auto",
      kind: "percent",
      value: 10,
      min_age: 70,
      service_item_ids: [ids.dressing],
    });
    expectStatus(age, 201);
    ids.age = age.json.id;

    const list = await admin("get", DISCOUNTS);
    expectStatus(list, 200);
    const listed = list.json.find((d) => d.id === ids.coupon);
    expect(listed).toMatchObject({
      code,
      method: "code",
      value: 50,
      max_discount: 500,
      group_names: [`P318R-OPD-${T}`],
      doctor_names: [`Dr Route P318R ${tag}`],
      category_names: [`P318R CGHS ${tag}`],
      max_uses_per_day: 10,
      max_uses_per_doctor_per_day: 3,
      uses_total: 0,
      usage_today: { date: indiaToday(), count: 0, by_doctor: [] },
    });
    const autos = await admin("get", `${DISCOUNTS}?method=auto`);
    expect(autos.json.every((d) => d.method === "auto")).toBe(true);
    expect(autos.json.some((d) => d.id === ids.age)).toBe(true);
    expect(autos.json.some((d) => d.id === ids.coupon)).toBe(false);

    const edited = await admin("patch", `${DISCOUNTS}/${ids.age}`, { min_age: 71, value: "15" });
    expectStatus(edited, 200);
    expect(edited.json).toMatchObject({ min_age: 71, value: 15 });
    const couponEdit = await admin("patch", `${DISCOUNTS}/${ids.coupon}`, {
      max_uses_per_day: null,
    });
    expectStatus(couponEdit, 200);
    expect(couponEdit.json.max_uses_per_day).toBeNull();
    const off = await admin("put", `${DISCOUNTS}/${ids.age}/active`, { is_active: false });
    expectStatus(off, 200);
    expect(off.json.is_active).toBe(false);
    const active = await admin("get", `${DISCOUNTS}?activeOnly=true`);
    expect(active.json.some((d) => d.id === ids.age)).toBe(false);
    const deleted = await admin("delete", `${DISCOUNTS}/${ids.age}`);
    expectStatus(deleted, 200);
    expectStatus(await admin("delete", `${DISCOUNTS}/${ids.age}`), 404);
  });

  test("5. discounts: today's usage is counted per rule and per doctor", async () => {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE bills (id SERIAL PRIMARY KEY, patient_id INT, bill_date DATE, status TEXT);
        CREATE TABLE bill_lines (id SERIAL PRIMARY KEY, bill_id INT, doctor_id INT,
                                 is_live BOOLEAN NOT NULL DEFAULT TRUE);
        CREATE TABLE bill_line_discounts (id SERIAL PRIMARY KEY, bill_line_id INT, rule_id INT);`);
      const use = async (date, doctor, status = "final") => {
        const bill = await client.query(
          `INSERT INTO bills (patient_id, bill_date, status) VALUES (900001, $1, $2) RETURNING id`,
          [date, status],
        );
        const line = await client.query(
          `INSERT INTO bill_lines (bill_id, doctor_id) VALUES ($1, $2) RETURNING id`,
          [bill.rows[0].id, doctor],
        );
        await client.query(
          `INSERT INTO bill_line_discounts (bill_line_id, rule_id) VALUES ($1, $2)`,
          [line.rows[0].id, ids.coupon],
        );
      };
      const today = indiaToday();
      await use(today, ids.doctor);
      await use(today, ids.doctor);
      await use(today, null);
      await use(today, ids.doctor, "cancelled");
      await use("2026-01-05", ids.doctor);
      const rules = await discountService.listDiscountRulesWithUsage({}, client);
      const coupon = rules.find((r) => r.id === ids.coupon);
      expect(coupon.uses_total).toBe(4);
      expect(coupon.usage_today).toEqual({
        date: today,
        count: 3,
        by_doctor: [{ doctor_id: ids.doctor, name: `Dr Route P318R ${tag}`, count: 2 }],
      });
      const other = rules.find((r) => r.id !== ids.coupon);
      if (other) expect(other.usage_today.count).toBe(0);
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  });

  test("6. discounts: readable 400s", async () => {
    const cases = [
      [
        { name: "x", method: "code", kind: "percent", value: 5, amount: 1 },
        "Unknown field: amount",
      ],
      [{ name: "x", method: "sometimes", kind: "percent", value: 5 }, "Automatic or code"],
      [{ name: "x", method: "auto", kind: "percent", value: 5, code: "AUTO1" }, "has no code"],
      [{ name: "x", method: "code", kind: "percent", value: 5 }, "needs a code"],
      [{ name: "x", method: "auto", kind: "percent", value: 5, doctor_ids: ["abc"] }, "Doctors"],
      [{ name: "x", method: "auto", kind: "percent", value: 5, allowed_roles: ["nurse"] }, "Roles"],
    ];
    for (const [body, message] of cases) {
      const response = await admin("post", DISCOUNTS, body);
      expectStatus(response, 400);
      expect(response.json.error).toContain(message);
    }
    expectStatus(await admin("patch", `${DISCOUNTS}/${ids.coupon}`, {}), 400);
    expectStatus(await admin("get", `${DISCOUNTS}?method=never`), 400);
  });

  test("7. consultant fees routes: grid, save, clear, copy — and their 400s", async () => {
    const grid = await admin("get", `${FEES}?doctorId=${ids.doctor}&schemeCode=${c("cghs")}`);
    expectStatus(grid, 200);
    expect(grid.json.columns.map((col) => col.code)).toEqual([
      "general",
      c("cghs"),
      c("pensioner"),
    ]);
    expect(grid.json.rows).toHaveLength(1);
    expect(grid.json.not_priced).toEqual([
      expect.objectContaining({ visit_type: "Follow Up", status: "no_item" }),
    ]);
    const saved = await admin("put", FEES, {
      scheme_code: c("pensioner"),
      service_item_id: ids.consult,
      fee: "700",
      patient_pays: "nothing",
      bill_code: `P318R${T}`,
    });
    expectStatus(saved, 200);
    expect(saved.json.cell).toMatchObject({ fee: 700, bill_code: `P318R${T}`, inherited: false });
    const copied = await admin("post", `${FEES}/copy`, {
      from_scheme_code: c("pensioner"),
      to_scheme_code: c("cghs"),
    });
    expectStatus(copied, 200);
    expect(copied.json).toMatchObject({ copied: 1 });
    expect(copied.json.cells[0].cell).toMatchObject({ fee: 700, fee_source: "own" });
    const cleared = await admin("delete", `${FEES}/${c("pensioner")}/items/${ids.consult}`);
    expectStatus(cleared, 200);
    expect(cleared.json.cell).toMatchObject({ fee: 700, fee_source: "parent", inherited: true });

    const bad = [
      [
        "put",
        FEES,
        { scheme_code: c("pensioner"), service_item_id: ids.consult, rate: 1 },
        "Unknown field: rate",
      ],
      ["put", FEES, { service_item_id: ids.consult, fee: 1 }, "Category"],
      [
        "put",
        FEES,
        { scheme_code: c("pensioner"), service_item_id: ids.consult, fee: "abc" },
        "Fee",
      ],
      [
        "put",
        FEES,
        { scheme_code: c("pensioner"), service_item_id: ids.consult, patient_pays: "some" },
        "Patient pays",
      ],
      ["post", `${FEES}/copy`, { from_scheme_code: c("pensioner") }, "Copy to"],
      ["get", `${FEES}?doctorId=abc`, undefined, "Doctor"],
      ["get", `${FEES}?date=2026-13-01`, undefined, "As of"],
      ["delete", `${FEES}/${c("pensioner")}/items/${ids.consult}?date=soon`, undefined, "As of"],
    ];
    for (const [method, url, body, message] of bad) {
      const response = await admin(method, url, body);
      expectStatus(response, 400);
      expect(response.json.error).toContain(message);
    }
  });

  test("8. reception gets 403 on every new route", async () => {
    const routes = [
      ["get", RULES],
      ["post", RULES, {}],
      ["patch", `${RULES}/${ids.parentRule}`, { name: "x" }],
      ["put", `${RULES}/${ids.parentRule}/active`, { is_active: false }],
      ["delete", `${RULES}/${ids.parentRule}`],
      ["get", DISCOUNTS],
      ["post", DISCOUNTS, {}],
      ["patch", `${DISCOUNTS}/${ids.coupon}`, { name: "x" }],
      ["put", `${DISCOUNTS}/${ids.coupon}/active`, { is_active: false }],
      ["delete", `${DISCOUNTS}/${ids.coupon}`],
      ["get", FEES],
      ["put", FEES, {}],
      ["delete", `${FEES}/${c("cghs")}/items/${ids.consult}`],
      ["post", `${FEES}/copy`, {}],
    ];
    for (const [method, url, body] of routes) {
      const response = await call("reception", method, url, body);
      expect(response.status, `${method} ${url}`).toBe(403);
    }
    const still = await admin("get", `${RULES}?schemeCode=${c("cghs")}`);
    expect(still.json.find((r) => r.id === ids.parentRule).is_active).toBe(true);
  });

  test("9. the discounts list names every chosen target in the order it was chosen", async () => {
    const otherGroup = await one(
      `INSERT INTO service_groups (code, name) VALUES ($1, $1) RETURNING id`,
      [`P318R-LAB-${T}`],
    );
    const otherSubgroup = await one(
      `INSERT INTO service_subgroups (group_id, code, name) VALUES ($1, $2, $2) RETURNING id`,
      [otherGroup, `P318R-BLOOD-${T}`],
    );
    const otherItem = await one(
      `INSERT INTO service_items (code, name, subgroup_id, base_price, kind)
       VALUES ($1, $2, $3, 400, 'procedure') RETURNING id`,
      [`P318R-HBA1C-${T}`, `HbA1c ${tag}`, otherSubgroup],
    );
    const retiring = await one(
      `INSERT INTO doctors (name, short_name, role) VALUES ($1, 'Dr Gone', 'consultant') RETURNING id`,
      [`Dr Gone P318R ${tag}`],
    );
    const rule = await discountService.createDiscountRule(
      {
        name: `Targets ${tag}`,
        method: "auto",
        kind: "percent",
        value: 5,
        group_ids: [otherGroup, ids.opd],
        subgroup_ids: [otherSubgroup, ids.consults],
        service_item_ids: [otherItem, ids.dressing],
        doctor_ids: [retiring, ids.doctor],
        scheme_codes: ["general", c("pensioner")],
      },
      ctx,
      getPool(),
    );
    await query(`UPDATE doctors SET is_active = FALSE WHERE id = $1`, [retiring]);
    await discountService.setDiscountRuleActive(rule.id, false, ctx, getPool());

    const listed = (await discountService.listDiscountRulesWithUsage({}, getPool())).find(
      (d) => d.id === rule.id,
    );
    expect(listed.groups).toEqual([
      { id: otherGroup, name: `P318R-LAB-${T}`, is_active: true },
      { id: ids.opd, name: `P318R-OPD-${T}`, is_active: true },
    ]);
    expect(listed.subgroups.map((g) => g.id)).toEqual([otherSubgroup, ids.consults]);
    expect(listed.items.map((i) => [i.id, i.name])).toEqual([
      [otherItem, `HbA1c ${tag}`],
      [ids.dressing, `Dressing ${tag}`],
    ]);
    expect(listed.doctors).toEqual([
      { id: retiring, name: `Dr Gone P318R ${tag}`, is_active: false },
      { id: ids.doctor, name: `Dr Route P318R ${tag}`, is_active: true },
    ]);
    expect(listed.categories).toEqual([
      { code: "general", label: "General", display_label: "General", is_active: true },
      {
        code: c("pensioner"),
        label: "Pensioner",
        display_label: `P318R CGHS ${tag} › Pensioner`,
        is_active: true,
      },
    ]);
    expect(listed.group_names).toEqual([`P318R-LAB-${T}`, `P318R-OPD-${T}`].sort());
    expect(listed.doctor_names).toContain(`Dr Gone P318R ${tag}`);
    await discountService.deleteDiscountRule(rule.id, ctx, getPool());
  });
});
