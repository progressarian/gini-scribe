import crypto from "node:crypto";
import { test, expect } from "@playwright/test";
import { getPool, query } from "../../helpers/db.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const rules = await import("../../../server/services/billing/paymentRules.js");
const items = await import("../../../server/services/billing/serviceItems.js");
const rates = await import("../../../server/services/billing/categoryRates.js");
const { lineActual } = await import("../../../server/services/billing/priceLine.js");
const schemes = await import("../../../server/services/patientSchemes.js");
const { linePayable } = await import("../../../server/services/billing/linePayable.js");
const { paise } = await import("../../../shared/labPayment.js");

const db = getPool();
const ctx = { actorId: USERS.reception_admin.id, ip: "10.9.9.9" };
const tag = crypto.randomBytes(3).toString("hex");
const T = tag.toUpperCase();
const c = (name) => `p312_${name}_${tag}`;
const ids = {};
const DAY = "2026-10-15";

const rule = (patient_pays, patient_value = null, remainder = "claim", id = 7) => ({
  rule: { id },
  patient_pays,
  patient_value,
  remainder,
});
const NO_RULE = {
  rule: null,
  patient_pays: "full",
  patient_value: null,
  remainder: null,
  scope: null,
  from_parent: false,
};
const split = (total, payment, quantity) => {
  const out = linePayable({ total, payment, quantity });
  expect(out.patient_payable + out.claim + out.adjustment, `invariant for ${total}`).toBe(total);
  for (const key of ["patient_payable", "claim", "adjustment"]) {
    expect(Number.isInteger(out[key]) && out[key] >= 0, `${key} is whole paise`).toBe(true);
  }
  return out;
};
const refused = (input) => {
  try {
    linePayable(input);
  } catch (error) {
    return error.message;
  }
  return null;
};

