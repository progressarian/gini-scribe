import crypto from "node:crypto";
import { test, expect } from "@playwright/test";
import { getPool, query } from "../../helpers/db.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const { priceLine } = await import("../../../server/services/billing/priceLine.js");
const rules = await import("../../../server/services/billing/paymentRules.js");
const discounts = await import("../../../server/services/billing/discountRules.js");
const schemes = await import("../../../server/services/patientSchemes.js");

const db = getPool();
const ctx = { actorId: USERS.reception_admin.id, ip: "10.12.12.12" };
const tag = crypto.randomBytes(3).toString("hex");
const T = tag.toUpperCase();
const c = (name) => `p312e_${name}_${tag}`;
const ids = {};
let client = null;
const DAY = "2026-10-15";
const BEST = { discount_stacking: "best_only", gst_enabled: false };
const PER_RULE = { discount_stacking: "per_rule", gst_enabled: false };
const GST = { discount_stacking: "best_only", gst_enabled: true };

const price = (item, extra = {}) =>
  priceLine({ item: ids[item], date: DAY, settings: BEST, role: "reception", ...extra }, client);
const money = (line) => ({
  actual: line.actual,
  discount: line.discount,
  tax: line.tax,
  patient: line.patient_payable,
  claim: line.claim,
  adjustment: line.adjustment,
});
const balances = (line) =>
  expect(line.actual - line.discount + line.tax, "actual − discount + tax").toBe(
    line.patient_payable + line.claim + line.adjustment,
  );

