import crypto from "node:crypto";
import { test, expect } from "@playwright/test";
import { getPool, query } from "../../helpers/db.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const { assertLineBalances, assertBillLineBalances } =
  await import("../../../server/services/billing/lineInvariant.js");

const good = () => ({
  item_id: 1,
  item_name: "Consultation",
  bill_name: "Consultation (FU)",
  quantity: 1,
  base_price: 100000,
  rate: 100000,
  actual: 100000,
  listed_actual: 100000,
  discount: 35000,
  listed_discount: 35000,
  payable_discount: 35000,
  discounts: [{ rule_id: 9, amount: 35000, taken_from: "patient_payable" }],
  taxable: 100000,
  cgst: 9000,
  sgst: 9000,
  tax: 18000,
  total: 118000,
  patient_payable: 35000,
  claim: 48000,
  adjustment: 0,
  remainder: "claim",
});

const fullPay = () => ({
  ...good(),
  discount: 10000,
  listed_discount: 10000,
  payable_discount: 0,
  discounts: [{ rule_id: 3, amount: 10000, taken_from: "actual" }],
  taxable: 90000,
  cgst: 8100,
  sgst: 8100,
  tax: 16200,
  total: 106200,
  patient_payable: 106200,
  claim: 0,
  remainder: null,
});

const fails = (line, fault) => {
  let error = null;
  try {
    assertLineBalances(line);
  } catch (e) {
    error = e;
  }
  expect(error?.status, JSON.stringify(line)).toBe(500);
  expect(error?.message).toContain(fault);
  return error;
};