test.describe("P3-12 line pricing: patient payable and the rest (pure)", () => {
  test("1. full: the patient pays the whole line and nothing is left", () => {
    expect(split(150000, NO_RULE)).toEqual({
      patient_payable: 150000,
      claim: 0,
      adjustment: 0,
      payment_rule_id: null,
      payment_rule_text: "full",
      remainder: null,
      capped: false,
    });
    expect(split(99, rule("full", null, "adjustment", 3))).toMatchObject({
      patient_payable: 99,
      payment_rule_id: 3,
      remainder: null,
    });
    expect(split(500, undefined).patient_payable, "no payment result means full").toBe(500);
  });

  test("2. amount: the rule's amount, the rest claimed or adjusted", () => {
    expect(split(150000, rule("amount", 700))).toEqual({
      patient_payable: 70000,
      claim: 80000,
      adjustment: 0,
      payment_rule_id: 7,
      payment_rule_text: "amount ₹700",
      remainder: "claim",
      capped: false,
    });
    expect(split(150000, rule("amount", 700, "adjustment"))).toMatchObject({
      patient_payable: 70000,
      claim: 0,
      adjustment: 80000,
      remainder: "adjustment",
    });
    expect(split(250075, rule("amount", 1234.5))).toMatchObject({
      patient_payable: 123450,
      claim: 126625,
      payment_rule_text: "amount ₹1,234.50",
    });
    expect(split(12500000, rule("amount", 100000)).payment_rule_text).toBe("amount ₹1,00,000");
    expect(split(70000, rule("amount", 700))).toMatchObject({
      patient_payable: 70000,
      claim: 0,
      capped: false,
    });
  });

  test("3. amount above the line: the patient pays the line and nothing is claimed", () => {
    expect(split(50000, rule("amount", 700))).toEqual({
      patient_payable: 50000,
      claim: 0,
      adjustment: 0,
      payment_rule_id: 7,
      payment_rule_text: "amount ₹700 (capped at ₹500)",
      remainder: "claim",
      capped: true,
    });
    expect(split(69999, rule("amount", 700, "adjustment"))).toMatchObject({
      patient_payable: 69999,
      adjustment: 0,
      payment_rule_text: "amount ₹700 (capped at ₹699.99)",
      capped: true,
    });
  });

  test("4. percent: that share of the tax-inclusive total, rounded to the paisa", () => {
    expect(split(100000, rule("percent", 20))).toMatchObject({
      patient_payable: 20000,
      claim: 80000,
      payment_rule_text: "percent 20%",
      capped: false,
    });
    expect(split(12345, rule("percent", 12.5)).patient_payable, "1543.125 rounds down").toBe(1543);
    expect(split(333, rule("percent", 50)).patient_payable, "166.5 rounds up").toBe(167);
    expect(split(101, rule("percent", 33.33, "adjustment"))).toMatchObject({
      patient_payable: 34,
      claim: 0,
      adjustment: 67,
      payment_rule_text: "percent 33.33%",
    });
    expect(split(1, rule("percent", 0.01)).patient_payable).toBe(0);
    expect(split(12345, rule("percent", 100)).patient_payable).toBe(12345);
    expect(split(12345, rule("percent", 0)).claim).toBe(12345);
    for (let total = 0; total < 2000; total += 7) {
      for (const pct of [1, 12.5, 18, 33.33, 66.67, 99.99]) split(total, rule("percent", pct));
    }
  });

  test("5. nothing: the patient pays ₹0 and the whole line goes to the rest", () => {
    expect(split(100000, rule("nothing"))).toEqual({
      patient_payable: 0,
      claim: 100000,
      adjustment: 0,
      payment_rule_id: 7,
      payment_rule_text: "nothing",
      remainder: "claim",
      capped: false,
    });
    expect(split(100000, rule("nothing", null, "adjustment")).adjustment).toBe(100000);
  });

  test("6. a zero line splits into zeros for every rule", () => {
    for (const payment of [
      NO_RULE,
      rule("amount", 700),
      rule("percent", 20),
      rule("nothing", null, "adjustment"),
    ]) {
      expect(split(0, payment), payment.patient_pays).toMatchObject({
        patient_payable: 0,
        claim: 0,
        adjustment: 0,
      });
    }
    expect(split(0, rule("amount", 700)).capped).toBe(true);
    expect(split(0, rule("amount", 0)).capped).toBe(false);
  });

  test("7. bad input is refused", () => {
    const bad = [
      [{ total: 10.5, payment: NO_RULE }, /whole number of paise/],
      [{ total: -1, payment: NO_RULE }, /whole number of paise/],
      [{ total: "100", payment: NO_RULE }, /whole number of paise/],
      [{ payment: NO_RULE }, /whole number of paise/],
      [
        { total: 100, payment: rule("half") },
        "Patient pays must be one of: full, amount, percent, nothing",
      ],
      [
        { total: 100, payment: rule("amount", 5, "refund") },
        "The rest must go to one of: claim, adjustment",
      ],
      [{ total: 100, payment: rule("nothing", null, null) }, /The rest must go to one of/],
      [{ total: 100, payment: rule("amount", null) }, /value must be a number/],
      [{ total: 100, payment: rule("amount", -1) }, /value must be a number/],
      [{ total: 100, payment: rule("percent", 101) }, /value must be a number from 0 to 100/],
      [{ total: 100, payment: rule("percent", "x") }, /value must be a number/],
    ];
    for (const [input, message] of bad) {
      expect(refused(input), JSON.stringify(input)).toMatch(message);
    }
    expect(refused(undefined)).toMatch(/whole number of paise/);
  });

  test("11. amount is per unit: three dressings pay three times the amount", () => {
    expect(split(150000, rule("amount", 200), 3)).toMatchObject({
      patient_payable: 60000,
      claim: 90000,
      payment_rule_text: "amount ₹200",
      capped: false,
    });
    expect(split(150000, rule("amount", 200), undefined).patient_payable, "default 1").toBe(20000);
    expect(split(50000, rule("amount", 200), 3)).toMatchObject({
      patient_payable: 50000,
      claim: 0,
      capped: true,
    });
    expect(split(150000, rule("percent", 20), 3).patient_payable, "percent ignores it").toBe(30000);
    for (const quantity of [0, -1, 1.5, "2", null]) {
      expect(refused({ total: 100, payment: rule("amount", 1), quantity }), `${quantity}`).toMatch(
        /Quantity must be a whole number/,
      );
    }
  });

  test("12. percent on the largest line rounds to the nearest paisa exactly", () => {
    expect(split(999990005111, rule("percent", 90.09)).patient_payable).toBe(900890995604);
    expect(split(999990004909, rule("percent", 90.11)).patient_payable).toBe(901090993423);
    expect(split(999999999999, rule("percent", 50)).patient_payable).toBe(500000000000);
  });

  test("13. a value that isn't a number is refused, not read as 1 or 5", () => {
    for (const value of [true, [5], { value: 5 }]) {
      expect(refused({ total: 100000, payment: rule("amount", value) })).toBe(
        "A payment rule value must be a number, 0 or more",
      );
      expect(refused({ total: 100000, payment: rule("percent", value) })).toBe(
        "A payment rule value must be a number from 0 to 100",
      );
    }
    expect(split(100000, rule("amount", "700.00")).patient_payable).toBe(70000);
    expect(split(100000, rule("percent", "12.50")).payment_rule_text).toBe("percent 12.5%");
  });

  test("14. amount ₹0 sends the whole line to the rest; with GST the tax goes to the rest", () => {
    expect(split(50000, rule("amount", 0))).toMatchObject({
      patient_payable: 0,
      claim: 50000,
      payment_rule_text: "amount ₹0",
      capped: false,
    });
    expect(split(118000, rule("amount", 700))).toMatchObject({
      patient_payable: 70000,
      claim: 48000,
      capped: false,
    });
    expect(split(118000, rule("percent", 20, "adjustment"))).toMatchObject({
      patient_payable: 23600,
      adjustment: 94400,
    });
  });
});

