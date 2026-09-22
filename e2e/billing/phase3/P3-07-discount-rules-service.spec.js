import crypto from "node:crypto";
import { test, expect } from "@playwright/test";
import { getPool, query } from "../../helpers/db.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const svc = await import("../../../server/services/billing/discountRules.js");
const rates = await import("../../../server/services/billing/categoryRates.js");
const schemes = await import("../../../server/services/patientSchemes.js");

const db = getPool();
const ctx = { actorId: USERS.reception_admin.id, ip: "10.10.10.10" };
const tag = crypto.randomBytes(3).toString("hex");
const T = tag.toUpperCase();
const c = (name) => `p307_${name}_${tag}`;
const code = (name) => `${name}${T}`;
const failure = (promise) => promise.then(() => null).catch((e) => e);
const ids = {};

const refused = async (promise, status, message, label) => {
  const error = await failure(promise);
  expect(error?.status, label).toBe(status);
  if (message) expect(error.message, label).toMatch(message);
  return error;
};
const create = (extra) =>
  svc.createDiscountRule({ method: "code", kind: "percent", value: 10, ...extra }, ctx, db);
const auditFor = (id) =>
  query(
    `SELECT action FROM billing_audit WHERE entity = 'discount_rules' AND entity_id = $1 ORDER BY id`,
    [String(id)],
  ).then((r) => r.rows.map((row) => row.action));

