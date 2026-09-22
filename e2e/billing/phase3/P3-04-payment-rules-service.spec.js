import crypto from "node:crypto";
import path from "node:path";
import { createRequire } from "node:module";
import { test, expect } from "@playwright/test";
import { getPool, query } from "../../helpers/db.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { repoRoot } from "../../setup/testEnv.mjs";
import { templateBuffer } from "../../../server/services/billing/importTemplate.js";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const svc = await import("../../../server/services/billing/paymentRules.js");
const rates = await import("../../../server/services/billing/categoryRates.js");
const schemes = await import("../../../server/services/patientSchemes.js");
const { commitUpload } = await import("../../../server/services/billing/importCommit.js");
const ExcelJS = createRequire(path.join(repoRoot, "server", "package.json"))("exceljs");

const db = getPool();
const ctx = { actorId: USERS.reception_admin.id, ip: "10.7.7.7" };
const tag = crypto.randomBytes(3).toString("hex");
const c = (name) => `${name}_${tag}`;
const failure = (promise) => promise.then(() => null).catch((e) => e);
const ids = {};

const refused = async (promise, status, message, label) => {
  const error = await failure(promise);
  expect(error?.status, label).toBe(status);
  if (message) expect(error.message, label).toMatch(message);
  return error;
};
const create = (extra) =>
  svc.createPaymentRule({ scheme_code: c("paid"), patient_pays: "full", ...extra }, ctx, db);
const auditFor = (id) =>
  query(
    `SELECT action FROM billing_audit WHERE entity = 'category_payment_rules' AND entity_id = $1 ORDER BY id`,
    [String(id)],
  ).then((r) => r.rows.map((row) => row.action));

