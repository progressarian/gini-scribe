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
const ctx = { actorId: USERS.reception_admin.id, ip: "10.13.13.13" };
const tag = crypto.randomBytes(3).toString("hex");
const T = tag.toUpperCase();
const c = (name) => `p313_${name}_${tag}`;
const ids = {};
let client = null;
const DAY = "2026-10-15";
const BEST = { discount_stacking: "best_only", gst_enabled: false };
const PER_RULE = { discount_stacking: "per_rule", gst_enabled: false };
const GST = { discount_stacking: "best_only", gst_enabled: true };

const price = (item, extra = {}) =>
  priceLine({ item: ids[item], date: DAY, settings: BEST, role: "reception", ...extra }, client);
const paid = (item, extra = {}) =>
  price(item, { category: c("paid"), visitType: "Follow Up", ...extra });
const money = (line) => ({
  actual: line.actual,
  discount: line.discount,
  payable_discount: line.payable_discount,
  tax: line.tax,
  patient: line.patient_payable,
  claim: line.claim,
  adjustment: line.adjustment,
});
const balances = (line) =>
  expect(line.actual - line.discount + line.tax, "actual − discount + tax").toBe(
    line.patient_payable + line.claim + line.adjustment,
  );
const steps = (line) => line.discounts.map((d) => [d.name, d.method, d.taken_from, d.amount]);
const ruleMessage = (code) =>
  `The code ${code} doesn't apply here: this line is under the payment rule "Paid consults ₹700", and the code only applies to lines where the patient pays in full`;