test.describe.serial("P3-07 discount rules service", () => {
  test.afterAll(async () => {
    await query(
      `UPDATE discount_rules SET is_active = FALSE WHERE method = 'auto' AND name LIKE '% ' || $1`,
      [tag],
    );
  });

  test.beforeAll(async () => {
    await schemes.createScheme(
      { code: c("cghs"), label: `P307 CGHS ${tag}`, payer_name: "CGHS" },
      db,
      ctx,
    );
    await schemes.createScheme(
      { code: c("paid"), label: "CGHS Paid", parent_code: c("cghs") },
      db,
      ctx,
    );
    await schemes.createScheme({ code: c("old"), label: `P307 Old ${tag}` }, db, ctx);
    await schemes.updateScheme(c("old"), { is_active: false }, db, ctx);
    const one = (sql, params) => query(sql, params).then((r) => r.rows[0].id);
    ids.opd = await one(`INSERT INTO service_groups (code, name) VALUES ($1, $2) RETURNING id`, [
      `P307G-${T}`,
      `P307 OPD ${tag}`,
    ]);
    ids.consults = await one(
      `INSERT INTO service_subgroups (group_id, code, name) VALUES ($1, $2, 'P307 Consults') RETURNING id`,
      [ids.opd, `P307S-${T}`],
    );
    const item = (itemCode, name, active = true) =>
      one(
        `INSERT INTO service_items (code, name, subgroup_id, base_price, kind, is_active)
         VALUES ($1, $2, $3, 1000, 'procedure', $4) RETURNING id`,
        [`${itemCode}-${T}`, name, ids.consults, active],
      );
    ids.consult = await item("P307-CONS", "P307 Consultant meet");
    ids.oldItem = await item("P307-OLD", "P307 Old item", false);
    ids.doctor = await one(
      `INSERT INTO doctors (name, role, pin, is_active) VALUES ($1, 'consultant', 'x', TRUE) RETURNING id`,
      [`Dr P307 ${tag}`],
    );
    await rates.saveRate(
      {
        scheme_code: c("paid"),
        service_item_id: ids.consult,
        rate: 700,
        bill_code: code("CC"),
        valid_from: "2026-01-01",
      },
      ctx,
      db,
    );
  });

  test("1. create a code discount: defaults, audit, and the list names its targets", async () => {
    const rule = await create({
      code: code("STAFF"),
      name: `Staff 10% ${tag}`,
      group_ids: [ids.opd],
      doctor_ids: [ids.doctor, ids.doctor],
      scheme_codes: [c("PAID").toUpperCase()],
      visit_types: ["Follow Up", "New"],
      max_uses_per_day: "10",
    });
    expect(rule).toMatchObject({
      method: "code",
      kind: "percent",
      value: 10,
      max_discount: null,
      doctor_ids: [ids.doctor],
      scheme_codes: [c("paid")],
      visit_types: ["New", "Follow Up"],
      applies_per: "line",
      priority: 100,
      stackable: false,
      applies_on_scheme_rate: false,
      allowed_roles: null,
      valid_from: null,
      max_uses_per_day: 10,
      is_active: true,
    });
    ids.staff = rule.id;
    const listed = (await svc.listDiscountRules({ method: "code" }, db)).find(
      (r) => r.id === rule.id,
    );
    expect(listed).toMatchObject({
      group_names: [`P307 OPD ${tag}`],
      doctor_names: [`Dr P307 ${tag}`],
      category_names: [`P307 CGHS ${tag} › CGHS Paid`],
      subgroup_names: null,
    });
    expect(await auditFor(rule.id)).toEqual(["create"]);
  });

  test("2. check 1: a code discount needs a code and an automatic one has none", async () => {
    await refused(create({ name: `No code ${tag}` }), 400, /needs a code/);
    await refused(create({ name: `Blank code ${tag}`, code: "  " }), 400, /needs a code/);
    await refused(
      create({ name: `Auto with code ${tag}`, method: "auto", code: code("AUTO") }),
      400,
      /automatic discount applies by itself, so it has no code/,
    );
    await refused(create({ name: `Spaced ${tag}`, code: "SEN IOR" }), 400, /can't contain spaces/);
    const auto = await svc.createDiscountRule(
      { name: `Seniors 5% ${tag}`, method: "auto", kind: "percent", value: 5, min_age: 70 },
      ctx,
      db,
    );
    expect([auto.method, auto.code]).toEqual(["auto", null]);
    const switched = await svc.updateDiscountRule(ids.staff, { method: "auto" }, ctx, db);
    expect([switched.method, switched.code], "switching to automatic clears the code").toEqual([
      "auto",
      null,
    ]);
    await refused(
      svc.updateDiscountRule(ids.staff, { method: "code" }, ctx, db),
      400,
      /needs a code/,
    );
    await svc.updateDiscountRule(ids.staff, { method: "code", code: code("STAFF") }, ctx, db);
  });

  test("3. check 2: a percent is 0–100, and the rest of the shape is sound", async () => {
    const bad = [
      ["percent over 100", { value: 100.01 }, /more than 0 and at most 100/],
      ["negative percent", { value: -1 }, /more than 0 and at most 100/],
      ["percent with 3 decimals", { value: 12.345 }, /2 decimals/],
      ["no value", { value: null }, /Enter the discount's value/],
      ["value as text", { value: "ten" }, /Value must be a number/],
      ["negative flat", { kind: "flat", value: -5 }, /amount off can't be negative/],
      ["fixed price with paise", { kind: "fixed_price", value: 99.999 }, /2 decimals/],
      ["cap on a flat discount", { kind: "flat", value: 50, max_discount: 20 }, /Only a percent/],
      ["negative cap", { max_discount: -1 }, /largest discount can't be negative/],
      [
        "fixed price for the bill",
        { kind: "fixed_price", value: 500, applies_per: "bill" },
        /can't apply to the whole bill/,
      ],
      ["ages backwards", { min_age: 70, max_age: 60 }, /From age can't be more than To age/],
      ["age over 150", { min_age: 151 }, /From age must be a whole number from 0 to 150/],
      ["dates backwards", { valid_from: "2026-10-10", valid_to: "2026-10-09" }, /To date/],
      ["zero uses", { max_uses_total: 0 }, /Total uses must be a whole number from 1/],
      ["half a use", { max_uses_per_patient: 1.5 }, /Uses per patient/],
      ["unknown kind", { kind: "bogo" }, /Kind must be one of/],
      ["unknown method", { method: "manual" }, /Method must be one of/],
      ["unknown gender", { gender: "M" }, /Gender must be one of/],
      ["unknown role", { allowed_roles: ["nurse"] }, /Roles must be from/],
      ["unknown visit type", { visit_types: ["Tele"] }, /Visit types must be from/],
      ["ids that aren't ids", { group_ids: ["abc"] }, /Groups must be a list of ids/],
      ["stackable as text", { stackable: "yes" }, /Stackable must be true or false/],
    ];
    for (const [n, [why, extra, message]] of bad.entries()) {
      await refused(
        create({ name: `Bad ${n} ${tag}`, code: code(`B${n}`), ...extra }),
        400,
        message,
        why,
      );
    }
    const full = await create({ name: `Free ${tag}`, code: code("FREE"), value: 100 });
    expect(full.value, "100% is allowed").toBe(100);
    const capped = await create({
      name: `Capped ${tag}`,
      code: code("CAP"),
      value: 50,
      max_discount: "200",
      applies_per: "bill",
      stackable: true,
      allowed_roles: ["admin", "reception"],
    });
    expect(capped).toMatchObject({
      max_discount: 200,
      applies_per: "bill",
      stackable: true,
      allowed_roles: ["reception", "admin"],
    });
    const flat = await svc.updateDiscountRule(capped.id, { kind: "flat", value: 100 }, ctx, db);
    expect(flat.max_discount, "switching away from percent clears the cap").toBeNull();
  });

  test("4. check 3: every target exists and is active", async () => {
    await refused(
      create({ name: `Ghost group ${tag}`, code: code("G1"), group_ids: [ids.opd, 999999998] }),
      404,
      /That group doesn't exist \(id 999999998\)/,
    );
    await refused(
      create({ name: `Ghosts ${tag}`, code: code("G2"), service_item_ids: [999999998, 999999997] }),
      404,
      /2 of the items don't exist/,
    );
    await refused(
      create({ name: `Ghost doctor ${tag}`, code: code("G3"), doctor_ids: [999999998] }),
      404,
      /That doctor doesn't exist/,
    );
    await refused(
      create({ name: `Off item ${tag}`, code: code("G4"), service_item_ids: [ids.oldItem] }),
      409,
      /Deactivated item: P307 Old item/,
    );
    const fine = await create({
      name: `Consult only ${tag}`,
      code: code("G5"),
      subgroup_ids: [ids.consults],
      service_item_ids: [ids.consult],
    });
    expect(fine.service_item_ids).toEqual([ids.consult]);
  });

  test("5. check 4: a discount code can't be a bill code, and a bill code can't be a discount code", async () => {
    const error = await refused(
      create({ name: `Clash ${tag}`, code: code("cc") }),
      409,
      new RegExp(
        `${code("CC")} is already the bill code of P307 Consultant meet for P307 CGHS ${tag} › CGHS Paid; choose another discount code`,
      ),
    );
    expect(error.message, "the check ignores case").toMatch(/already the bill code/);
    await refused(
      rates.saveRate(
        {
          scheme_code: c("paid"),
          service_item_id: ids.consult,
          rate: 700,
          bill_code: code("staff").toLowerCase(),
          valid_from: "2026-01-01",
        },
        ctx,
        db,
      ),
      409,
      /is already the code of the discount/,
    );
    await refused(
      create({ name: `Same code ${tag}`, code: code("staff").toLowerCase() }),
      409,
      new RegExp(`The discount "Staff 10% ${tag}" already uses the code`),
    );
    await refused(
      create({ name: `staff 10% ${tag}`, code: code("OTHER") }),
      409,
      new RegExp(`There is already a discount called "Staff 10% ${tag}"`),
    );
  });

  test("6. check 5: categories exist; a parent covers its sub-categories, so not both", async () => {
    await refused(
      create({ name: `Nowhere ${tag}`, code: code("C1"), scheme_codes: [c("nope")] }),
      404,
      new RegExp(`Unknown category: ${c("nope")}`),
    );
    await refused(
      create({ name: `Retired ${tag}`, code: code("C2"), scheme_codes: [c("old")] }),
      409,
      new RegExp(`Retired: P307 Old ${tag}`),
    );
    await refused(
      create({ name: `Both ${tag}`, code: code("C3"), scheme_codes: [c("cghs"), c("paid")] }),
      400,
      new RegExp(
        `P307 CGHS ${tag} already covers its sub-categories, so P307 CGHS ${tag} › CGHS Paid is already included`,
      ),
    );
    const parent = await create({
      name: `All CGHS ${tag}`,
      code: code("C4"),
      scheme_codes: [c("cghs"), "general"],
    });
    expect(parent.scheme_codes, "a parent and General are fine").toEqual([c("cghs"), "general"]);
    await refused(
      create({ name: `Bad code ${tag}`, code: code("C5"), scheme_codes: [42] }),
      400,
      /Categories must be a list of category codes/,
    );
  });

  test("7. deactivate, reactivate (re-checked), update and delete are audited", async () => {
    const rule = await create({
      name: `Short lived ${tag}`,
      code: code("SL"),
      service_item_ids: [ids.consult],
    });
    await svc.setDiscountRuleActive(rule.id, false, ctx, db);
    await query(`UPDATE service_items SET is_active = FALSE WHERE id = $1`, [ids.consult]);
    const edited = await svc.updateDiscountRule(rule.id, { value: 15 }, ctx, db);
    expect(edited.value, "an unchanged target isn't re-checked on edit").toBe(15);
    await refused(
      svc.setDiscountRuleActive(rule.id, true, ctx, db),
      409,
      /Deactivated item: P307 Consultant meet/,
      "turning it back on checks every target again",
    );
    await query(`UPDATE service_items SET is_active = TRUE WHERE id = $1`, [ids.consult]);
    expect((await svc.setDiscountRuleActive(rule.id, true, ctx, db)).is_active).toBe(true);
    await refused(svc.updateDiscountRule(rule.id, {}, ctx, db), 400, /Nothing to change/);
    await refused(svc.updateDiscountRule(987654, { value: 1 }, ctx, db), 404, /no longer exists/);
    expect(await svc.deleteDiscountRule(rule.id, ctx, db)).toEqual({ deleted: true, id: rule.id });
    expect(await auditFor(rule.id)).toEqual([
      "create",
      "deactivate",
      "update",
      "activate",
      "delete",
    ]);
    const active = await svc.listDiscountRules({ activeOnly: true }, db);
    expect(active.every((r) => r.is_active)).toBe(true);
    expect(active.some((r) => r.id === rule.id)).toBe(false);
  });

  test("8. review: a discount must take something off, and only a code has desk roles", async () => {
    await refused(
      create({ name: `Zero percent ${tag}`, code: code("Z1"), value: 0 }),
      400,
      /A 0% discount takes nothing off/,
    );
    await refused(
      create({ name: `Zero flat ${tag}`, code: code("Z2"), kind: "flat", value: 0 }),
      400,
      /A ₹0 discount takes nothing off/,
    );
    await refused(
      create({ name: `Zero cap ${tag}`, code: code("Z3"), value: 50, max_discount: 0 }),
      400,
      /A largest discount of ₹0 would take nothing off/,
    );
    const free = await create({
      name: `Free dressing ${tag}`,
      code: code("Z4"),
      kind: "fixed_price",
      value: 0,
    });
    expect(free.value, "a fixed price of ₹0 (free) is fine").toBe(0);
    await refused(
      svc.createDiscountRule(
        {
          name: `Auto with roles ${tag}`,
          method: "auto",
          kind: "percent",
          value: 5,
          allowed_roles: ["reception"],
        },
        ctx,
        db,
      ),
      400,
      /An automatic discount applies by itself, so no desk role enters it/,
    );
    const rule = await create({
      name: `Desk code ${tag}`,
      code: code("Z5"),
      allowed_roles: ["reception_admin"],
    });
    const auto = await svc.updateDiscountRule(rule.id, { method: "auto" }, ctx, db);
    expect([auto.code, auto.allowed_roles], "switching to automatic clears both").toEqual([
      null,
      null,
    ]);
  });
});
