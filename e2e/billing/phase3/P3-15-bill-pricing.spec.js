import crypto from "node:crypto";
import { test, expect } from "@playwright/test";
import { getPool, query } from "../../helpers/db.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const { priceBill, MAX_BILL_LINES } = await import("../../../server/services/billing/priceBill.js");
const rules = await import("../../../server/services/billing/paymentRules.js");
const discounts = await import("../../../server/services/billing/discountRules.js");
const schemes = await import("../../../server/services/patientSchemes.js");

const db = getPool();
const ctx = { actorId: USERS.reception_admin.id, ip: "10.15.15.15" };
const tag = crypto.randomBytes(3).toString("hex");
const T = tag.toUpperCase();
const c = (name) => `p315_${name}_${tag}`;
const ids = {};
let client = null;
const DAY = "2026-10-15";
const TOTALS = [
  "actual",
  "discount",
  "bill_discount",
  "taxable",
  "cgst",
  "sgst",
  "tax",
  "patient_payable",
  "claim",
  "adjustment",
];

const bill = (lines, extra = {}) =>
  priceBill(
    {
      date: DAY,
      role: "reception",
      lines: lines.map((line) => (typeof line === "string" ? { item: ids[line] } : line)),
      ...extra,
    },
    client,
  );

const settings = (values) =>
  client.query(
    `UPDATE billing_settings SET ${Object.keys(values)
      .map((key, i) => `${key} = $${i + 1}`)
      .join(", ")}`,
    Object.values(values),
  );

const billRule = (input) =>
  discounts.createDiscountRule(
    {
      method: "auto",
      kind: "percent",
      applies_per: "bill",
      valid_from: "2026-01-01",
      ...input,
      name: `${input.name} ${tag}`,
      code: input.code ? `${input.code}${T}` : undefined,
      ...(input.code ? { method: "code" } : {}),
    },
    ctx,
    client,
  );