test.describe.serial("P3-04 payment rules service", () => {
  test.beforeAll(async () => {
    await schemes.createScheme(
      { code: c("cghs"), label: `CGHS ${tag}`, payer_name: "CGHS Wellness Centre" },
      db,
      ctx,
    );
    await schemes.createScheme(
      { code: c("paid"), label: "CGHS Paid", parent_code: c("cghs") },
      db,
      ctx,
    );
    await schemes.createScheme({ code: c("corp"), label: `Corporate ${tag}` }, db, ctx);
    await schemes.createScheme({ code: c("retired"), label: `Retired ${tag}` }, db, ctx);
    await schemes.updateScheme(c("retired"), { is_active: false }, db, ctx);
    const group = await query(
      `INSERT INTO service_groups (code, name) VALUES ($1, $2) RETURNING id`,
      [`PG-${tag}`, `OPD ${tag}`],
    );
    ids.group = group.rows[0].id;
    const sub = await query(
      `INSERT INTO service_subgroups (group_id, code, name) VALUES ($1, $2, 'Consults') RETURNING id`,
      [ids.group, `PS-${tag}`],
    );
    ids.sub = sub.rows[0].id;
    const item = (code, name, price, active = true) =>
      query(
        `INSERT INTO service_items (code, name, subgroup_id, base_price, kind, is_active) VALUES ($1, $2, $3, $4, 'procedure', $5) RETURNING id`,
        [`${code}-${tag}`, name, ids.sub, price, active],
      ).then((r) => r.rows[0].id);
    ids.consult = await item("CONS", "Consultant meet", 1500);
    ids.dressing = await item("DRESS", "Dressing", 300);
    ids.review = await item("REV", "Review meet", 1500);
    ids.old = await item("OLD", "Old item", 50, false);
    ids.offItem = await item("OFFI", "Retired item", 900);
    await query(`UPDATE service_items SET is_active = FALSE WHERE id = $1`, [ids.offItem]);
  });

  test("1. create a rule: defaults, audit, and the list names its scope and category", async () => {
    const rule = await create({
      name: "Consultation ₹700",
      service_item_id: ids.consult,
      patient_pays: "amount",
      patient_value: "700",
      visit_types: ["Follow Up", "New", "New"],
    });
    expect(rule).toMatchObject({
      scheme_code: c("paid"),
      service_item_id: ids.consult,
      group_id: null,
      visit_types: ["New", "Follow Up"],
      patient_pays: "amount",
      patient_value: 700,
      remainder: "claim",
      valid_to: null,
      priority: 100,
      is_active: true,
    });
    expect(rule.valid_from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    ids.rule = rule.id;
    await svc.createPaymentRule(
      { scheme_code: c("cghs"), name: "CGHS default", patient_pays: "nothing" },
      ctx,
      db,
    );
    const list = await svc.listPaymentRules({ schemeCode: c("paid") }, db);
    expect(
      list.map((r) => [r.name, r.category_label, r.scope, r.scope_label, r.inherited]),
    ).toEqual([
      ["Consultation ₹700", `CGHS ${tag} › CGHS Paid`, "item", "Consultant meet", false],
      ["CGHS default", `CGHS ${tag}`, "category", null, true],
    ]);
    expect(await auditFor(rule.id)).toEqual(["create"]);
  });

  test("2. check 1: percent is 0–100, an amount is 0 or more, and the shape is sound", async () => {
    const bad = [
      ["percent over 100", { patient_pays: "percent", patient_value: 100.5 }, /0 to 100/],
      ["negative percent", { patient_pays: "percent", patient_value: -1 }, /0 to 100/],
      ["percent with 3 decimals", { patient_pays: "percent", patient_value: 12.345 }, /2 decimals/],
      ["percent without a value", { patient_pays: "percent" }, /Enter the percent/],
      ["negative amount", { patient_pays: "amount", patient_value: -5 }, /can't be negative/],
      ["amount without a value", { patient_pays: "amount" }, /Enter the amount/],
      ["amount as text", { patient_pays: "amount", patient_value: "7OO" }, /must be a number/],
      ["full with a value", { patient_value: 10 }, /takes no value/],
      ["unknown patient pays", { patient_pays: "half" }, /Patient pays must be one of/],
      ["unknown rest", { remainder: "waive" }, /The rest must go to/],
      [
        "two scopes",
        { group_id: ids.group, service_item_id: ids.consult },
        /one of a group, a subgroup or an item/,
      ],
      ["unknown visit type", { visit_types: ["Tele"] }, /Visit types must be from.*Tele/],
      ["a blank name", { name: "  " }, /Name can't be blank/],
      ["no category", { scheme_code: "" }, /Choose a category/],
      ["a bad priority", { priority: -1 }, /Priority/],
    ];
    for (const [why, extra, message] of bad) {
      await refused(create({ name: `Bad ${why}`, ...extra }), 400, message, why);
    }
    const zero = await create({ name: "Zero", patient_pays: "amount", patient_value: 0 });
    expect(zero.patient_value, "₹0 is a valid amount").toBe(0);
    const ok = await create({ name: "Pays 100%", patient_pays: "percent", patient_value: 100 });
    expect(ok.patient_value).toBe(100);
  });

  test("3. check 4: the To date can't be before the From date", async () => {
    await refused(
      create({ name: "Backwards", valid_from: "2026-10-10", valid_to: "2026-10-09" }),
      400,
      /To date can't be before the From date/,
    );
    await refused(
      create({ name: "Bad date", valid_from: "2026-02-30" }),
      400,
      /From date must be a date like/,
    );
    const oneDay = await create({
      name: "One day",
      valid_from: "2026-10-10",
      valid_to: "2026-10-10",
    });
    expect([oneDay.valid_from, oneDay.valid_to]).toEqual(["2026-10-10", "2026-10-10"]);
  });

  test("4. check 2: an amount above an item it covers is refused and the items are listed", async () => {
    const error = await refused(
      create({
        name: "Whole OPD ₹700",
        group_id: ids.group,
        patient_pays: "amount",
        patient_value: 700,
      }),
      409,
      /can't pay ₹700 for items that cost less: Dressing \(₹300\)\. Lower the amount/,
    );
    expect(
      error.items.map((i) => i.name),
      "deactivated items don't count",
    ).toEqual(["Dressing"]);
    await refused(
      create({
        name: "Sub ₹700",
        subgroup_id: ids.sub,
        patient_pays: "amount",
        patient_value: 700,
      }),
      409,
      /Dressing/,
    );
    const whole = await refused(
      create({ name: "All ₹700", patient_pays: "amount", patient_value: 700 }),
      409,
      /can't pay ₹700 for items that cost less/,
    );
    expect(
      whole.items.map((i) => i.id),
      "a whole-category amount rule covers every item",
    ).toContain(ids.dressing);
    const fits = await create({
      name: "Whole OPD ₹300",
      group_id: ids.group,
      patient_pays: "amount",
      patient_value: 300,
    });
    expect(fits.patient_value, "an amount equal to the cheapest price is fine").toBe(300);
  });

  test("5. check 2 uses the category's own rate, then its parent's, in the rule's dates", async () => {
    await rates.saveRate(
      { scheme_code: c("cghs"), service_item_id: ids.review, rate: 600, valid_from: "2026-10-01" },
      ctx,
      db,
    );
    const rule = {
      name: "Consult ₹650",
      service_item_id: ids.review,
      patient_pays: "amount",
      patient_value: 650,
      valid_from: "2026-10-01",
    };
    await refused(create(rule), 409, /Review meet \(₹600\)/, "the parent's rate applies");
    await refused(
      create({ ...rule, valid_from: "2026-11-01" }),
      409,
      /Review meet \(₹600\)/,
      "an open-ended parent rate still applies later",
    );
    const before = await create({
      ...rule,
      name: "Before the rate",
      valid_from: "2026-09-01",
      valid_to: "2026-09-30",
    });
    expect(before.valid_to, "the base price applies before the rate starts").toBe("2026-09-30");
    await rates.saveRate(
      {
        scheme_code: c("paid"),
        service_item_id: ids.review,
        rate: 1000,
        valid_from: "2026-10-01",
      },
      ctx,
      db,
    );
    const own = await create(rule);
    expect(own.patient_value, "the sub-category's own rate beats its parent's").toBe(650);
  });

  test("6. check 3: sending the rest to claim needs a payer name on the category or its parent", async () => {
    await refused(
      svc.createPaymentRule(
        { scheme_code: c("corp"), name: "Corp nothing", patient_pays: "nothing" },
        ctx,
        db,
      ),
      409,
      new RegExp(`Corporate ${tag} has no payer name.*or send the rest to adjustment`),
    );
    const adjustment = await svc.createPaymentRule(
      {
        scheme_code: c("corp"),
        name: "Corp nothing",
        patient_pays: "nothing",
        remainder: "adjustment",
      },
      ctx,
      db,
    );
    expect(adjustment.remainder).toBe("adjustment");
    const full = await svc.createPaymentRule(
      { scheme_code: c("corp"), name: "Corp full", patient_pays: "full" },
      ctx,
      db,
    );
    expect(full.remainder, "a full rule claims nothing, so needs no payer").toBe("claim");
    const inherited = await create({
      name: "Paid half",
      patient_pays: "percent",
      patient_value: 50,
    });
    expect(inherited.remainder, "the parent's payer name counts").toBe("claim");
  });

  test("7. the category, scope and name are checked", async () => {
    await refused(
      create({ name: "Nowhere", scheme_code: c("nope") }),
      404,
      /category doesn't exist/,
    );
    await refused(create({ name: "Old", scheme_code: c("retired") }), 409, /is retired/);
    await refused(create({ name: "Gone", group_id: 999999 }), 404, /group doesn't exist/);
    await refused(
      create({ name: "Off", service_item_id: ids.offItem }),
      409,
      /item Retired item is deactivated/,
    );
    await refused(
      create({ name: "consultation ₹700" }),
      409,
      /already has a payment rule called "Consultation ₹700"/,
    );
    const otherCategory = await svc.createPaymentRule(
      { scheme_code: c("cghs"), name: "Consultation ₹700", patient_pays: "full" },
      ctx,
      db,
    );
    expect(otherCategory.scheme_code, "the same name in another category is fine").toBe(c("cghs"));
  });

  test("8. update: checks run on the merged rule, switching to full clears the value", async () => {
    await refused(
      svc.updatePaymentRule(ids.rule, { patient_value: 1600 }, ctx, db),
      409,
      /Consultant meet \(₹1,500\)/,
    );
    await refused(
      svc.updatePaymentRule(ids.rule, { group_id: ids.group }, ctx, db),
      409,
      /Dressing \(₹300\)/,
      "widening the scope re-checks the prices",
    );
    await refused(svc.updatePaymentRule(ids.rule, {}, ctx, db), 400, /Nothing to change/);
    const renamed = await svc.updatePaymentRule(ids.rule, { name: "Consult ₹700" }, ctx, db);
    expect(renamed.name).toBe("Consult ₹700");
    const full = await svc.updatePaymentRule(ids.rule, { patient_pays: "full" }, ctx, db);
    expect(full).toMatchObject({ patient_pays: "full", patient_value: null });
    const widened = await svc.updatePaymentRule(ids.rule, { group_id: ids.group }, ctx, db);
    expect([widened.group_id, widened.service_item_id], "a new scope replaces the old one").toEqual(
      [ids.group, null],
    );
    await refused(svc.updatePaymentRule(987654, { name: "X" }, ctx, db), 404, /no longer exists/);
    expect(await auditFor(ids.rule)).toEqual(["create", "update", "update", "update"]);
  });

  test("9. deactivate, then reactivating re-checks the rule", async () => {
    await schemes.updateScheme(c("corp"), { payer_name: "Corp Ltd" }, db, ctx);
    const rule = await svc.createPaymentRule(
      { scheme_code: c("corp"), name: "Corp claim", patient_pays: "nothing" },
      ctx,
      db,
    );
    const off = await svc.setPaymentRuleActive(rule.id, false, ctx, db);
    expect(off.is_active).toBe(false);
    await schemes.updateScheme(c("corp"), { payer_name: null }, db, ctx);
    await refused(
      svc.setPaymentRuleActive(rule.id, true, ctx, db),
      409,
      /has no payer name/,
      "the payer was removed while it was off",
    );
    await schemes.updateScheme(c("corp"), { payer_name: "Corp Ltd" }, db, ctx);
    const on = await svc.setPaymentRuleActive(rule.id, true, ctx, db);
    expect(on.is_active).toBe(true);
    await refused(svc.setPaymentRuleActive(rule.id, "yes", ctx, db), 400, /true or false/);
    expect(await auditFor(rule.id)).toEqual(["create", "deactivate", "activate"]);
    const active = await svc.listPaymentRules({ schemeCode: c("corp"), activeOnly: true }, db);
    expect(active.every((r) => r.is_active)).toBe(true);
  });

  test("10. delete is audited", async () => {
    const rule = await create({ name: "Short lived" });
    expect(await svc.deletePaymentRule(rule.id, ctx, db)).toEqual({ deleted: true, id: rule.id });
    expect(await auditFor(rule.id)).toEqual(["create", "delete"]);
    await refused(svc.deletePaymentRule(rule.id, ctx, db), 404, /no longer exists/);
  });

  test("11. review: a parent's amount rule is checked against its sub-categories' rates", async () => {
    await schemes.createScheme(
      { code: c("echs"), label: `ECHS ${tag}`, payer_name: "ECHS Polyclinic" },
      db,
      ctx,
    );
    await schemes.createScheme(
      { code: c("veteran"), label: "Veteran", parent_code: c("echs") },
      db,
      ctx,
    );
    await schemes.createScheme(
      { code: c("oldvet"), label: "Old veteran", parent_code: c("echs") },
      db,
      ctx,
    );
    await rates.saveRate(
      {
        scheme_code: c("oldvet"),
        service_item_id: ids.consult,
        rate: 200,
        valid_from: "2026-01-01",
      },
      ctx,
      db,
    );
    await schemes.updateScheme(c("oldvet"), { is_active: false }, db, ctx);
    await rates.saveRate(
      {
        scheme_code: c("veteran"),
        service_item_id: ids.consult,
        rate: 500,
        valid_from: "2026-01-01",
      },
      ctx,
      db,
    );
    const rule = {
      scheme_code: c("echs"),
      name: "ECHS consult ₹700",
      service_item_id: ids.consult,
      patient_pays: "amount",
      patient_value: 700,
    };
    const error = await refused(
      svc.createPaymentRule(rule, ctx, db),
      409,
      /Consultant meet \(₹500 for Veteran\)/,
      "the rule also applies to Veteran patients",
    );
    expect(error.items, "a retired sub-category isn't billed, so its rate doesn't count").toEqual([
      expect.objectContaining({ name: "Consultant meet", price: 500, sub_category: "Veteran" }),
    ]);
    const fits = await svc.createPaymentRule({ ...rule, patient_value: 500 }, ctx, db);
    expect(fits.patient_value).toBe(500);
  });

  test("12. review: a payer name can't be removed while active claim rules need it", async () => {
    const error = await refused(
      schemes.updateScheme(c("cghs"), { payer_name: null }, db, ctx),
      409,
      /no payer name for 7 payment rules that send the rest to claim: "CGHS default" \(CGHS \w+\), "Before the rate"/,
      "the parent's own rule and its sub-categories' rules need it",
    );
    expect(error.rules.map((r) => r.name)).toContain("Paid half");
    expect(
      (await query(`SELECT payer_name FROM patient_schemes WHERE code = $1`, [c("cghs")])).rows[0]
        .payer_name,
      "nothing was changed",
    ).toBe("CGHS Wellness Centre");
    await schemes.createScheme({ code: c("nopayer"), label: `No payer ${tag}` }, db, ctx);
    await refused(
      schemes.updateScheme(c("paid"), { parent_code: c("nopayer") }, db, ctx),
      409,
      /send the rest to claim/,
      "moving a sub-category under a parent with no payer",
    );
    await schemes.updateScheme(c("paid"), { payer_name: "CGHS Paid desk" }, db, ctx);
    const moved = await schemes.updateScheme(c("paid"), { parent_code: c("nopayer") }, db, ctx);
    expect(moved.parent_code, "with its own payer name it can move").toBe(c("nopayer"));
    const renamed = await schemes.updateScheme(c("corp"), { payer_name: "Corp Pvt Ltd" }, db, ctx);
    expect(renamed.payer_name, "changing the payer name is fine").toBe("Corp Pvt Ltd");
  });

  test("13. review: the bulk import can't clear a payer name that claim rules need", async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await templateBuffer({ examples: false }));
    const ws = wb.getWorksheet("Categories");
    const headers = ws.getRow(1).values.slice(1);
    const row = { category_code: c("echs"), label: `ECHS ${tag}` };
    ws.addRow(headers.map((h) => row[h] ?? null));
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    await refused(
      commitUpload(buffer, { fileName: "p304.xlsx", ctx }, db),
      409,
      /no payer name for 1 payment rule that sends the rest to claim: "ECHS consult ₹700"/,
    );
    expect(
      (await query(`SELECT payer_name FROM patient_schemes WHERE code = $1`, [c("echs")])).rows[0]
        .payer_name,
      "the whole import was rolled back",
    ).toBe("ECHS Polyclinic");
  });
});