test.describe.serial("P3-12 CGHS examples through real payment rules", () => {
  test.beforeAll(async () => {
    await schemes.createScheme(
      { code: c("cghs"), label: `P312 CGHS ${tag}`, payer_name: "CGHS Wellness Centre" },
      db,
      ctx,
    );
    for (const [code, label] of [
      ["paid", "CGHS Paid"],
      ["referral", "CGHS Referral"],
      ["pensioner", "Pensioner"],
    ]) {
      await schemes.createScheme({ code: c(code), label, parent_code: c("cghs") }, db, ctx);
    }
    const group = await query(
      `INSERT INTO service_groups (code, name) VALUES ($1, $1) RETURNING id`,
      [`P312-OPD-${T}`],
    ).then((r) => r.rows[0].id);
    ids.consults = await query(
      `INSERT INTO service_subgroups (group_id, code, name) VALUES ($1, $2, $2) RETURNING id`,
      [group, `P312-CONSULTS-${T}`],
    ).then((r) => r.rows[0].id);
    const item = (code, price) =>
      query(
        `INSERT INTO service_items (code, name, subgroup_id, base_price, kind)
         VALUES ($1, $1, $2, $3, 'procedure') RETURNING id`,
        [`${code}-${T}`, ids.consults, price],
      ).then((r) => r.rows[0].id);
    ids.newConsult = await item("P312-NEW", 1500);
    ids.followUp = await item("P312-FU", 1000);
    ids.paidRule = (
      await rules.createPaymentRule(
        {
          scheme_code: c("paid"),
          name: "CGHS Paid consultation",
          subgroup_id: ids.consults,
          visit_types: ["New", "Follow Up"],
          patient_pays: "amount",
          patient_value: 700,
          valid_from: "2026-01-01",
        },
        ctx,
        db,
      )
    ).id;
    for (const code of ["referral", "pensioner"]) {
      ids[code] = (
        await rules.createPaymentRule(
          {
            scheme_code: c(code),
            name: "Pays nothing",
            patient_pays: "nothing",
            valid_from: "2026-01-01",
          },
          ctx,
          db,
        )
      ).id;
    }
  });

  const priced = async (category, item, visitType) => {
    const payment = await rules.ruleForLine(
      { category: c(category), item: ids[item], visitType, date: DAY },
      db,
    );
    const { rows } = await query(`SELECT base_price FROM service_items WHERE id = $1`, [ids[item]]);
    return split(paise(rows[0].base_price), payment);
  };

  test("8. CGHS Paid: ₹700 paid, ₹800 claimed on New and ₹300 on Follow Up", async () => {
    expect(await priced("paid", "newConsult", "New")).toEqual({
      patient_payable: 70000,
      claim: 80000,
      adjustment: 0,
      payment_rule_id: ids.paidRule,
      payment_rule_text: "amount ₹700",
      remainder: "claim",
      capped: false,
    });
    expect(await priced("paid", "followUp", "Follow Up")).toEqual({
      patient_payable: 70000,
      claim: 30000,
      adjustment: 0,
      payment_rule_id: ids.paidRule,
      payment_rule_text: "amount ₹700",
      remainder: "claim",
      capped: false,
    });
  });

  test("9. CGHS Referral and Pensioner: ₹0 paid, the full amount claimed", async () => {
    for (const category of ["referral", "pensioner"]) {
      for (const [item, visitType, total] of [
        ["newConsult", "New", 150000],
        ["followUp", "Follow Up", 100000],
      ]) {
        expect(await priced(category, item, visitType), `${category} ${visitType}`).toEqual({
          patient_payable: 0,
          claim: total,
          adjustment: 0,
          payment_rule_id: ids[category],
          payment_rule_text: "nothing",
          remainder: "claim",
          capped: false,
        });
      }
    }
  });

  test("10. a CGHS Paid line the rule does not cover is paid in full", async () => {
    expect(await priced("paid", "newConsult", "Investigation")).toMatchObject({
      patient_payable: 150000,
      claim: 0,
      adjustment: 0,
      payment_rule_id: null,
      payment_rule_text: "full",
      remainder: null,
    });
  });

  test("15. consultation items per doctor: category fees ₹350 / ₹700, rules by visit type", async () => {
    const doctor = (name) =>
      query(
        `INSERT INTO doctors (name, role, pin, is_active) VALUES ($1, 'consultant', 'x', TRUE) RETURNING id`,
        [`${name} ${tag}`],
      ).then((r) => r.rows[0].id);
    const group = await query(
      `INSERT INTO service_groups (code, name) VALUES ($1, $1) RETURNING id`,
      [`P312-DOC-${T}`],
    ).then((r) => r.rows[0].id);
    const subgroup = await query(
      `INSERT INTO service_subgroups (group_id, code, name) VALUES ($1, $2, $2) RETURNING id`,
      [group, `P312-DOCCONS-${T}`],
    ).then((r) => r.rows[0].id);
    const consult = {};
    for (const [who, fee] of [
      ["rahul", 350],
      ["banshali", 700],
    ]) {
      const doctorId = await doctor(`P312 Dr ${who}`);
      for (const [visit, price] of [
        ["New", 1500],
        ["Follow Up", 1000],
      ]) {
        const { id } = await items.createItem(
          {
            code: `P312-${who}-${visit.replace(" ", "")}-${T}`,
            name: `P312 ${who} ${visit} ${tag}`,
            subgroup_id: subgroup,
            base_price: price,
            kind: "consultation",
            doctor_id: doctorId,
            visit_type: visit,
          },
          ctx,
          db,
        );
        consult[`${who} ${visit}`] = id;
        for (const category of ["referral", "pensioner"]) {
          await rates.saveRate(
            { scheme_code: c(category), service_item_id: id, rate: fee, valid_from: "2026-01-01" },
            ctx,
            db,
          );
        }
      }
    }
    const paidRule = await rules.createPaymentRule(
      {
        scheme_code: c("paid"),
        name: "CGHS Paid doctor consultations",
        subgroup_id: subgroup,
        visit_types: ["New", "Follow Up"],
        patient_pays: "amount",
        patient_value: 700,
        valid_from: "2026-01-01",
      },
      ctx,
      db,
    );
    const bill = async (category, key) => {
      const line = await lineActual({ item: consult[key], category: c(category), date: DAY }, db);
      const payment = await rules.ruleForLine(
        { category: c(category), item: line.item_id, visitType: line.visit_type, date: DAY },
        db,
      );
      const out = split(line.actual, payment, line.quantity);
      return [line.actual, out.patient_payable, out.claim, out.payment_rule_id];
    };
    const cases = [
      ["paid", "rahul New", [150000, 70000, 80000, paidRule.id]],
      ["paid", "banshali Follow Up", [100000, 70000, 30000, paidRule.id]],
      ["referral", "rahul New", [35000, 0, 35000, ids.referral]],
      ["referral", "banshali Follow Up", [70000, 0, 70000, ids.referral]],
      ["pensioner", "rahul Follow Up", [35000, 0, 35000, ids.pensioner]],
      ["pensioner", "banshali New", [70000, 0, 70000, ids.pensioner]],
    ];
    for (const [category, key, expected] of cases) {
      expect(await bill(category, key), `${category} ${key}`).toEqual(expected);
    }
  });
});