test.describe.serial("P3-12 line pricing end to end", () => {
  test.beforeAll(async () => {
    await schemes.createScheme(
      { code: c("cghs"), label: `P312E CGHS ${tag}`, payer_name: "CGHS Wellness Centre" },
      db,
      ctx,
    );
    for (const [key, label] of [
      ["paid", "CGHS Paid"],
      ["referral", "CGHS Referral"],
      ["pensioner", "Pensioner"],
    ]) {
      await schemes.createScheme({ code: c(key), label, parent_code: c("cghs") }, db, ctx);
    }
    const one = (sql, params) => query(sql, params).then((r) => r.rows[0].id);
    ids.opd = await one(`INSERT INTO service_groups (code, name) VALUES ($1, $1) RETURNING id`, [
      `P312E-OPD-${T}`,
    ]);
    ids.lab = await one(`INSERT INTO service_groups (code, name) VALUES ($1, $1) RETURNING id`, [
      `P312E-LAB-${T}`,
    ]);
    ids.consults = await one(
      `INSERT INTO service_subgroups (group_id, code, name) VALUES ($1, $2, $2) RETURNING id`,
      [ids.opd, `P312E-CONS-${T}`],
    );
    ids.tests = await one(
      `INSERT INTO service_subgroups (group_id, code, name) VALUES ($1, $2, $2) RETURNING id`,
      [ids.lab, `P312E-TESTS-${T}`],
    );
    ids.gst18 = await one(
      `INSERT INTO tax_codes (code, sac_hsn, rate_pct) VALUES ($1, '999312', 18) RETURNING id`,
      [`P312E-GST18-${T}`],
    );
    ids.gstOld = await one(
      `INSERT INTO tax_codes (code, sac_hsn, rate_pct) VALUES ($1, '999312', 12) RETURNING id`,
      [`P312E-GST12-${T}`],
    );
    ids.drA = await one(`INSERT INTO doctors (name) VALUES ($1) RETURNING id`, [
      `P312E Dr A ${tag}`,
    ]);
    ids.drB = await one(`INSERT INTO doctors (name) VALUES ($1) RETURNING id`, [
      `P312E Dr B ${tag}`,
    ]);
    const item = (code, subgroup, price, taxCode = null, extra = {}) =>
      one(
        `INSERT INTO service_items
           (code, name, subgroup_id, base_price, kind, tax_code_id, price_includes_tax,
            doctor_id, visit_type, allow_quantity)
         VALUES ($1, $1, $2, $3, $5, $4, $6, $7, $8, $9) RETURNING id`,
        [
          `${code}-${T}`,
          subgroup,
          price,
          taxCode,
          extra.kind ?? "procedure",
          extra.price_includes_tax ?? false,
          extra.doctor_id ?? null,
          extra.visit_type ?? null,
          extra.allow_quantity ?? false,
        ],
      );
    ids.newVisit = await item("P312E-NEW", ids.consults, 1500);
    ids.followUp = await item("P312E-FU", ids.consults, 1000);
    ids.hba1c = await item("P312E-HBA1C", ids.tests, 250);
    ids.taxed = await item("P312E-TAXED", ids.consults, 1000, ids.gst18);
    ids.inclusive = await item("P312E-INCL", ids.consults, 1180, ids.gst18, {
      price_includes_tax: true,
    });
    ids.drANew = await item("P312E-DRA-NEW", ids.consults, 1500, null, {
      kind: "consultation",
      doctor_id: ids.drA,
      visit_type: "New",
    });
    ids.huge = await item("P312E-HUGE", ids.tests, 9999999999.99, ids.gst18);
    ids.dressing = await item("P312E-DRESS", ids.consults, 800, null, { allow_quantity: true });
    ids.oldTax = await item("P312E-OLDTAX", ids.tests, 100, ids.gstOld);
    const rule = (scheme, extra) =>
      rules.createPaymentRule(
        { scheme_code: c(scheme), valid_from: "2026-01-01", subgroup_id: ids.consults, ...extra },
        ctx,
        db,
      );
    await rule("paid", {
      name: "Paid consults ₹700",
      patient_pays: "amount",
      patient_value: 700,
      visit_types: ["New", "Follow Up"],
    });
    await rule("referral", { name: "Referral pays nothing", patient_pays: "nothing" });
    await rule("pensioner", { name: "Pensioner pays nothing", patient_pays: "nothing" });
    await rule("paid", {
      name: "Paid Dr A follow-ups pay nothing",
      subgroup_id: null,
      service_item_id: ids.drANew,
      patient_pays: "nothing",
      visit_types: ["Follow Up"],
    });
    await rules.createPaymentRule(
      {
        scheme_code: c("cghs"),
        valid_from: "2026-01-01",
        group_id: ids.lab,
        name: "CGHS lab pays 20%",
        patient_pays: "percent",
        patient_value: 20,
      },
      ctx,
      db,
    );
    await discounts.createDiscountRule(
      {
        name: `Age 70+ OPD 10% ${tag}`,
        method: "auto",
        kind: "percent",
        value: 10,
        group_ids: [ids.opd],
        min_age: 70,
        stackable: true,
        valid_from: "2026-01-01",
      },
      ctx,
      db,
    );
    await discounts.createDiscountRule(
      {
        name: `CC50 ${tag}`,
        code: `CC50${T}`,
        method: "code",
        kind: "percent",
        value: 50,
        group_ids: [ids.opd],
        valid_from: "2026-01-01",
      },
      ctx,
      db,
    );
    await discounts.createDiscountRule(
      {
        name: `Bill 100 off ${tag}`,
        code: `BILL100${T}`,
        method: "code",
        kind: "flat",
        value: 100,
        applies_per: "bill",
        valid_from: "2026-01-01",
      },
      ctx,
      db,
    );
    ids.free = await item("P312E-FREE", ids.consults, 0);
  });

  test.afterAll(async () => {
    await query(
      `UPDATE discount_rules SET is_active = FALSE WHERE method = 'auto' AND name LIKE $1`,
      [`% ${tag}`],
    );
  });

  test.beforeEach(async () => {
    client = await db.connect();
    await client.query("BEGIN");
    await client.query(
      `UPDATE discount_rules SET is_active = FALSE WHERE method = 'auto' AND name NOT LIKE $1`,
      [`% ${tag}`],
    );
  });
  test.afterEach(async () => {
    await client.query("ROLLBACK");
    client.release();
  });

  test("1. the plan's CGHS table: what the patient pays and what is claimed", async () => {
    const cases = [
      ["paid", "newVisit", "New", { actual: 150000, patient: 70000, claim: 80000 }],
      ["paid", "followUp", "Follow Up", { actual: 100000, patient: 70000, claim: 30000 }],
      ["referral", "newVisit", "New", { actual: 150000, patient: 0, claim: 150000 }],
      ["referral", "followUp", "Follow Up", { actual: 100000, patient: 0, claim: 100000 }],
      ["pensioner", "followUp", "Follow Up", { actual: 100000, patient: 0, claim: 100000 }],
    ];
    for (const [category, item, visitType, expected] of cases) {
      const line = await price(item, { category: c(category), visitType });
      expect(money(line), `${category} ${visitType}`).toEqual({
        discount: 0,
        tax: 0,
        adjustment: 0,
        ...expected,
      });
      expect(line.payment_rule_id, `${category} ${visitType}`).not.toBeNull();
      balances(line);
    }
    const paid = await price("newVisit", { category: c("paid"), visitType: "New" });
    expect([paid.payment_rule_text, paid.payment_rule_name, paid.remainder]).toEqual([
      "amount ₹700",
      "Paid consults ₹700",
      "claim",
    ]);
    const general = await price("newVisit", { visitType: "New" });
    expect(money(general), "General pays in full").toEqual({
      actual: 150000,
      discount: 0,
      tax: 0,
      patient: 150000,
      claim: 0,
      adjustment: 0,
    });
  });

  test("2. the plan's discount example: CC50 −500 beats the age discount −100 (best only)", async () => {
    const patient = { id: null, age: 72, gender: "Male" };
    const consult = await price("followUp", {
      visitType: "Follow Up",
      patient,
      codes: [`cc50${T.toLowerCase()}`],
    });
    expect(money(consult)).toEqual({
      actual: 100000,
      discount: 50000,
      tax: 0,
      patient: 50000,
      claim: 0,
      adjustment: 0,
    });
    expect(consult.discounts.map((d) => [d.name, d.amount])).toEqual([[`CC50 ${tag}`, 50000]]);
    const hba1c = await price("hba1c", { patient, codes: [] });
    expect(hba1c.patient_payable, "the lab test isn't in the OPD group").toBe(25000);
    const younger = await price("followUp", { visitType: "Follow Up", patient: { age: 60 } });
    expect(younger.discount, "the age rule needs 70+").toBe(0);
  });

  test("3. per rule: the code first, then the stackable age discount on what is left", async () => {
    const line = await price("followUp", {
      visitType: "Follow Up",
      patient: { age: 72 },
      codes: [`CC50${T}`],
      settings: PER_RULE,
    });
    expect(line.discounts.map((d) => d.amount)).toEqual([50000, 5000]);
    expect([line.discount, line.patient_payable]).toEqual([55000, 45000]);
    balances(line);
  });

  test("4. codes: refused ones are reported and the line is still priced", async () => {
    const line = await price("followUp", { visitType: "Follow Up", codes: ["NOPE", "nope "] });
    expect(line.refused_codes).toEqual([
      expect.objectContaining({ code: "NOPE", reason: "unknown" }),
    ]);
    expect(line.patient_payable).toBe(100000);
    const ruled = await price("followUp", {
      category: c("paid"),
      visitType: "Follow Up",
      codes: [`CC50${T}`],
    });
    expect(ruled.refused_codes).toEqual([expect.objectContaining({ reason: "payment_rule" })]);
    expect(
      [ruled.discount, ruled.patient_payable],
      "a code without applies_on_scheme_rate takes nothing off a payment-rule line (P3-13)",
    ).toEqual([0, 70000]);
  });

  test("5. GST on: 9% + 9%, and the payment rule splits the tax-inclusive total", async () => {
    const general = await price("taxed", { settings: GST });
    expect([general.taxable, general.cgst, general.sgst, general.tax, general.total]).toEqual([
      100000, 9000, 9000, 18000, 118000,
    ]);
    expect(general.patient_payable).toBe(118000);
    balances(general);
    const paid = await price("taxed", { category: c("paid"), visitType: "New", settings: GST });
    expect([paid.patient_payable, paid.claim]).toEqual([70000, 48000]);
    balances(paid);
    const off = await price("taxed");
    expect([off.tax, off.tax_code_id, off.patient_payable], "GST off").toEqual([0, null, 100000]);
  });

  test("6. tax inside the price: actual and discount leave it out, so the line balances", async () => {
    const whole = await price("inclusive", { settings: GST });
    expect(money(whole)).toEqual({
      actual: 100000,
      discount: 0,
      tax: 18000,
      patient: 118000,
      claim: 0,
      adjustment: 0,
    });
    expect([whole.listed_actual, whole.listed_discount, whole.taxable, whole.total]).toEqual([
      118000, 0, 100000, 118000,
    ]);
    balances(whole);
    const halved = await price("inclusive", { settings: GST, codes: [`CC50${T}`] });
    expect(money(halved)).toEqual({
      actual: 100000,
      discount: 50000,
      tax: 9000,
      patient: 59000,
      claim: 0,
      adjustment: 0,
    });
    expect([halved.listed_discount, halved.discounts.map((d) => d.amount)]).toEqual([
      59000,
      [59000],
    ]);
    balances(halved);
    const odd = await price("inclusive", { settings: GST, patient: { age: 71 } });
    expect([odd.listed_discount, odd.taxable + odd.tax]).toEqual([11800, 106200]);
    balances(odd);
    const ruled = await price("inclusive", {
      category: c("paid"),
      visitType: "New",
      settings: GST,
    });
    expect([ruled.actual, ruled.tax, ruled.patient_payable, ruled.claim]).toEqual([
      100000, 18000, 70000, 48000,
    ]);
    balances(ruled);
    const off = await price("inclusive");
    expect([off.actual, off.listed_actual, off.tax, off.patient_payable], "GST off").toEqual([
      118000, 118000, 0, 118000,
    ]);
    const outside = await price("taxed", { settings: GST, codes: [`CC50${T}`] });
    expect([
      outside.actual,
      outside.listed_actual,
      outside.discount,
      outside.listed_discount,
    ]).toEqual([100000, 100000, 50000, 50000]);
    balances(outside);
  });

  test("7. a consultation item's own visit type and doctor win over the visit's", async () => {
    const line = await price("drANew", {
      category: c("paid"),
      visitType: "Follow Up",
      doctorId: ids.drB,
    });
    expect([line.visit_type, line.doctor_id, line.patient_payable, line.payment_rule_name]).toEqual(
      ["New", ids.drA, 70000, "Paid consults ₹700"],
    );
    const other = await price("followUp", { visitType: "Follow Up", doctorId: String(ids.drB) });
    expect([other.visit_type, other.doctor_id], "an item with neither takes the visit's").toEqual([
      "Follow Up",
      ids.drB,
    ]);
    const bad = async (input, status, message) => {
      const error = await price("followUp", input).catch((e) => e);
      expect([error?.status, error?.message], JSON.stringify(input)).toEqual([
        status,
        expect.stringMatching(message),
      ]);
    };
    await bad({ doctorId: 987654321 }, 404, /^That doctor doesn't exist$/);
    await bad({ doctorId: "x" }, 400, /^Doctor must be a whole number/);
    await bad({ doctorId: 0 }, 400, /^Doctor must be a whole number/);
    for (const visitType of ["new", "OPD", ""]) {
      await bad({ visitType }, 400, /^Visit type must be one of/);
      const error = await price("drANew", { visitType }).catch((e) => e);
      expect(error?.status, `${visitType} on an item with its own visit type`).toBe(400);
    }
  });

  test("8. codes: only accepted codes count towards the bill's limit", async () => {
    await client.query(`UPDATE billing_settings SET max_codes_per_bill = 1`);
    const line = await price("followUp", { codes: ["NOPE", `CC50${T}`] });
    expect([line.discount, line.refused_codes.map((r) => r.reason)]).toEqual([50000, ["unknown"]]);
    const full = await price("followUp", { codes: [`CC50${T}`], codesOnBill: 1 });
    expect(full.refused_codes.map((r) => r.reason)).toEqual(["too_many_codes"]);
    await client.query(`UPDATE billing_settings SET max_codes_per_bill = 3`);
    const text = await price("followUp", { codes: [`CC50${T}`], codesOnBill: "1" });
    expect([text.discount, text.refused_codes], "codesOnBill as text is a number").toEqual([
      50000,
      [],
    ]);
    for (const codesOnBill of ["x", -1, 1.5]) {
      const error = await price("followUp", { codes: [`CC50${T}`], codesOnBill }).catch((e) => e);
      expect(error?.status, String(codesOnBill)).toBe(400);
    }
    for (const codes of ["CC50", [1], [null]]) {
      const error = await price("followUp", { codes }).catch((e) => e);
      expect([error?.status, error?.message], JSON.stringify(codes)).toEqual([
        400,
        "Discount codes must be a list of codes",
      ]);
    }
  });

  test("9. everything a saved line snapshots is on the result", async () => {
    const line = await price("followUp", {
      visitType: "Follow Up",
      patient: { age: 72 },
      codes: [`CC50${T}`],
      settings: PER_RULE,
    });
    expect(line).toMatchObject({
      item_id: ids.followUp,
      item_code: `P312E-FU-${T}`,
      group_code: `P312E-OPD-${T}`,
      subgroup_code: `P312E-CONS-${T}`,
      bill_name: `P312E-FU-${T}`,
      bill_code: null,
      quantity: 1,
      base_price: 100000,
      rate: 100000,
      tax_code: null,
      sac_hsn: null,
      tax_rate: 0,
      taxable: 45000,
      cgst: 0,
      sgst: 0,
      payment_rule_id: null,
      payment_rule_text: "full",
    });
    expect(line.discounts.map((d) => [d.method, d.code, d.amount])).toEqual([
      ["code", `CC50${T}`, 50000],
      ["auto", null, 5000],
    ]);
    const taxed = await price("taxed", { settings: GST });
    expect([taxed.tax_code, taxed.sac_hsn, taxed.tax_rate]).toEqual([
      `P312E-GST18-${T}`,
      "999312",
      18,
    ]);
  });

  test("10. a free item balances, and a total too large to save is refused", async () => {
    const free = await price("free", {
      category: c("paid"),
      visitType: "New",
      codes: [`CC50${T}`],
    });
    expect(money(free)).toEqual({
      actual: 0,
      discount: 0,
      tax: 0,
      patient: 0,
      claim: 0,
      adjustment: 0,
    });
    expect(free.capped, "₹700 on a ₹0 line is capped at ₹0").toBe(true);
    balances(free);
    const plain = await price("free", { codes: [`CC50${T}`] });
    expect([plain.patient_payable, plain.discounts]).toEqual([0, []]);
    expect((await price("huge")).total, "GST off: the price fits").toBe(999999999999);
    const error = await price("huge", { settings: GST }).catch((e) => e);
    expect([error?.status, error?.message]).toEqual([
      400,
      expect.stringMatching(/too large for one/),
    ]);
  });

  test("11. a switched-off tax code is refused while GST is on", async () => {
    await client.query(`UPDATE tax_codes SET is_active = FALSE WHERE id = $1`, [ids.gstOld]);
    const off = await price("oldTax");
    expect([off.tax, off.patient_payable], "GST off: no tax is worked out").toEqual([0, 10000]);
    const error = await price("oldTax", { settings: GST }).catch((e) => e);
    expect([error?.status, error?.message]).toEqual([
      409,
      `Tax code P312E-GST12-${T} is deactivated`,
    ]);
  });

  test("12. an amount rule is per unit, and the line says where its rule came from", async () => {
    const line = await price("dressing", { category: c("paid"), visitType: "New", quantity: 3 });
    expect(money(line)).toEqual({
      actual: 240000,
      discount: 0,
      tax: 0,
      patient: 210000,
      claim: 30000,
      adjustment: 0,
    });
    expect([line.payment_rule_scope, line.payment_rule_from_parent]).toEqual(["subgroup", false]);
    balances(line);
    const lab = await price("hba1c", { category: c("pensioner") });
    expect([
      lab.patient_payable,
      lab.claim,
      lab.payment_rule_name,
      lab.payment_rule_scope,
      lab.payment_rule_from_parent,
    ]).toEqual([5000, 20000, "CGHS lab pays 20%", "group", true]);
    balances(lab);
    const general = await price("dressing", { quantity: 3 });
    expect([
      general.patient_payable,
      general.payment_rule_scope,
      general.payment_rule_from_parent,
    ]).toEqual([240000, null, false]);
  });

  test("13. a bill-level code entered on a line is reported, not dropped", async () => {
    const line = await price("followUp", { codes: [`bill100${T.toLowerCase()}`, `CC50${T}`] });
    expect([line.discount, line.refused_codes]).toEqual([
      50000,
      [
        {
          code: `bill100${T.toLowerCase()}`,
          reason: "bill_level",
          message: `The code BILL100${T} applies to the whole bill, not to one line`,
        },
      ],
    ]);
    balances(line);
  });
});