test.describe.serial("P3-13 line pricing: discounts on payment-rule lines", () => {
  test.beforeAll(async () => {
    await schemes.createScheme(
      { code: c("cghs"), label: `P313 CGHS ${tag}`, payer_name: "CGHS Wellness Centre" },
      db,
      ctx,
    );
    for (const [key, label] of [
      ["paid", "CGHS Paid"],
      ["pensioner", "Pensioner"],
    ]) {
      await schemes.createScheme({ code: c(key), label, parent_code: c("cghs") }, db, ctx);
    }
    const one = (sql, params) => query(sql, params).then((r) => r.rows[0].id);
    ids.opd = await one(`INSERT INTO service_groups (code, name) VALUES ($1, $1) RETURNING id`, [
      `P313-OPD-${T}`,
    ]);
    ids.lab = await one(`INSERT INTO service_groups (code, name) VALUES ($1, $1) RETURNING id`, [
      `P313-LAB-${T}`,
    ]);
    ids.consults = await one(
      `INSERT INTO service_subgroups (group_id, code, name) VALUES ($1, $2, $2) RETURNING id`,
      [ids.opd, `P313-CONS-${T}`],
    );
    ids.tests = await one(
      `INSERT INTO service_subgroups (group_id, code, name) VALUES ($1, $2, $2) RETURNING id`,
      [ids.lab, `P313-TESTS-${T}`],
    );
    ids.gst18 = await one(
      `INSERT INTO tax_codes (code, sac_hsn, rate_pct) VALUES ($1, '999312', 18) RETURNING id`,
      [`P313-GST18-${T}`],
    );
    const item = (code, subgroup, amount, extra = {}) =>
      one(
        `INSERT INTO service_items
           (code, name, subgroup_id, base_price, kind, tax_code_id, price_includes_tax,
            allow_quantity)
         VALUES ($1, $1, $2, $3, 'procedure', $4, $5, $6) RETURNING id`,
        [
          `${code}-${T}`,
          subgroup,
          amount,
          extra.tax ?? null,
          extra.inclusive ?? false,
          extra.allow_quantity ?? false,
        ],
      );
    ids.followUp = await item("P313-FU", ids.consults, 1000);
    ids.taxed = await item("P313-TAXED", ids.consults, 1000, { tax: ids.gst18 });
    ids.inclusive = await item("P313-INCL", ids.consults, 1180, {
      tax: ids.gst18,
      inclusive: true,
    });
    ids.dressing = await item("P313-DRESS", ids.consults, 800, { allow_quantity: true });
    ids.hba1c = await item("P313-HBA1C", ids.tests, 250);
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
    await rule("pensioner", { name: "Pensioner pays nothing", patient_pays: "nothing" });
    await rule("cghs", {
      name: "CGHS lab pays 20%, rest written off",
      subgroup_id: null,
      group_id: ids.lab,
      patient_pays: "percent",
      patient_value: 20,
      remainder: "adjustment",
    });
    ids.cheap = await item("P313-CHEAP", ids.consults, 500);
    const discount = (input) =>
      discounts
        .createDiscountRule({ valid_from: "2026-01-01", ...input }, ctx, db)
        .then((r) => r.id);
    const everywhere = { group_ids: [ids.opd, ids.lab] };
    ids.cc10 = await discount({
      name: `CC10 ${tag}`,
      code: `CC10${T}`,
      method: "code",
      kind: "percent",
      value: 10,
      ...everywhere,
    });
    await discount({
      name: `SR50 ${tag}`,
      code: `SR50${T}`,
      method: "code",
      kind: "percent",
      value: 50,
      applies_on_scheme_rate: true,
      ...everywhere,
    });
    await discount({
      name: `Age 70+ 10% ${tag}`,
      method: "auto",
      kind: "percent",
      value: 10,
      min_age: 70,
      stackable: true,
      applies_on_scheme_rate: true,
      group_ids: [ids.opd],
    });
    await discount({
      name: `Age 70+ lab 20% ${tag}`,
      method: "auto",
      kind: "percent",
      value: 20,
      min_age: 70,
      group_ids: [ids.lab],
    });
    await discount({
      name: `FLAT100 ${tag}`,
      code: `FLAT100${T}`,
      method: "code",
      kind: "flat",
      value: 100,
      stackable: true,
      applies_on_scheme_rate: true,
      ...everywhere,
    });
    await discount({
      name: `BIG ${tag}`,
      code: `BIG${T}`,
      method: "code",
      kind: "flat",
      value: 5000,
      applies_on_scheme_rate: true,
      ...everywhere,
    });
    await discount({
      name: `FIX200 ${tag}`,
      code: `FIX200${T}`,
      method: "code",
      kind: "fixed_price",
      value: 200,
      applies_on_scheme_rate: true,
      ...everywhere,
    });
    await discount({
      name: `BILL ${tag}`,
      code: `BILL${T}`,
      method: "code",
      kind: "flat",
      value: 100,
      applies_per: "bill",
      applies_on_scheme_rate: true,
    });
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

  test("1. the switch: off changes nothing, on takes the discount off the patient payable", async () => {
    const plain = await paid("followUp");
    const off = await paid("followUp", { codes: [`cc10${T.toLowerCase()}`] });
    expect(money(off)).toEqual(money(plain));
    expect(money(off)).toEqual({
      actual: 100000,
      discount: 0,
      payable_discount: 0,
      tax: 0,
      patient: 70000,
      claim: 30000,
      adjustment: 0,
    });
    expect([off.discounts, off.refused_codes]).toEqual([
      [],
      [
        {
          code: `cc10${T.toLowerCase()}`,
          reason: "payment_rule",
          message: ruleMessage(`CC10${T}`),
        },
      ],
    ]);
    await client.query(`UPDATE discount_rules SET applies_on_scheme_rate = TRUE WHERE id = $1`, [
      ids.cc10,
    ]);
    const on = await paid("followUp", { codes: [`CC10${T}`] });
    expect(money(on)).toEqual({
      actual: 100000,
      discount: 7000,
      payable_discount: 7000,
      tax: 0,
      patient: 63000,
      claim: 30000,
      adjustment: 0,
    });
    expect([on.listed_discount, on.refused_codes, steps(on)]).toEqual([
      7000,
      [],
      [[`CC10 ${tag}`, "code", "patient_payable", 7000]],
    ]);
    expect([on.payment_rule_text, on.remainder, on.capped]).toEqual([
      "amount ₹700",
      "claim",
      false,
    ]);
    balances(on);
  });

  test("2. full-pay lines are unchanged: the discount comes off the actual amount", async () => {
    const line = await price("followUp", { codes: [`SR50${T}`] });
    expect(money(line)).toEqual({
      actual: 100000,
      discount: 50000,
      payable_discount: 0,
      tax: 0,
      patient: 50000,
      claim: 0,
      adjustment: 0,
    });
    expect(steps(line)).toEqual([[`SR50 ${tag}`, "code", "actual", 50000]]);
    const cc10 = await price("followUp", { codes: [`CC10${T}`] });
    expect([cc10.discount, cc10.refused_codes], "a code without the switch").toEqual([10000, []]);
    const lab = await price("hba1c", { patient: { age: 72 } });
    expect(steps(lab), "an automatic rule without the switch").toEqual([
      [`Age 70+ lab 20% ${tag}`, "auto", "actual", 5000],
    ]);
    const aged = await price("followUp", { patient: { age: 72 } });
    expect(
      [steps(aged), aged.payable_discount, aged.patient_payable],
      "an automatic rule with the switch is an ordinary step-4 discount on a full-pay line",
    ).toEqual([[[`Age 70+ 10% ${tag}`, "auto", "actual", 10000]], 0, 90000]);
  });

  test("3. automatic rules: only those with the switch apply under a payment rule", async () => {
    const consult = await paid("followUp", { patient: { age: 72 } });
    expect(money(consult)).toMatchObject({ patient: 63000, claim: 30000, payable_discount: 7000 });
    expect(steps(consult)).toEqual([[`Age 70+ 10% ${tag}`, "auto", "patient_payable", 7000]]);
    const lab = await price("hba1c", { category: c("paid"), patient: { age: 72 } });
    expect(money(lab), "the lab rule has no switch").toEqual({
      actual: 25000,
      discount: 0,
      payable_discount: 0,
      tax: 0,
      patient: 5000,
      claim: 0,
      adjustment: 20000,
    });
    expect(lab.discounts).toEqual([]);
  });

  test("4. stacking: best only takes the largest, per rule stacks on what the patient pays", async () => {
    const input = { patient: { age: 72 }, codes: [`SR50${T}`, `FLAT100${T}`] };
    const best = await paid("followUp", input);
    expect(money(best)).toMatchObject({ discount: 35000, patient: 35000, claim: 30000 });
    expect(steps(best)).toEqual([[`SR50 ${tag}`, "code", "patient_payable", 35000]]);
    balances(best);
    const stacked = await paid("followUp", { ...input, settings: PER_RULE });
    expect(steps(stacked)).toEqual([
      [`SR50 ${tag}`, "code", "patient_payable", 35000],
      [`Age 70+ 10% ${tag}`, "auto", "patient_payable", 3500],
      [`FLAT100 ${tag}`, "code", "patient_payable", 10000],
    ]);
    expect(money(stacked)).toEqual({
      actual: 100000,
      discount: 48500,
      payable_discount: 48500,
      tax: 0,
      patient: 21500,
      claim: 30000,
      adjustment: 0,
    });
    balances(stacked);
  });

  test("5. never below ₹0; a fixed price sets what the patient pays; the claim never moves", async () => {
    const big = await paid("followUp", { codes: [`BIG${T}`] });
    expect(money(big)).toMatchObject({ discount: 70000, patient: 0, claim: 30000 });
    balances(big);
    const fixed = await paid("followUp", { codes: [`FIX200${T}`] });
    expect(money(fixed)).toMatchObject({ discount: 50000, patient: 20000, claim: 30000 });
    const three = await paid("dressing", { quantity: 3, codes: [`FIX200${T}`] });
    expect(money(three), "₹700 × 3 down to ₹200 × 3").toMatchObject({
      actual: 240000,
      discount: 150000,
      patient: 60000,
      claim: 30000,
    });
    balances(three);
  });

  test("6. a capped line and a 'nothing' line", async () => {
    const capped = await paid("cheap", { codes: [`FLAT100${T}`] });
    expect(money(capped)).toEqual({
      actual: 50000,
      discount: 10000,
      payable_discount: 10000,
      tax: 0,
      patient: 40000,
      claim: 0,
      adjustment: 0,
    });
    expect([capped.capped, capped.payment_rule_text]).toEqual([
      true,
      "amount ₹700 (capped at ₹500)",
    ]);
    balances(capped);
    const nothing = await price("followUp", {
      category: c("pensioner"),
      patient: { age: 72 },
      codes: [`SR50${T}`, `CC10${T}`],
    });
    expect(money(nothing)).toEqual({
      actual: 100000,
      discount: 0,
      payable_discount: 0,
      tax: 0,
      patient: 0,
      claim: 100000,
      adjustment: 0,
    });
    expect([nothing.discounts, nothing.refused_codes.map((r) => [r.code, r.reason])]).toEqual([
      [],
      [[`CC10${T}`, "payment_rule"]],
    ]);
    balances(nothing);
  });

  test("7. GST: tax is worked out before step 8, on the undiscounted net", async () => {
    const taxed = await paid("taxed", { settings: GST, codes: [`SR50${T}`] });
    expect(money(taxed)).toEqual({
      actual: 100000,
      discount: 35000,
      payable_discount: 35000,
      tax: 18000,
      patient: 35000,
      claim: 48000,
      adjustment: 0,
    });
    expect([taxed.taxable, taxed.cgst, taxed.sgst, taxed.total]).toEqual([
      100000, 9000, 9000, 118000,
    ]);
    balances(taxed);
    const inclusive = await paid("inclusive", { settings: GST, codes: [`SR50${T}`] });
    expect(money(inclusive)).toEqual({
      actual: 100000,
      discount: 35000,
      payable_discount: 35000,
      tax: 18000,
      patient: 35000,
      claim: 48000,
      adjustment: 0,
    });
    expect([inclusive.listed_actual, inclusive.listed_discount]).toEqual([118000, 35000]);
    balances(inclusive);
    const all = await price("taxed", {
      category: c("pensioner"),
      settings: GST,
      codes: [`BIG${T}`],
    });
    expect([all.patient_payable, all.claim, all.discount]).toEqual([0, 118000, 0]);
  });

  test("8. a percent rule with the rest written off: the adjustment is unchanged", async () => {
    const lab = await price("hba1c", { category: c("pensioner"), codes: [`SR50${T}`] });
    expect(money(lab)).toEqual({
      actual: 25000,
      discount: 2500,
      payable_discount: 2500,
      tax: 0,
      patient: 2500,
      claim: 0,
      adjustment: 20000,
    });
    expect([lab.payment_rule_from_parent, lab.remainder]).toEqual([true, "adjustment"]);
    balances(lab);
  });

  test("9. refusals: each code keeps its own reason; only accepted codes count", async () => {
    const line = await paid("followUp", { codes: [`CC10${T}`, "NOPE", `BILL${T}`, `SR50${T}`] });
    expect(line.refused_codes).toEqual([
      { code: `CC10${T}`, reason: "payment_rule", message: ruleMessage(`CC10${T}`) },
      expect.objectContaining({ code: "NOPE", reason: "unknown" }),
      expect.objectContaining({ code: `BILL${T}`, reason: "bill_level" }),
    ]);
    expect(line.patient_payable).toBe(35000);
    await client.query(`UPDATE billing_settings SET max_codes_per_bill = 1`);
    const limited = await paid("followUp", { codes: [`CC10${T}`, `SR50${T}`, `FLAT100${T}`] });
    expect([limited.patient_payable, limited.refused_codes.map((r) => [r.code, r.reason])]).toEqual(
      [
        35000,
        [
          [`CC10${T}`, "payment_rule"],
          [`FLAT100${T}`, "too_many_codes"],
        ],
      ],
    );
  });

  test("10. a one-paisa discount on a price that includes tax still prices", async () => {
    const { rows } = await client.query(
      `INSERT INTO service_items
         (code, name, subgroup_id, base_price, kind, tax_code_id, price_includes_tax)
       VALUES ($1, $1, $2, 20, 'procedure', $3, TRUE) RETURNING id`,
      [`P313-TWENTY-${T}`, ids.consults, ids.gst18],
    );
    ids.twenty = rows[0].id;
    await discounts.createDiscountRule(
      {
        name: `PAISA ${tag}`,
        code: `PAISA${T}`,
        method: "code",
        kind: "flat",
        value: 0.01,
        valid_from: "2026-01-01",
        group_ids: [ids.opd],
      },
      ctx,
      client,
    );
    const whole = await price("twenty", { settings: GST });
    const line = await price("twenty", { settings: GST, codes: [`PAISA${T}`] });
    expect([whole.taxable, whole.tax, whole.total], "₹20 with the tax inside").toEqual([
      1694, 306, 2000,
    ]);
    expect(
      [line.listed_discount, line.taxable, line.tax, line.total, line.patient_payable],
      "₹19.99: the tax drops by 2 paise, so the part without tax rises by 1",
    ).toEqual([1, 1695, 304, 1999, 1999]);
    expect([line.actual, line.discount], "never a discount below ₹0").toEqual([1695, 0]);
    balances(line);
  });
});