const addPatient = (values = {}) =>
  client
    .query(
      `INSERT INTO patients (name, dob, sex, scheme_code, scheme_ref) VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [
        `P315 patient ${tag}`,
        values.dob ?? null,
        values.sex ?? null,
        values.scheme_code ?? null,
        values.scheme_ref ?? null,
      ],
    )
    .then((r) => r.rows[0].id);

function adds(priced) {
  const { totals, lines } = priced;
  for (const key of TOTALS) {
    expect(totals[key], `total ${key} = Σ lines`).toBe(
      lines.reduce((sum, line) => sum + line[key], 0),
    );
  }
  expect(totals.payable, "payable = patient payable + round-off").toBe(
    totals.patient_payable + totals.round_off,
  );
  expect(totals.payable % 100, "payable is whole rupees").toBe(0);
  expect(Math.abs(totals.round_off)).toBeLessThanOrEqual(50);
  expect(totals.actual - totals.discount + totals.tax, "bill balances").toBe(
    totals.patient_payable + totals.claim + totals.adjustment,
  );
  for (const line of lines) {
    expect(line.actual - line.discount + line.tax, `line ${line.line_no} balances`).toBe(
      line.patient_payable + line.claim + line.adjustment,
    );
    expect(line.patient_payable).toBeGreaterThanOrEqual(0);
    expect(line.bill_discount).toBe(line.bill_discounts.reduce((sum, s) => sum + s.amount, 0));
  }
  expect(totals.bill_discount).toBe(priced.bill_discounts.reduce((sum, s) => sum + s.amount, 0));
  for (const step of priced.bill_discounts) {
    const shares = lines.flatMap((line) =>
      line.bill_discounts.filter((s) => s.rule_id === step.rule_id).map((s) => s.amount),
    );
    expect(
      shares.reduce((a, b) => a + b, 0),
      `${step.name} is shared out exactly`,
    ).toBe(step.amount);
  }
  return priced;
}

const payables = (priced) => priced.lines.map((line) => line.patient_payable);
const shares = (priced) => priced.lines.map((line) => line.bill_discount);

test.describe.serial("P3-15 bill pricing", () => {
  test.beforeAll(async () => {
    await schemes.createScheme(
      { code: c("cghs"), label: `P315 CGHS ${tag}`, payer_name: "CGHS Wellness Centre" },
      db,
      ctx,
    );
    await schemes.createScheme(
      { code: c("paid"), label: "CGHS Paid", parent_code: c("cghs") },
      db,
      ctx,
    );
    await schemes.createScheme(
      { code: c("pens"), label: "Pensioner", parent_code: c("cghs") },
      db,
      ctx,
    );
    const one = (sql, params) => query(sql, params).then((r) => r.rows[0].id);
    ids.opd = await one(`INSERT INTO service_groups (code, name) VALUES ($1, $1) RETURNING id`, [
      `P315-OPD-${T}`,
    ]);
    ids.lab = await one(`INSERT INTO service_groups (code, name) VALUES ($1, $1) RETURNING id`, [
      `P315-LAB-${T}`,
    ]);
    ids.consults = await one(
      `INSERT INTO service_subgroups (group_id, code, name) VALUES ($1, $2, $2) RETURNING id`,
      [ids.opd, `P315-CONS-${T}`],
    );
    ids.tests = await one(
      `INSERT INTO service_subgroups (group_id, code, name) VALUES ($1, $2, $2) RETURNING id`,
      [ids.lab, `P315-TESTS-${T}`],
    );
    ids.gst18 = await one(
      `INSERT INTO tax_codes (code, sac_hsn, rate_pct) VALUES ($1, '999315', 18) RETURNING id`,
      [`P315-GST18-${T}`],
    );
    ids.drA = await one(`INSERT INTO doctors (name) VALUES ($1) RETURNING id`, [
      `P315 Dr A ${tag}`,
    ]);
    ids.drB = await one(`INSERT INTO doctors (name) VALUES ($1) RETURNING id`, [
      `P315 Dr B ${tag}`,
    ]);
    const item = (code, subgroup, price, extra = {}) =>
      one(
        `INSERT INTO service_items (code, name, subgroup_id, base_price, kind, tax_code_id, allow_quantity)
         VALUES ($1, $1, $2, $3, $4, $5, $6) RETURNING id`,
        [
          `${code}-${T}`,
          subgroup,
          price,
          extra.kind ?? "procedure",
          extra.tax ?? null,
          extra.allow_quantity ?? false,
        ],
      );
    ids.newVisit = await item("P315-NEW", ids.consults, 1500);
    ids.followUp = await item("P315-FU", ids.consults, 1000);
    ids.hba1c = await item("P315-HBA1C", ids.tests, 250);
    ids.odd = await item("P315-ODD", ids.tests, 100.49);
    ids.tiny = await item("P315-TINY", ids.tests, 0.51);
    ids.lipid = await item("P315-LIPID", ids.tests, 333.33);
    ids.cbc = await item("P315-CBC", ids.tests, 199.99);
    ids.half = await item("P315-HALF", ids.tests, 100.5);
    ids.taxed = await item("P315-TAXED", ids.tests, 123.45, { tax: ids.gst18 });
    ids.swab = await item("P315-SWAB", ids.tests, 33.33, { allow_quantity: true });
    await rules.createPaymentRule(
      {
        scheme_code: c("paid"),
        valid_from: "2026-01-01",
        subgroup_id: ids.consults,
        name: "Paid consults ₹700",
        patient_pays: "amount",
        patient_value: 700,
        visit_types: ["New", "Follow Up"],
      },
      ctx,
      db,
    );
    await rules.createPaymentRule(
      {
        scheme_code: c("pens"),
        valid_from: "2026-01-01",
        name: "Pensioner pays nothing",
        patient_pays: "nothing",
      },
      ctx,
      db,
    );
    const code = (name, input) =>
      discounts.createDiscountRule(
        {
          name: `${name} ${tag}`,
          code: `${name}${T}`,
          method: "code",
          kind: "percent",
          valid_from: "2026-01-01",
          ...input,
        },
        ctx,
        db,
      );
    await code("OPD50", { value: 50, group_ids: [ids.opd] });
    await code("LAB10", { value: 10, group_ids: [ids.lab] });
    await code("DRA20", { value: 20, group_ids: [ids.opd], doctor_ids: [ids.drA] });
    await code("OLD5", { value: 5, valid_to: "2026-02-01" });
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
    await settings({
      discount_stacking: "best_only",
      gst_enabled: false,
      max_codes_per_bill: null,
    });
  });
  test.afterEach(async () => {
    await client.query("ROLLBACK");
    client.release();
  });

  test("1. the totals equal the sum of the lines plus the round-off", async () => {
    const cases = [
      [["hba1c"], 25000, 0],
      [["hba1c", "odd"], 35049, -49],
      [["odd", "tiny"], 10100, 0],
      [["cbc"], 19999, 1],
      [["half"], 10050, 50],
      [["lipid", "cbc"], 53332, -32],
      [["lipid", "lipid", "lipid"], 99999, 1],
      [[{ item: "swab", quantity: 3 }, "tiny"], 10050, 50],
    ];
    for (const [lines, patient, roundOff] of cases) {
      const priced = adds(
        await bill(
          lines.map((line) =>
            typeof line === "string" ? line : { item: ids[line.item], quantity: line.quantity },
          ),
        ),
      );
      expect([priced.totals.patient_payable, priced.totals.round_off], lines.join("+")).toEqual([
        patient,
        roundOff,
      ]);
      expect(priced.totals.payable).toBe(patient + roundOff);
      expect(priced.lines.map((line) => line.line_no)).toEqual(lines.map((_, i) => i + 1));
    }
    const general = await bill(["hba1c"]);
    expect([general.category, general.payer_name, general.refused_codes]).toEqual([null, null, []]);
  });

  test("2. a mixed CGHS Paid bill: consultation under an amount rule, lab test in full", async () => {
    const patientId = await addPatient({ scheme_code: c("paid"), dob: "1950-03-01", sex: "Male" });
    const priced = adds(await bill(["newVisit", "hba1c"], { patientId, visitType: "New" }));
    expect(priced.category).toMatchObject({ code: c("paid"), source: "patient" });
    expect(priced.payer_name).toBe("CGHS Wellness Centre");
    expect(priced.patient).toMatchObject({ id: patientId, age: 76, gender: "Male" });
    expect(
      priced.lines.map((l) => [l.actual, l.patient_payable, l.claim, l.payment_rule_text]),
    ).toEqual([
      [150000, 70000, 80000, "amount ₹700"],
      [25000, 25000, 0, "full"],
    ]);
    expect(priced.totals).toMatchObject({
      actual: 175000,
      patient_payable: 95000,
      claim: 80000,
      adjustment: 0,
      round_off: 0,
      payable: 95000,
    });
  });

  test("3. a bill-level automatic rule with no targets comes off the whole bill's patient payable", async () => {
    await billRule({ name: "Bill 10%", value: 10 });
    const priced = adds(await bill(["hba1c", "lipid", "cbc"]));
    expect(priced.bill_discounts).toEqual([
      expect.objectContaining({ kind: "percent", value: 10, amount: 7833, line_nos: [1, 2, 3] }),
    ]);
    expect(shares(priced)).toEqual([2500, 3333, 2000]);
    expect(payables(priced)).toEqual([22500, 30000, 17999]);
    expect(priced.totals).toMatchObject({
      patient_payable: 70499,
      bill_discount: 7833,
      round_off: 1,
      payable: 70500,
    });
    expect(priced.lines[0].bill_discounts[0]).toMatchObject({ method: "auto", amount: 2500 });

    const patientId = await addPatient({ scheme_code: c("paid") });
    const cghs = adds(await bill(["newVisit", "hba1c"], { patientId, visitType: "New" }));
    expect(shares(cghs), "the payment-rule line isn't touched").toEqual([0, 2500]);
    expect(cghs.lines[0]).toMatchObject({ patient_payable: 70000, claim: 80000 });
  });

  test("4. a bill-level code with targets comes off the subtotal of those lines only", async () => {
    await billRule({
      name: "Lab 100 off",
      code: "LAB100",
      kind: "flat",
      value: 100,
      group_ids: [ids.lab],
    });
    const priced = adds(
      await bill(["newVisit", "hba1c", "lipid"], { visitType: "New", codes: [`lab100${T}`] }),
    );
    expect(priced.applied_codes).toEqual([
      expect.objectContaining({ code: `lab100${T}`, applies_per: "bill" }),
    ]);
    expect(priced.bill_discounts).toEqual([
      expect.objectContaining({
        code: `LAB100${T}`,
        method: "code",
        amount: 10000,
        line_nos: [2, 3],
      }),
    ]);
    expect(shares(priced)).toEqual([0, 4286, 5714]);
    expect(priced.totals.patient_payable).toBe(150000 + 25000 + 33333 - 10000);

    const none = adds(await bill(["newVisit"], { visitType: "New", codes: [`LAB100${T}`] }));
    expect(none.refused_codes).toEqual([
      {
        code: `LAB100${T}`,
        reason: "items",
        message: `The code LAB100${T} isn't for any item on this bill`,
      },
    ]);
    expect(none.totals.bill_discount).toBe(0);

    const small = adds(await bill(["tiny"], { codes: [`LAB100${T}`] }));
    expect(small.lines[0]).toMatchObject({ bill_discount: 51, patient_payable: 0 });
    expect(small.totals).toMatchObject({ patient_payable: 0, round_off: 0, payable: 0 });
  });

  test("5. a bill-level code never touches a claim, and only reaches payment-rule lines when allowed", async () => {
    await billRule({ name: "All 20", code: "ALL20", value: 20 });
    await billRule({ name: "Scheme 20", code: "SCH20", value: 20, applies_on_scheme_rate: true });
    const patientId = await addPatient({ scheme_code: c("paid") });
    const input = { patientId, visitType: "New" };
    const plain = adds(await bill(["newVisit", "hba1c"], { ...input, codes: [`ALL20${T}`] }));
    expect(shares(plain)).toEqual([0, 5000]);
    const scheme = adds(await bill(["newVisit", "hba1c"], { ...input, codes: [`SCH20${T}`] }));
    expect(shares(scheme)).toEqual([14000, 5000]);
    expect(scheme.lines[0]).toMatchObject({ patient_payable: 56000, claim: 80000 });
    expect(scheme.totals.claim).toBe(80000);

    const consultOnly = adds(await bill(["newVisit"], { ...input, codes: [`ALL20${T}`] }));
    expect(consultOnly.refused_codes).toEqual([
      expect.objectContaining({ code: `ALL20${T}`, reason: "payment_rule" }),
    ]);
  });

  test("6. a code counts once per bill towards the most codes on one bill", async () => {
    await settings({ max_codes_per_bill: 1 });
    const lines = ["newVisit", "followUp", "hba1c"];
    const codes = [`OPD50${T}`, `LAB10${T}`];
    const one = adds(await bill(lines, { visitType: "New", codes }));
    expect(one.applied_codes.map((a) => a.code)).toEqual([`OPD50${T}`]);
    expect(one.lines.map((l) => l.discount)).toEqual([75000, 50000, 0]);
    expect(one.refused_codes).toEqual([
      {
        code: `LAB10${T}`,
        reason: "too_many_codes",
        message: "A bill can have at most 1 discount code, and this bill already has 1",
      },
    ]);
    for (const line of one.lines) expect(line).not.toHaveProperty("refused_codes");

    await settings({ max_codes_per_bill: 2 });
    const two = adds(await bill(lines, { visitType: "New", codes }));
    expect(two.applied_codes.map((a) => a.code)).toEqual(codes);
    expect(two.lines.map((l) => l.discount)).toEqual([75000, 50000, 2500]);
    expect(two.refused_codes).toEqual([]);

    await billRule({ name: "Bill 50 off", code: "B50", kind: "flat", value: 50 });
    const mixed = adds(
      await bill(lines, { visitType: "New", codes: [`B50${T}`, `OPD50${T}`, `LAB10${T}`] }),
    );
    expect(mixed.applied_codes.map((a) => a.code)).toEqual([`B50${T}`, `OPD50${T}`]);
    expect(mixed.refused_codes.map((r) => [r.code, r.reason])).toEqual([
      [`LAB10${T}`, "too_many_codes"],
    ]);
    expect(mixed.lines[2].discount, "LAB10 was taken off again").toBe(mixed.lines[2].bill_discount);

    const skipped = adds(
      await bill(["hba1c"], { codes: [`OPD50${T}`, `NOPE${T}`, `LAB10${T}`, `B50${T}`] }),
    );
    expect(
      skipped.applied_codes.map((a) => a.code),
      "a code that applies nowhere takes no slot",
    ).toEqual([`LAB10${T}`, `B50${T}`]);
  });

  test("7. a refused code is reported once for the whole bill, with the most relevant reason", async () => {
    const lines = ["newVisit", "hba1c", "lipid"];
    const priced = adds(
      await bill(lines, {
        visitType: "New",
        doctorId: ids.drB,
        codes: [`nope${T}`, `DRA20${T}`, `dra20${T}`, `OLD5${T}`, ` `],
      }),
    );
    expect(priced.refused_codes.map((r) => [r.code, r.reason])).toEqual([
      [`nope${T}`, "unknown"],
      [`DRA20${T}`, "doctor"],
      [`OLD5${T}`, "expired"],
    ]);
    expect(priced.refused_codes[1].message).toContain(`P315 Dr A ${tag}`);
    expect(priced.totals.discount).toBe(0);

    const patientId = await addPatient({ scheme_code: c("paid") });
    const cghs = adds(
      await bill(["newVisit", "hba1c"], { patientId, visitType: "New", codes: [`OPD50${T}`] }),
    );
    expect(cghs.refused_codes).toEqual([
      expect.objectContaining({ code: `OPD50${T}`, reason: "payment_rule" }),
    ]);

    const helper = adds(
      await bill(["newVisit", "hba1c"], {
        visitType: "New",
        doctorId: ids.drA,
        codes: [`DRA20${T}`],
      }),
    );
    expect(helper.lines.map((l) => l.discount)).toEqual([30000, 0]);
    expect(helper.refused_codes).toEqual([]);
  });

  test("8. the category is resolved once, from the patient, the appointment or the desk", async () => {
    const patientId = await addPatient({
      scheme_code: c("paid"),
      dob: "1960-01-01",
      sex: "Female",
    });
    const seen = [];
    const counted = {
      query: (...args) => {
        seen.push(typeof args[0] === "string" ? args[0] : args[0].text);
        return client.query(...args);
      },
    };
    const priced = adds(
      await priceBill(
        {
          date: DAY,
          role: "reception",
          patientId,
          visitType: "Follow Up",
          lines: [{ item: ids.followUp }, { item: ids.hba1c }, { item: ids.lipid }],
        },
        counted,
      ),
    );
    expect(priced.lines.every((l) => l.category === c("paid"))).toBe(true);
    expect(priced.lines[0]).toMatchObject({ patient_payable: 70000, claim: 30000 });
    const count = (text) => seen.filter((sql) => sql.includes(text)).length;
    expect(count("FROM billing_settings"), "settings are read once").toBe(1);
    expect(count("FROM category_rules"), "the category is resolved once").toBe(1);
    expect(count("FROM patients WHERE"), "the patient is read once").toBe(1);
    expect(seen.length, "queries for a 3-line bill").toBeLessThanOrEqual(40);
    test.info().annotations.push({ type: "queries", description: `3 lines: ${seen.length}` });

    const parent = await addPatient({ scheme_code: c("cghs") });
    const refusal = await bill(["hba1c"], { patientId: parent }).catch((e) => e);
    expect(refusal).toMatchObject({ status: 409, needs_sub_category: true });
    expect(refusal.message).toMatch(/has sub-categories/);
    expect(refusal.suggestions.map((s) => s.category.code)).toEqual(
      expect.arrayContaining([c("paid"), c("pens")]),
    );

    const chosen = adds(await bill(["followUp"], { patientId: parent, category: c("pens") }));
    expect(chosen.category).toMatchObject({ code: c("pens"), source: "chosen" });
    expect(chosen.lines[0]).toMatchObject({ patient_payable: 0, claim: 100000 });
    const general = adds(await bill(["hba1c"], { patientId, category: "General" }));
    expect(general.category).toBeNull();

    await expect(bill(["hba1c"], { category: c("cghs") })).rejects.toMatchObject({ status: 409 });
    await expect(bill(["hba1c"], { category: c("nothere") })).rejects.toMatchObject({
      status: 404,
    });
    await expect(bill(["hba1c"], { patientId: 2147483000 })).rejects.toMatchObject({ status: 404 });

    const walkIn = await addPatient();
    const appointmentId = await client
      .query(
        `INSERT INTO appointments (patient_name, patient_id, patient_category, appointment_date, visit_type, doctor_id)
         VALUES ($1, $2, $3, $4, 'Follow-Up', $5) RETURNING id`,
        [`P315 ${tag}`, walkIn, c("paid"), DAY, ids.drA],
      )
      .then((r) => r.rows[0].id);
    const booked = adds(await bill(["followUp"], { patientId: walkIn, appointmentId }));
    expect(booked).toMatchObject({
      visit_type: "Follow Up",
      doctor_id: ids.drA,
      appointment_id: appointmentId,
      category: { code: c("paid"), source: "appointment" },
    });
    expect(booked.lines[0]).toMatchObject({ patient_payable: 70000, claim: 30000 });
    await expect(bill(["hba1c"], { patientId, appointmentId })).rejects.toMatchObject({
      status: 409,
      message: "That appointment belongs to another patient",
    });
  });

  test("9. a claim needs a payer name; the payer is snapshotted", async () => {
    const patientId = await addPatient({ scheme_code: c("paid") });
    const input = { patientId, visitType: "New" };
    await client.query(`UPDATE patient_schemes SET payer_name = 'Own payer' WHERE code = $1`, [
      c("paid"),
    ]);
    expect((await bill(["newVisit"], input)).payer_name, "own payer wins").toBe("Own payer");
    await client.query(`UPDATE patient_schemes SET payer_name = NULL WHERE code = ANY($1)`, [
      [c("paid"), c("cghs")],
    ]);
    await expect(bill(["newVisit"], input)).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/CGHS Paid has no payer name/),
    });
    const noClaim = adds(await bill(["hba1c"], input));
    expect([noClaim.totals.claim, noClaim.payer_name]).toEqual([0, null]);
  });

  test("10. stacking at bill level, GST and odd paise: every line still balances", async () => {
    await settings({
      gst_enabled: true,
      gstin: "03ABCDE1234F1Z5",
      state_code: "03",
      legal_name: `P315 ${tag}`,
    });
    await billRule({ name: "Bill 5%", value: 5 });
    await billRule({ name: "Bill 7%", value: 7 });
    await billRule({ name: "Stack 33.33", kind: "flat", value: 33.33, stackable: true });
    await billRule({
      name: "Lab 3% stack",
      value: 3,
      stackable: true,
      group_ids: [ids.lab],
    });
    const lines = ["newVisit", "taxed", "lipid", "cbc", "tiny", "odd"];
    const best = adds(await bill(lines, { visitType: "New" }));
    expect(best.bill_discounts.map((s) => s.name)).toEqual([`Bill 7% ${tag}`]);
    expect(best.lines[1]).toMatchObject({ tax: 2222, cgst: 1111, sgst: 1111 });
    const subtotal = best.lines.reduce((sum, l) => sum + l.patient_payable + l.bill_discount, 0);
    expect(best.totals.bill_discount).toBe(Math.round(subtotal * 0.07));

    await settings({ discount_stacking: "per_rule" });
    const stacked = adds(await bill(lines, { visitType: "New" }));
    expect(stacked.bill_discounts.map((s) => s.name)).toEqual([
      `Bill 7% ${tag}`,
      `Stack 33.33 ${tag}`,
      `Lab 3% stack ${tag}`,
    ]);
    expect(stacked.bill_discounts[1].amount).toBe(3333);
    expect(stacked.bill_discounts[2].line_nos).toEqual([2, 3, 4, 5, 6]);
    expect(stacked.totals.bill_discount).toBeGreaterThan(best.totals.bill_discount);
    for (const line of stacked.lines) {
      expect(line.bill_discounts.length).toBeLessThanOrEqual(3);
    }
  });

  test("11. the input is checked", async () => {
    await expect(bill([])).rejects.toMatchObject({
      status: 400,
      message: "A bill needs at least one line",
    });
    await expect(
      bill(Array.from({ length: MAX_BILL_LINES + 1 }, () => "hba1c")),
    ).rejects.toMatchObject({
      status: 400,
      message: `A bill can have at most ${MAX_BILL_LINES} lines`,
    });
    await expect(bill([{ quantity: 1 }])).rejects.toMatchObject({
      status: 400,
      message: "Line 1 must name an item",
    });
    await expect(bill(["hba1c", { item: 2147483000 }])).rejects.toMatchObject({
      status: 404,
      message: "Line 2: That item doesn't exist",
      line_no: 2,
    });
    await expect(bill(["hba1c", { item: ids.hba1c, quantity: 2 }])).rejects.toMatchObject({
      status: 400,
      line_no: 2,
    });
    await expect(bill(["hba1c"], { codes: "CC50" })).rejects.toMatchObject({ status: 400 });
    await expect(bill(["hba1c"], { date: "2026-02-30" })).rejects.toMatchObject({ status: 400 });
    const full = adds(await bill(Array.from({ length: MAX_BILL_LINES }, () => "hba1c")));
    expect(full.totals).toMatchObject({ actual: MAX_BILL_LINES * 25000, round_off: 0 });
    const twice = adds(await bill(["hba1c", "hba1c"]));
    expect(
      twice.lines.map((l) => l.item_id),
      "the same item may be on two lines",
    ).toEqual([ids.hba1c, ids.hba1c]);
  });
  test("12. payment-rule-line discounts add up, and a code that takes ₹0 is reported and uses its slot", async () => {
    await discounts.createDiscountRule(
      {
        name: `SCH10 ${tag}`,
        code: `SCH10${T}`,
        method: "code",
        kind: "percent",
        value: 10,
        group_ids: [ids.opd],
        applies_on_scheme_rate: true,
        valid_from: "2026-01-01",
      },
      ctx,
      client,
    );
    await billRule({
      name: "Bill scheme 10 off",
      code: "BSCH",
      kind: "flat",
      value: 10,
      applies_on_scheme_rate: true,
    });
    const paid = await addPatient({ scheme_code: c("paid") });
    const priced = adds(
      await bill(["newVisit", "hba1c"], {
        patientId: paid,
        visitType: "New",
        codes: [`SCH10${T}`],
      }),
    );
    expect(priced.lines[0]).toMatchObject({
      payable_discount: 7000,
      patient_payable: 63000,
      claim: 80000,
    });
    expect(priced.applied_codes).toEqual([
      expect.objectContaining({ code: `SCH10${T}`, applies_per: "line", amount: 7000 }),
    ]);

    await settings({ max_codes_per_bill: 1 });
    const pensioner = await addPatient({ scheme_code: c("pens") });
    const free = adds(
      await bill(["followUp", "hba1c"], {
        patientId: pensioner,
        codes: [`SCH10${T}`, `BSCH${T}`, `LAB10${T}`],
      }),
    );
    expect(free.totals).toMatchObject({ patient_payable: 0, claim: 125000, payable: 0 });
    expect(free.applied_codes).toEqual([expect.objectContaining({ code: `SCH10${T}`, amount: 0 })]);
    expect(free.refused_codes.map((r) => [r.code, r.reason])).toEqual([
      [`BSCH${T}`, "too_many_codes"],
      [`LAB10${T}`, "too_many_codes"],
    ]);
    await settings({ max_codes_per_bill: 2 });
    const room = adds(
      await bill(["followUp", "hba1c"], {
        patientId: pensioner,
        codes: [`SCH10${T}`, `LAB10${T}`],
      }),
    );
    expect(room.refused_codes.map((r) => [r.code, r.reason])).toEqual([
      [`LAB10${T}`, "payment_rule"],
    ]);
  });
  test("13. a fixed price never applies to a whole bill, even from a row saved around the service", async () => {
    const insert = (name, code) =>
      client.query(
        `INSERT INTO discount_rules (name, code, method, kind, value, applies_per, valid_from)
         VALUES ($1, $2, $3, 'fixed_price', 1, 'bill', '2026-01-01')`,
        [`${name} ${tag}`, code, code ? "code" : "auto"],
      );
    await insert("Whole bill ₹1", null);
    await insert("Whole bill ₹1 code", `FIX1${T}`);
    const priced = adds(await bill(["hba1c", "lipid"], { codes: [`FIX1${T}`] }));
    expect(priced.totals).toMatchObject({ patient_payable: 58333, bill_discount: 0 });
    expect(priced.bill_discounts).toEqual([]);
    expect(priced.applied_codes).toEqual([]);
    expect(priced.refused_codes).toEqual([
      {
        code: `FIX1${T}`,
        reason: "fixed_price",
        message: `The code FIX1${T} sets a fixed price, which can't apply to a whole bill`,
      },
    ]);
  });

  test("14. the appointment's visit type follows the shared billing rule, Investigation included", async () => {
    await rules.createPaymentRule(
      {
        scheme_code: c("paid"),
        valid_from: "2026-01-01",
        subgroup_id: ids.tests,
        name: `Investigation tests free ${tag}`,
        patient_pays: "nothing",
        visit_types: ["Investigation"],
      },
      ctx,
      client,
    );
    const walkIn = await addPatient();
    const appointment = (visitType) =>
      client
        .query(
          `INSERT INTO appointments (patient_name, patient_id, patient_category, appointment_date, visit_type)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [`P315 ${tag}`, walkIn, c("paid"), DAY, visitType],
        )
        .then((r) => r.rows[0].id);
    const blank = adds(
      await bill(["followUp", "hba1c"], { appointmentId: await appointment(null) }),
    );
    expect(blank.visit_type, "a blank visit type is New, as billingVisitType says").toBe("New");
    expect(blank.lines.map((l) => [l.patient_payable, l.claim])).toEqual([
      [70000, 30000],
      [25000, 0],
    ]);
    const investigation = adds(
      await bill(["hba1c"], { appointmentId: await appointment("Investigation") }),
    );
    expect(investigation.visit_type).toBe("Investigation");
    expect(investigation.lines[0]).toMatchObject({
      patient_payable: 0,
      claim: 25000,
      payment_rule_name: `Investigation tests free ${tag}`,
    });
    const chosen = adds(
      await bill(["hba1c"], {
        appointmentId: await appointment("Investigation"),
        visitType: "Follow Up",
      }),
    );
    expect([chosen.visit_type, chosen.lines[0].patient_payable]).toEqual(["Follow Up", 25000]);
  });

  test("15. a patient's facts come from the record; typed-in facts count only without a patient", async () => {
    await billRule({ name: "Seniors 10%", value: 10, min_age: 70 });
    const noDob = await addPatient();
    const typed = adds(await bill(["hba1c"], { patientId: noDob, patient: { age: 80 } }));
    expect(typed.patient).toMatchObject({ id: noDob, age: null, age_source: null });
    expect(typed.totals.bill_discount, "an unknown age matches no age rule").toBe(0);
    const recorded = await client
      .query(`INSERT INTO patients (name, age) VALUES ($1, 75) RETURNING id`, [`P315 ${tag}`])
      .then((r) => r.rows[0].id);
    const byRecord = adds(await bill(["hba1c"], { patientId: recorded }));
    expect(byRecord.patient).toMatchObject({ age: 75, age_source: "recorded_age" });
    expect(byRecord.totals.bill_discount).toBe(2500);
    const walkIn = adds(await bill(["hba1c"], { patient: { age: "72", gender: "f" } }));
    expect(walkIn.patient).toMatchObject({ id: null, age: 72, gender: "Female" });
    expect(walkIn.totals.bill_discount).toBe(2500);
    for (const patient of [{ age: "old" }, { age: -1 }, { age: 70.5 }, "72"]) {
      const error = await bill(["hba1c"], { patient }).catch((e) => e);
      expect(error, JSON.stringify(patient)).toMatchObject({ status: 400 });
      expect(error.line_no, "the patient's age isn't a line's fault").toBeUndefined();
      expect(error.message).not.toMatch(/^Line/);
    }
  });

  test("16. a 20-line bill reads each thing once", async () => {
    const twenty = [];
    for (let i = 0; i < 20; i++) {
      twenty.push(
        await client
          .query(
            `INSERT INTO service_items (code, name, subgroup_id, base_price, kind)
             VALUES ($1, $1, $2, $3, 'procedure') RETURNING id`,
            [`P315-T${i}-${T}`, ids.tests, 100 + i],
          )
          .then((r) => r.rows[0].id),
      );
    }
    await settings({ max_codes_per_bill: 5 });
    const patientId = await addPatient({ scheme_code: c("paid"), dob: "1950-01-01" });
    const seen = [];
    const counted = {
      query: (...args) => {
        seen.push(JSON.stringify(args));
        return client.query(...args);
      },
    };
    const priced = adds(
      await priceBill(
        {
          date: DAY,
          role: "reception",
          patientId,
          visitType: "Follow Up",
          codes: [`LAB10${T}`, `OPD50${T}`],
          lines: twenty.map((item) => ({ item })),
        },
        counted,
      ),
    );
    expect(priced.applied_codes.map((a) => a.code)).toEqual([`LAB10${T}`]);
    expect(priced.totals.discount).toBe(priced.lines.reduce((sum, l) => sum + l.discount, 0));
    expect(new Set(seen).size, "no query is repeated").toBe(seen.length);
    expect(seen.length, "queries for a 20-line bill").toBeLessThanOrEqual(20 * 4 + 15);
    test.info().annotations.push({ type: "queries", description: `20 lines: ${seen.length}` });
  });
});