test.describe("P3-14 line invariant (pure)", () => {
  test("1. a balanced line passes and comes back unchanged", () => {
    for (const line of [good(), fullPay()]) {
      expect(assertLineBalances(line)).toBe(line);
    }
    const inclusive = {
      ...fullPay(),
      rate: 118000,
      base_price: 118000,
      listed_actual: 118000,
      actual: 100000,
      discount: 50000,
      listed_discount: 59000,
      discounts: [{ amount: 59000, taken_from: "actual" }],
      taxable: 50000,
      cgst: 4500,
      sgst: 4500,
      tax: 9000,
      total: 59000,
      patient_payable: 59000,
    };
    expect(assertLineBalances(inclusive)).toBe(inclusive);
    const free = {
      ...fullPay(),
      rate: 0,
      base_price: 0,
      listed_actual: 0,
      actual: 0,
      discount: 0,
      listed_discount: 0,
      discounts: [],
      taxable: 0,
      cgst: 0,
      sgst: 0,
      tax: 0,
      total: 0,
      patient_payable: 0,
    };
    expect(assertLineBalances(free)).toBe(free);
    const written = { ...good(), claim: 0, adjustment: 48000, remainder: "adjustment" };
    expect(assertLineBalances(written)).toBe(written);
  });

  test("2. the error names the line and says it doesn't balance", () => {
    const error = fails({ ...good(), claim: 48001 }, "doesn't balance");
    expect(error.message).toBe(
      `The priced line "Consultation (FU)" doesn't balance: actual − discount + tax ≠ patient payable + claim + adjustment; total − payable discount ≠ patient payable + claim + adjustment`,
    );
    const unnamed = fails({ ...good(), bill_name: undefined, claim: 1 }, `"Consultation"`);
    expect(unnamed.message).toMatch(/^The priced line "Consultation" doesn't balance/);
    fails(null, `"a line" doesn't balance: it isn't a line`);
    fails("line", "it isn't a line");
  });

  test("3. every money field must be whole paise, 0 or more", () => {
    const fields = [
      "base_price",
      "rate",
      "actual",
      "listed_actual",
      "discount",
      "listed_discount",
      "payable_discount",
      "taxable",
      "cgst",
      "sgst",
      "tax",
      "total",
      "patient_payable",
      "claim",
      "adjustment",
    ];
    for (const field of fields) {
      for (const value of [-1, 1.5, "100", null, undefined, NaN, 2 ** 53]) {
        fails({ ...good(), [field]: value }, `${field} must be whole paise, 0 or more`);
      }
    }
  });

  test("4. the balance: actual − discount + tax = patient payable + claim + adjustment", () => {
    const balance = "actual − discount + tax ≠ patient payable + claim + adjustment";
    for (const change of [
      { actual: 100001 },
      { discount: 34999 },
      { patient_payable: 35001 },
      { claim: 47999 },
      { adjustment: 1 },
    ]) {
      fails({ ...good(), ...change }, balance);
    }
    fails({ ...good(), actual: 100001, listed_actual: 100001, rate: 100001 }, balance);
    const moved = { ...good(), patient_payable: 36000, claim: 47000 };
    expect(assertLineBalances(moved), "a split that still adds up is not the invariant's job").toBe(
      moved,
    );
  });

  test("5. the tax: taxable + tax = total, CGST = SGST, CGST + SGST = tax", () => {
    fails({ ...good(), taxable: 100001 }, "taxable + tax ≠ total");
    fails({ ...good(), total: 118001 }, "taxable + tax ≠ total");
    fails({ ...good(), cgst: 9001, sgst: 8999 }, "CGST ≠ SGST");
    fails({ ...good(), tax: 18002, total: 118002, claim: 48002 }, "CGST + SGST ≠ tax");
    fails({ ...good(), cgst: 9001, sgst: 9001 }, "CGST + SGST ≠ tax");
  });

  test("6. the payable discount: what it takes off the total, and never more than the discount", () => {
    fails(
      { ...good(), payable_discount: 34000 },
      "total − payable discount ≠ patient payable + claim + adjustment",
    );
    fails(
      {
        ...good(),
        payable_discount: 35000,
        listed_discount: 30000,
        discounts: [{ amount: 30000, taken_from: "patient_payable" }],
      },
      "payable discount is more than the discount",
    );
    fails(
      { ...fullPay(), payable_discount: 1000, patient_payable: 105200 },
      "a payable discount on a line where the patient pays in full",
    );
    fails(
      { ...good(), patient_payable: 118001, claim: 0, discount: 0, payable_discount: 0 },
      "patient payable is more than the total",
    );
  });

  test("7. the discounts listed add up to the discount", () => {
    fails(
      { ...good(), listed_discount: 35001 },
      "the discounts don't add up to the listed discount",
    );
    fails(
      { ...good(), discounts: [{ amount: 35000, taken_from: "actual" }] },
      "the discounts on the patient payable don't add up to the payable discount",
    );
    fails(
      {
        ...good(),
        discounts: [
          { amount: 30000, taken_from: "patient_payable" },
          { amount: 4000, taken_from: "patient_payable" },
        ],
      },
      "the discounts don't add up to the listed discount",
    );
    fails({ ...fullPay(), discounts: [] }, "the discounts don't add up to the listed discount");
    for (const discounts of [
      null,
      "x",
      [{ amount: 0 }],
      [{ amount: -5 }],
      [{ amount: 1.5 }],
      [null],
    ]) {
      fails({ ...good(), discounts }, "every discount must take whole paise, more than 0");
    }
  });

  test("8. quantity × rate, and where the rest may go", () => {
    fails({ ...good(), listed_actual: 200000 }, "listed actual ≠ quantity × rate");
    for (const quantity of [0, 1.5, "1", null]) {
      fails({ ...good(), quantity }, "quantity must be a whole number, 1 or more");
    }
    const three = { ...fullPay(), quantity: 3, rate: 100000 / 3 };
    fails(three, "rate must be whole paise");
    fails({ ...good(), remainder: "adjustment" }, "a claim without a claim rule");
    fails(
      { ...good(), claim: 0, adjustment: 48000, remainder: "claim" },
      "an adjustment without an adjustment rule",
    );
    fails({ ...fullPay(), claim: 1, patient_payable: 106199 }, "a claim without a claim rule");
  });

  test("9. every discount says what it was taken from", () => {
    const where = "every discount must be taken from the actual or the patient payable";
    for (const takenFrom of [undefined, null, "bill", "Actual"]) {
      fails({ ...fullPay(), discounts: [{ amount: 10000, taken_from: takenFrom }] }, where);
    }
  });

  test("10. the rest goes to a claim, an adjustment, or nowhere on a full-pay line", () => {
    const rest = "the rest must go to claim or adjustment, or be none on a full-pay line";
    for (const remainder of [undefined, "payer", "Claim", 0]) {
      fails({ ...fullPay(), remainder }, rest);
    }
    const noRule = {
      ...fullPay(),
      remainder: undefined,
      discount: 20000,
      listed_discount: 20000,
      payable_discount: 10000,
      patient_payable: 96200,
      discounts: [
        { amount: 10000, taken_from: "actual" },
        { amount: 10000, taken_from: "patient_payable" },
      ],
    };
    fails(noRule, rest);
  });

  test("11. the discount off the actual matches the discounts taken off it", () => {
    const mismatch = "the discount off the actual doesn't match the discounts taken off it";
    const unexplained = {
      ...good(),
      discount: 45000,
      taxable: 90000,
      cgst: 8100,
      sgst: 8100,
      tax: 16200,
      total: 106200,
      claim: 36200,
    };
    fails(unexplained, mismatch);
    const both = {
      ...unexplained,
      listed_discount: 45000,
      discounts: [
        { amount: 10000, taken_from: "actual" },
        { amount: 35000, taken_from: "patient_payable" },
      ],
    };
    const error = fails(both, "a discount off the actual on a line under a payment rule");
    expect(error.message).not.toContain(mismatch);
    fails(
      {
        ...fullPay(),
        listed_discount: 12000,
        discounts: [{ amount: 12000, taken_from: "actual" }],
      },
      mismatch,
    );
    const inclusive = {
      ...fullPay(),
      rate: 118000,
      base_price: 118000,
      listed_actual: 118000,
      actual: 100000,
      discount: 50000,
      listed_discount: 49000,
      discounts: [{ amount: 49000, taken_from: "actual" }],
      taxable: 50000,
      cgst: 4500,
      sgst: 4500,
      tax: 9000,
      total: 59000,
      patient_payable: 59000,
    };
    fails(inclusive, mismatch);
    const onePaisa = {
      ...fullPay(),
      rate: 2000,
      base_price: 2000,
      listed_actual: 2000,
      actual: 1695,
      discount: 0,
      listed_discount: 1,
      discounts: [{ amount: 1, taken_from: "actual" }],
      taxable: 1695,
      cgst: 152,
      sgst: 152,
      tax: 304,
      total: 1999,
      patient_payable: 1999,
    };
    expect(assertLineBalances(onePaisa), "₹20 with tax inside, 1 paisa off").toBe(onePaisa);
    fails({ ...onePaisa, actual: 1694, discount: -1 }, "discount must be whole paise");
    fails(
      {
        ...good(),
        rate: 2000,
        base_price: 2000,
        listed_actual: 2000,
        actual: 1694,
        discount: 9,
        listed_discount: 10,
        payable_discount: 10,
        discounts: [{ amount: 10, taken_from: "patient_payable" }],
        taxable: 1695,
        cgst: 152,
        sgst: 152,
        tax: 304,
        total: 1999,
        patient_payable: 990,
        claim: 999,
      },
      mismatch,
    );
  });

  test("12. a bill line: the bill's share comes off the patient payable and is checked too", () => {
    const billLine = (line, share, steps = [{ rule_id: 5, amount: share }]) => ({
      ...line,
      line_no: 2,
      discount: line.discount + share,
      patient_payable: line.patient_payable - share,
      bill_discount: share,
      bill_discounts: steps,
    });
    for (const line of [
      billLine(good(), 1000),
      billLine(fullPay(), 6200),
      billLine(good(), 0, []),
    ]) {
      expect(assertBillLineBalances(line)).toBe(line);
    }
    const split = billLine(fullPay(), 6200, [
      { rule_id: 5, amount: 6000 },
      { rule_id: 6, amount: 200 },
    ]);
    expect(assertBillLineBalances(split)).toBe(split);
    const backedOut = billLine(good(), 1000);
    expect(
      assertLineBalances({
        ...backedOut,
        discount: backedOut.discount - 1000,
        patient_payable: backedOut.patient_payable + 1000,
      }),
      "the line check ignores the bill's share, as priceBill calls it today",
    ).toBeTruthy();
    const bill = (line) => {
      let caught = null;
      try {
        assertBillLineBalances(line);
      } catch (e) {
        caught = e;
      }
      expect(caught?.status, JSON.stringify(line)).toBe(500);
      return caught.message;
    };
    const unapplied = { ...billLine(good(), 1000), discount: 35000, patient_payable: 35000 };
    expect(bill(unapplied), "a share recorded but not taken off").toBe(
      `The priced line "Consultation (FU)" (line 2) doesn't balance: total − payable discount − bill discount ≠ patient payable + claim + adjustment; the discount off the actual doesn't match the discounts taken off it`,
    );
    expect(bill({ ...billLine(good(), 1000), bill_discount: undefined })).toContain(
      "bill_discount must be whole paise, 0 or more",
    );
    expect(bill(billLine(good(), 36000))).toContain("patient_payable must be whole paise");
    for (const steps of [
      null,
      "x",
      [{ amount: 0 }],
      [{ amount: 999.5 }, { amount: 0.5 }],
      [null],
    ]) {
      expect(bill(billLine(good(), 1000, steps))).toContain(
        "every bill discount must take whole paise, more than 0",
      );
    }
    expect(bill(billLine(good(), 1000, [{ amount: 900 }]))).toContain(
      "the bill discounts don't add up to the bill discount",
    );
    expect(bill({ ...billLine(good(), 1000), discount: 35000 })).toContain(
      "the discount off the actual doesn't match the discounts taken off it",
    );
  });
});

const { priceLine } = await import("../../../server/services/billing/priceLine.js");
const rules = await import("../../../server/services/billing/paymentRules.js");
const discountRules = await import("../../../server/services/billing/discountRules.js");
const schemes = await import("../../../server/services/patientSchemes.js");

const db = getPool();
const ctx = { actorId: USERS.reception_admin.id, ip: "10.14.14.14" };
const tag = crypto.randomBytes(3).toString("hex");
const T = tag.toUpperCase();
const c = (name) => `p314_${name}_${tag}`;
const ids = {};
let client = null;

test.describe.serial("P3-14 line invariant: every priced line passes it", () => {
  test.beforeAll(async () => {
    await schemes.createScheme(
      { code: c("cghs"), label: `P314 CGHS ${tag}`, payer_name: "CGHS Wellness Centre" },
      db,
      ctx,
    );
    await schemes.createScheme(
      { code: c("paid"), label: "CGHS Paid", parent_code: c("cghs") },
      db,
      ctx,
    );
    const one = (sql, params) => query(sql, params).then((r) => r.rows[0].id);
    ids.opd = await one(`INSERT INTO service_groups (code, name) VALUES ($1, $1) RETURNING id`, [
      `P314-OPD-${T}`,
    ]);
    ids.consults = await one(
      `INSERT INTO service_subgroups (group_id, code, name) VALUES ($1, $2, $2) RETURNING id`,
      [ids.opd, `P314-CONS-${T}`],
    );
    ids.gst18 = await one(
      `INSERT INTO tax_codes (code, sac_hsn, rate_pct) VALUES ($1, '999312', 18) RETURNING id`,
      [`P314-GST18-${T}`],
    );
    const item = (code, amount, tax = null, inclusive = false) =>
      one(
        `INSERT INTO service_items
           (code, name, subgroup_id, base_price, kind, tax_code_id, price_includes_tax,
            allow_quantity)
         VALUES ($1, $1, $2, $3, 'procedure', $4, $5, TRUE) RETURNING id`,
        [`${code}-${T}`, ids.consults, amount, tax, inclusive],
      );
    ids.plain = await item("P314-PLAIN", 999.99);
    ids.taxed = await item("P314-TAXED", 1000.01, ids.gst18);
    ids.inclusive = await item("P314-INCL", 1179.99, ids.gst18, true);
    await rules.createPaymentRule(
      {
        scheme_code: c("paid"),
        valid_from: "2026-01-01",
        subgroup_id: ids.consults,
        name: "Paid pays 33.33%",
        patient_pays: "percent",
        patient_value: 33.33,
      },
      ctx,
      db,
    );
    for (const [name, kind, value, extra] of [
      ["P13", "percent", 13.33, {}],
      ["F77", "flat", 77.77, { stackable: true }],
      ["X3", "fixed_price", 333.33, {}],
    ]) {
      await discountRules.createDiscountRule(
        {
          name: `${name} ${tag}`,
          code: `${name}${T}`,
          method: "code",
          kind,
          value,
          applies_on_scheme_rate: true,
          valid_from: "2026-01-01",
          ...extra,
        },
        ctx,
        db,
      );
    }
    await discountRules.createDiscountRule(
      {
        name: `Auto 7% ${tag}`,
        method: "auto",
        kind: "percent",
        value: 7,
        stackable: true,
        applies_on_scheme_rate: true,
        group_ids: [ids.opd],
        valid_from: "2026-01-01",
      },
      ctx,
      db,
    );
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

  test("13. odd prices, both GST modes, both stackings, full-pay and payment-rule lines all balance", async () => {
    let priced = 0;
    for (const item of ["plain", "taxed", "inclusive"]) {
      for (const category of [null, c("paid")]) {
        for (const settings of [
          { discount_stacking: "best_only", gst_enabled: false },
          { discount_stacking: "per_rule", gst_enabled: true },
          { discount_stacking: "best_only", gst_enabled: true },
        ]) {
          for (const codes of [[], [`P13${T}`, `F77${T}`], [`X3${T}`, `F77${T}`]]) {
            for (const quantity of [1, 3]) {
              const line = await priceLine(
                {
                  item: ids[item],
                  category,
                  settings,
                  codes,
                  quantity,
                  date: "2026-10-15",
                  role: "reception",
                },
                client,
              );
              expect(assertLineBalances(line)).toBe(line);
              expect(line.discounts.length, `${item} ${category} ${codes}`).toBeGreaterThan(0);
              expect(line.payable_discount > 0, `${item} ${category}`).toBe(category !== null);
              priced += 1;
            }
          }
        }
      }
    }
    expect(priced).toBe(108);
  });
});
