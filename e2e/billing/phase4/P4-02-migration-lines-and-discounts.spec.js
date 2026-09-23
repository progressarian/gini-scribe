import { test, expect } from "@playwright/test";
import {
  AUDIT_COLUMNS,
  HAS_COMMENTS,
  REFUSED,
  SEEDS_ROWS,
  allowedValuesOf,
  columnsOf,
  indexesOf,
  lockdownOf,
  openFreshCopy,
  readMigration,
  tablesCreatedBy,
} from "../../helpers/migration.mjs";

const SQL = readMigration("2026-10-17_billing_bills.sql");
const LINES = "bill_lines";
const DISCOUNTS = "bill_line_discounts";

const LINE_COLUMNS = [
  "id",
  "bill_id",
  "visit_id",
  "line_no",
  "service_item_id",
  "source",
  "lab_order_id",
  "doctor_id",
  "is_live",
  "repeat_request_id",
  "group_code",
  "subgroup_code",
  "item_code",
  "bill_code",
  "bill_name",
  "quantity",
  "base_rate",
  "rate",
  "listed_actual",
  "actual_amount",
  "listed_discount",
  "discount",
  "payable_discount",
  "bill_discount",
  "tax_code",
  "sac_hsn",
  "tax_rate_pct",
  "taxable",
  "cgst",
  "sgst",
  "payment_rule_id",
  "payment_rule",
  "patient_payable",
  "claim_amount",
  "adjustment_amount",
  ...AUDIT_COLUMNS,
];

const DISCOUNT_COLUMNS = [
  "id",
  "bill_line_id",
  "rule_id",
  "code",
  "method",
  "taken_from",
  "amount",
  "applied_by",
  ...AUDIT_COLUMNS,
];

let db = null;
const ids = {};
let lineNo = 0;

const addLine = `INSERT INTO bill_lines
  (bill_id, visit_id, line_no, service_item_id, source, lab_order_id, is_live, repeat_request_id,
   bill_name, quantity, rate, listed_actual, actual_amount, listed_discount, discount,
   payable_discount, bill_discount, tax_rate_pct, taxable, cgst, sgst, payment_rule_id,
   patient_payable, claim_amount, adjustment_amount)
  VALUES ($1, $2, $3, $4, COALESCE($5, 'added'), $6, COALESCE($7, TRUE), $8, COALESCE($9, 'Line'),
          COALESCE($10::numeric, 1), COALESCE($11::numeric, 0), COALESCE($12::numeric, 0),
          COALESCE($13::numeric, 0), COALESCE($14::numeric, 0), COALESCE($15::numeric, 0),
          COALESCE($16::numeric, 0), COALESCE($17::numeric, 0), $18::numeric,
          COALESCE($19::numeric, 0), COALESCE($20::numeric, 0), COALESCE($21::numeric, 0), $22,
          COALESCE($23::numeric, 0), COALESCE($24::numeric, 0), COALESCE($25::numeric, 0))`;

const nextItem = () => ids.items.pop();

const line = (o = {}) => [
  o.bill ?? ids.bill,
  o.visit ?? ids.visit,
  o.lineNo ?? ++lineNo,
  o.item ?? nextItem(),
  o.source ?? null,
  o.labOrder ?? null,
  o.live ?? null,
  o.repeat ?? null,
  o.name ?? null,
  o.quantity ?? null,
  o.rate ?? null,
  o.listedActual ?? null,
  o.actual ?? null,
  o.listedDiscount ?? null,
  o.discount ?? null,
  o.payableDiscount ?? null,
  o.billDiscount ?? null,
  o.taxRate ?? null,
  o.taxable ?? null,
  o.cgst ?? null,
  o.sgst ?? null,
  o.rule ?? null,
  o.payable ?? null,
  o.claim ?? null,
  o.adjustment ?? null,
];

const plain = (o = {}) => ({
  rate: 500,
  listedActual: 500,
  actual: 500,
  taxable: 500,
  payable: 500,
  ...o,
});

test.describe.serial("P4-02 migration: bill lines and their discounts", () => {
  test.beforeAll(async () => {
    db = await openFreshCopy(SQL);
    const { client } = db;
    const one = async (sql, params = []) => (await client.query(sql, params)).rows[0];
    ids.patient = (
      await one(`INSERT INTO patients (name) VALUES ('P402 Patient') RETURNING id`)
    ).id;
    ids.visit = (
      await one(`INSERT INTO giniflow_visits (patient_id) VALUES ($1) RETURNING id`, [ids.patient])
    ).id;
    ids.otherVisit = (
      await one(
        `INSERT INTO giniflow_visits (patient_id, visit_date)
         VALUES ($1, CURRENT_DATE - 1) RETURNING id`,
        [ids.patient],
      )
    ).id;
    ids.labOrder = (
      await one(`INSERT INTO giniflow_lab_orders (visit_id) VALUES ($1) RETURNING id`, [ids.visit])
    ).id;
    ids.bill = (
      await one(`INSERT INTO bills (patient_id, visit_id) VALUES ($1, $2) RETURNING id`, [
        ids.patient,
        ids.visit,
      ])
    ).id;
    ids.otherBill = (
      await one(`INSERT INTO bills (patient_id, visit_id) VALUES ($1, $2) RETURNING id`, [
        ids.patient,
        ids.otherVisit,
      ])
    ).id;
    ids.group = (
      await one(`INSERT INTO service_groups (code, name) VALUES ('P402-G', 'OPD') RETURNING id`)
    ).id;
    ids.subgroup = (
      await one(
        `INSERT INTO service_subgroups (group_id, code, name) VALUES ($1, 'P402-S', 'Consult') RETURNING id`,
        [ids.group],
      )
    ).id;
    const item = async (code, name) =>
      (
        await one(
          `INSERT INTO service_items (code, name, subgroup_id, base_price, kind)
           VALUES ($1, $2, $3, 500, 'procedure') RETURNING id`,
          [code, name, ids.subgroup],
        )
      ).id;
    ids.item = await item("P402-I", "Dressing");
    ids.otherItem = await item("P402-J", "Plaster");
    ids.items = (
      await client.query(
        `INSERT INTO service_items (code, name, subgroup_id, base_price, kind)
         SELECT 'P402-N' || n, 'Item ' || n, $1, 500, 'procedure' FROM generate_series(1, 80) AS n
         RETURNING id`,
        [ids.subgroup],
      )
    ).rows.map((r) => r.id);
    ids.rule = (
      await one(
        `INSERT INTO discount_rules (name, method, kind, value) VALUES ('P402 Ten', 'auto', 'percent', 10)
         RETURNING id`,
      )
    ).id;
    const repeatRequest = async (visit, item) =>
      (
        await one(
          `INSERT INTO billing_requests (kind, patient_id, visit_id, service_item_id, reason, status, decided_at)
           VALUES ('repeat_item', $1, $2, $3, 'Other knee', 'approved', NOW()) RETURNING id`,
          [ids.patient, visit, item],
        )
      ).id;
    ids.request = await repeatRequest(ids.visit, ids.item);
    ids.spareRequest = await repeatRequest(ids.visit, ids.item);
    ids.otherRequest = await repeatRequest(ids.otherVisit, ids.otherItem);
    ids.newItemRequest = (
      await one(
        `INSERT INTO billing_requests (kind, patient_id, visit_id, proposed_name, reason)
         VALUES ('new_item', $1, $2, 'Knee brace', 'Not on the list') RETURNING id`,
        [ids.patient, ids.visit],
      )
    ).id;
  });

  test.afterAll(async () => {
    await db?.close();
  });

  test("1. the file creates both tables, inserts no rows and has no comments", () => {
    expect(tablesCreatedBy(SQL)).toEqual(expect.arrayContaining([LINES, DISCOUNTS]));
    expect(SQL).not.toMatch(SEEDS_ROWS);
    expect(SQL).not.toMatch(HAS_COMMENTS);
  });

  test("2. it runs twice and both tables have exactly the planned columns", async () => {
    expect(await columnsOf(db.client, LINES)).toEqual([...LINE_COLUMNS].sort());
    expect(await columnsOf(db.client, DISCOUNTS)).toEqual([...DISCOUNT_COLUMNS].sort());
  });

  test("3. the same item can't be live twice on one visit, and line numbers don't repeat", async () => {
    const indexes = await indexesOf(db.client, [LINES, DISCOUNTS]);
    expect(indexes.bill_lines_live_item_key).toMatch(
      /UNIQUE INDEX .*\(visit_id, service_item_id\) WHERE \(is_live AND \(repeat_request_id IS NULL\)\)/,
    );
    expect(indexes.bill_lines_bill_line_no_key).toMatch(/UNIQUE INDEX .*\(bill_id, line_no\)/);
    expect(indexes.bill_lines_repeat_key, "one line per approval").toMatch(
      /UNIQUE INDEX .*\(repeat_request_id\) WHERE \(repeat_request_id IS NOT NULL\)/,
    );
    expect(indexes.bill_lines_visit_idx, "the counter reads a visit's lines").toMatch(
      /\(visit_id\)/,
    );
    expect(indexes.bill_lines_item_idx).toMatch(/\(service_item_id\)/);
    expect(indexes.bill_line_discounts_line_idx).toMatch(/\(bill_line_id\)/);
  });

  test("4. RLS is on and forced, and anon/authenticated have no access", async () => {
    const { rls, publicGrants } = await lockdownOf(db.client, [LINES, DISCOUNTS]);
    expect(rls.sort((a, b) => a.relname.localeCompare(b.relname))).toEqual([
      { relname: DISCOUNTS, relrowsecurity: true, relforcerowsecurity: true },
      { relname: LINES, relrowsecurity: true, relforcerowsecurity: true },
    ]);
    expect(publicGrants).toEqual([]);
  });

  test("5. no lines or line discounts are seeded", async () => {
    for (const table of [LINES, DISCOUNTS]) {
      expect(
        (await db.client.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n,
        table,
      ).toBe(0);
    }
  });

  test("6. the allowed values are the planned ones", async () => {
    expect(await allowedValuesOf(db.client, LINES, "source")).toEqual([
      "added",
      "lab_order",
      "visit",
    ]);
    expect(await allowedValuesOf(db.client, DISCOUNTS, "method")).toEqual(["auto", "code"]);
    expect(await allowedValuesOf(db.client, DISCOUNTS, "taken_from")).toEqual([
      "actual",
      "bill",
      "patient_payable",
    ]);
  });

  test("7. every shape of priced line the pricing can produce balances", async () => {
    const { refused } = db;
    const good = [
      ["a plain line the patient pays in full", plain({})],
      ["a line off a lab order", plain({ source: "lab_order", labOrder: ids.labOrder })],
      [
        "a line with a discount off the actual",
        {
          visit: ids.otherVisit,
          bill: ids.otherBill,
          rate: 500,
          listedActual: 500,
          actual: 500,
          listedDiscount: 50,
          discount: 50,
          taxable: 450,
          payable: 450,
        },
      ],
      [
        "a price that includes tax",
        {
          visit: ids.otherVisit,
          bill: ids.otherBill,
          rate: 118,
          listedActual: 118,
          actual: 100,
          taxRate: 18,
          taxable: 100,
          cgst: 9,
          sgst: 9,
          payable: 118,
        },
      ],
      [
        "a price that includes tax, discounted",
        {
          rate: 118,
          listedActual: 118,
          actual: 100,
          listedDiscount: 11.8,
          discount: 10,
          taxRate: 18,
          taxable: 90,
          cgst: 8.1,
          sgst: 8.1,
          payable: 106.2,
        },
      ],
      [
        "a payment-rule line with a step-8 discount off the patient payable",
        {
          rate: 1000,
          listedActual: 1000,
          actual: 1000,
          listedDiscount: 70,
          discount: 70,
          payableDiscount: 70,
          taxable: 1000,
          rule: 1,
          payable: 630,
          claim: 300,
        },
      ],
      [
        "a step-8 discount larger than the actual before tax",
        {
          rate: 118,
          listedActual: 118,
          actual: 100,
          listedDiscount: 110,
          discount: 110,
          payableDiscount: 110,
          taxRate: 18,
          taxable: 100,
          cgst: 9,
          sgst: 9,
          rule: 1,
          payable: 8,
        },
      ],
      [
        "a line carrying its share of a whole-bill discount",
        {
          rate: 1000,
          listedActual: 1000,
          actual: 1000,
          discount: 50,
          billDiscount: 50,
          taxable: 1000,
          payable: 950,
        },
      ],
      [
        "a line the category writes off",
        {
          rate: 500,
          listedActual: 500,
          actual: 500,
          taxable: 500,
          rule: 1,
          payable: 0,
          adjustment: 500,
        },
      ],
      [
        "a quantity of three",
        { quantity: 3, rate: 250, listedActual: 750, actual: 750, taxable: 750, payable: 750 },
      ],
    ];
    for (const [why, o] of good) expect(await refused(addLine, line(o)), why).toBeNull();
  });

  test("8. a line that doesn't balance is refused", async () => {
    const { refused } = db;
    const bad = [
      ["the patient pays more than the line comes to", plain({ payable: 501 })],
      ["a discount that goes nowhere", plain({ discount: 50, listedDiscount: 50 })],
      ["a claim that isn't in the total", plain({ claim: 100, rule: 1 })],
      [
        "tax that isn't split in half",
        {
          rate: 100,
          listedActual: 100,
          actual: 100,
          taxRate: 18,
          taxable: 100,
          cgst: 18,
          sgst: 0,
          payable: 118,
        },
      ],
      [
        "tax on a line with no tax rate",
        { rate: 100, listedActual: 100, actual: 100, taxable: 100, cgst: 9, sgst: 9, payable: 118 },
      ],
      ["an actual that isn't quantity times rate", plain({ quantity: 2, listedActual: 500 })],
      [
        "a payable discount bigger than the discount",
        {
          rate: 1000,
          listedActual: 1000,
          actual: 1000,
          listedDiscount: 70,
          discount: 70,
          payableDiscount: 100,
          taxable: 1000,
          rule: 1,
          payable: 600,
          claim: 300,
        },
      ],
      [
        "a bill share that isn't in the discount",
        {
          rate: 1000,
          listedActual: 1000,
          actual: 1000,
          billDiscount: 50,
          taxable: 1000,
          payable: 950,
        },
      ],
      [
        "a claim and a write-off on one line",
        {
          rate: 1000,
          listedActual: 1000,
          actual: 1000,
          taxable: 1000,
          rule: 1,
          payable: 0,
          claim: 500,
          adjustment: 500,
        },
      ],
      ["a claim on a line with no payment rule", plain({ payable: 400, claim: 100 })],
      [
        "a payable discount on a line with no payment rule",
        plain({ listedDiscount: 50, discount: 50, payableDiscount: 50, payable: 450 }),
      ],
      ["a lab order line with no lab order", plain({ source: "lab_order" })],
      ["an added line with a lab order", plain({ labOrder: ids.labOrder })],
      ["an unknown source", plain({ source: "pharmacy" })],
      ["a quantity of nothing", plain({ quantity: 0, listedActual: 0 })],
      ["a negative rate", plain({ rate: -500, listedActual: -500, actual: -500 })],
      ["a line number of zero", plain({ lineNo: 0 })],
      ["a blank name", plain({ name: " " })],
      ["a tax rate over 100", plain({ taxRate: 101 })],
    ];
    for (const [why, o] of bad) expect(await refused(addLine, line(o)), why).toBe(REFUSED.rule);

    expect(await refused(addLine, line(plain({ item: 0 }))), "an item that doesn't exist").toBe(
      REFUSED.missingParent,
    );
    expect(
      await refused(addLine, line(plain({ lineNo: 1 }))),
      "two lines numbered 1 on one bill",
    ).toBe(REFUSED.duplicate);
  });

  test("9. the same item can't be billed twice on a visit unless an admin approved it", async () => {
    const { refused } = db;
    const fresh = { visit: ids.visit, bill: ids.bill, item: ids.item };
    expect(await refused(addLine, line(plain(fresh))), "the first line").toBeNull();
    expect(
      await refused(addLine, line(plain(fresh))),
      "the same item live twice on one visit",
    ).toBe(REFUSED.duplicate);
    expect(
      await refused(addLine, line(plain({ ...fresh, live: false }))),
      "a cancelled second line",
    ).toBeNull();
    expect(
      await refused(addLine, line(plain({ ...fresh, repeat: ids.request }))),
      "an approved repeat",
    ).toBeNull();
    expect(
      await refused(addLine, line(plain({ ...fresh, repeat: ids.request }))),
      "the same approval used a second time",
    ).toBe(REFUSED.duplicate);
    expect(
      await refused(
        addLine,
        line(plain({ ...fresh, item: ids.otherItem, repeat: ids.spareRequest })),
      ),
      "an approval for one item used on another",
    ).toBe(REFUSED.missingParent);
    expect(
      await refused(
        addLine,
        line(plain({ ...fresh, item: ids.otherItem, repeat: ids.otherRequest })),
      ),
      "an approval given for another visit",
    ).toBe(REFUSED.missingParent);
    expect(
      await refused(addLine, line(plain({ ...fresh, repeat: ids.newItemRequest }))),
      "a new-item request used as a repeat approval",
    ).toBe(REFUSED.missingParent);
  });

  test("9a. a line belongs to the visit its own bill is for", async () => {
    expect(
      await db.refused(addLine, line(plain({ bill: ids.bill, visit: ids.otherVisit }))),
      "a line on this bill but another visit",
    ).toBe(REFUSED.missingParent);
  });

  test("10. a line discount records what it took and from where", async () => {
    const { client, refused } = db;
    const { rows } = await client.query(`SELECT id FROM bill_lines ORDER BY created_at LIMIT 1`);
    const lineId = rows[0].id;
    const add = `INSERT INTO bill_line_discounts (bill_line_id, rule_id, code, method, taken_from, amount)
      VALUES ($1, $2, $3, $4, COALESCE($5, 'actual'), $6)`;
    expect(await refused(add, [lineId, ids.rule, null, "auto", null, 50])).toBeNull();
    expect(
      await refused(add, [lineId, ids.rule, "P402CC10", "code", "patient_payable", 70]),
      "a code taken off the patient payable",
    ).toBeNull();
    expect(
      await refused(add, [lineId, ids.rule, null, "auto", "bill", 25]),
      "a share of a whole-bill discount",
    ).toBeNull();

    const bad = [
      ["a code with no code", [lineId, ids.rule, null, "code", null, 50]],
      ["an automatic rule carrying a code", [lineId, ids.rule, "X10", "auto", null, 50]],
      ["a discount of nothing", [lineId, ids.rule, null, "auto", null, 0]],
      ["a discount of less than nothing", [lineId, ids.rule, null, "auto", null, -5]],
      ["an unknown method", [lineId, ids.rule, null, "manual", null, 50]],
      ["an unknown source", [lineId, ids.rule, null, "auto", "thin_air", 50]],
    ];
    for (const [why, params] of bad) expect(await refused(add, params), why).toBe(REFUSED.rule);

    expect(
      await refused(`DELETE FROM discount_rules WHERE id = $1`, [ids.rule]),
      "a discount rule that has been used",
    ).toBe(REFUSED.stillUsed);
    expect(
      await refused(`DELETE FROM bill_lines WHERE id = $1`, [lineId]),
      "a line that carries a discount",
    ).toBe(REFUSED.stillUsed);
  });

  test("11. a bill, visit or item a line uses can't be deleted", async () => {
    const { refused } = db;
    expect(await refused(`DELETE FROM bills WHERE id = $1`, [ids.bill])).toBe(REFUSED.stillUsed);
    expect(await refused(`DELETE FROM giniflow_visits WHERE id = $1`, [ids.visit])).toBe(
      REFUSED.stillUsed,
    );
    expect(await refused(`DELETE FROM service_items WHERE id = $1`, [ids.item])).toBe(
      REFUSED.stillUsed,
    );
    expect(await refused(`DELETE FROM billing_requests WHERE id = $1`, [ids.request])).toBe(
      REFUSED.stillUsed,
    );
  });
});

test.describe.serial("P4-02 a whole priced bill fits the tables", () => {
  test("13. a bill straight out of priceBill saves, lines, steps and totals", async () => {
    const { priceBill } = await import("../../../server/services/billing/priceBill.js");
    const fresh = await openFreshCopy(SQL);
    try {
      const { client } = fresh;
      const one = async (sql, params = []) => (await client.query(sql, params)).rows[0];
      const patient = (await one(`INSERT INTO patients (name) VALUES ('P402 Bill') RETURNING id`))
        .id;
      const visit = (
        await one(`INSERT INTO giniflow_visits (patient_id) VALUES ($1) RETURNING id`, [patient])
      ).id;
      const doctor = (
        await one(`INSERT INTO doctors (name, role) VALUES ('P402 Dr', 'consultant') RETURNING id`)
      ).id;
      const group = (
        await one(`INSERT INTO service_groups (code, name) VALUES ('P402-BG', 'OPD') RETURNING id`)
      ).id;
      const subgroup = (
        await one(
          `INSERT INTO service_subgroups (group_id, code, name) VALUES ($1, 'P402-BS', 'Consult') RETURNING id`,
          [group],
        )
      ).id;
      const item = async (code, name, price, extra = "") =>
        (
          await one(
            `INSERT INTO service_items (code, name, subgroup_id, base_price, kind ${extra ? `, ${extra}` : ""})
             VALUES ($1, $2, $3, $4, 'procedure' ${extra ? `, TRUE, 5` : ""}) RETURNING id`,
            [code, name, subgroup, price],
          )
        ).id;
      const consult = await item("P402-BC", "Consultation (FU)", 1000);
      const dressing = await item("P402-BD", "Dressing", 250, "allow_quantity, max_quantity");
      const free = await item("P402-BF", "Counselling", 0);
      const lab = await item("P402-BL", "HbA1c", 250);
      await one(
        `INSERT INTO patient_schemes (code, label, payer_name) VALUES ('p402_bill', 'CGHS Paid', 'CGHS')`,
      );
      await one(
        `INSERT INTO category_payment_rules (scheme_code, name, service_item_id, patient_pays, patient_value)
         VALUES ('p402_bill', 'Paid consults', $1, 'amount', 700)`,
        [consult],
      );
      await one(
        `INSERT INTO discount_rules (name, code, method, kind, value, applies_on_scheme_rate)
         VALUES ('P402 Bill camp', 'P402BC10', 'code', 'percent', 10, TRUE)`,
      );
      await one(
        `INSERT INTO discount_rules (name, method, kind, value, applies_per)
         VALUES ('P402 Whole bill', 'auto', 'percent', 5, 'bill')`,
      );

      const priced = await priceBill(
        {
          patientId: patient,
          category: "p402_bill",
          doctorId: doctor,
          visitType: "Follow Up",
          role: "reception",
          codes: ["P402BC10"],
          lines: [
            { item: consult, quantity: 1 },
            { item: dressing, quantity: 3 },
            { item: free, quantity: 1 },
            { item: lab, quantity: 1 },
          ],
        },
        client,
      );
      const rupees = (paise) => (paise / 100).toFixed(2);
      const bill = await one(
        `INSERT INTO bills (patient_id, visit_id, scheme_code, payer_name, status, bill_no, series,
                            fy, finalised_at, actual_amount, discount_amount, tax_amount,
                            patient_payable, claim_amount, adjustment_amount, round_off, claim_status)
         VALUES ($1, $2, 'p402_bill', $3, 'final', 'P402/000009', 'MAIN', '2026-27', NOW(),
                 $4, $5, $6, $7, $8, $9, $10, CASE WHEN $8::numeric > 0 THEN 'pending' ELSE 'none' END)
         RETURNING id`,
        [
          patient,
          visit,
          priced.payer_name,
          rupees(priced.totals.actual),
          rupees(priced.totals.discount),
          rupees(priced.totals.tax),
          rupees(priced.totals.payable),
          rupees(priced.totals.claim),
          rupees(priced.totals.adjustment),
          rupees(priced.totals.round_off),
        ],
      );
      for (const line of priced.lines) {
        const saved = await one(
          `INSERT INTO bill_lines
             (bill_id, visit_id, line_no, service_item_id, source, doctor_id, group_code,
              subgroup_code, item_code, bill_code, bill_name, quantity, base_rate, rate,
              listed_actual, actual_amount, listed_discount, discount, payable_discount,
              bill_discount, tax_code, sac_hsn, tax_rate_pct, taxable, cgst, sgst,
              payment_rule_id, payment_rule, patient_payable, claim_amount, adjustment_amount)
           VALUES ($1, $2, $3, $4, 'visit', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
                   $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30)
           RETURNING id`,
          [
            bill.id,
            visit,
            line.line_no,
            line.item_id,
            line.doctor_id ?? doctor,
            line.group_code,
            line.subgroup_code,
            line.item_code,
            line.bill_code,
            line.bill_name,
            line.quantity,
            rupees(line.base_price),
            rupees(line.rate),
            rupees(line.listed_actual),
            rupees(line.actual),
            rupees(line.listed_discount),
            rupees(line.discount),
            rupees(line.payable_discount),
            rupees(line.bill_discount),
            line.tax_code?.code ?? null,
            line.tax_code?.sac_hsn ?? null,
            line.tax_code?.rate_pct ?? null,
            rupees(line.taxable),
            rupees(line.cgst),
            rupees(line.sgst),
            line.payment_rule_id,
            line.payment_rule_text,
            rupees(line.patient_payable),
            rupees(line.claim),
            rupees(line.adjustment),
          ],
        );
        const steps = [
          ...line.discounts.map((step) => ({ ...step, taken_from: step.taken_from })),
          ...line.bill_discounts.map((step) => ({ ...step, taken_from: "bill" })),
        ];
        for (const step of steps) {
          await client.query(
            `INSERT INTO bill_line_discounts (bill_line_id, rule_id, code, method, taken_from, amount)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [saved.id, step.rule_id, step.code, step.method, step.taken_from, rupees(step.amount)],
          );
        }
      }

      const back = await one(
        `SELECT b.actual_amount, b.patient_payable, b.claim_amount, b.round_off,
                count(l.*)::int AS lines,
                sum(l.patient_payable) AS line_payable,
                (SELECT count(*)::int FROM bill_line_discounts d
                  JOIN bill_lines bl ON bl.id = d.bill_line_id WHERE bl.bill_id = b.id) AS steps
           FROM bills b JOIN bill_lines l ON l.bill_id = b.id
          WHERE b.id = $1 GROUP BY b.id, b.actual_amount, b.patient_payable, b.claim_amount,
                b.round_off`,
        [bill.id],
      );
      expect(back.lines, "every line saved").toBe(4);
      expect(Number(back.steps), "every discount step saved").toBe(
        priced.lines.reduce((n, l) => n + l.discounts.length + l.bill_discounts.length, 0),
      );
      expect(Number(back.patient_payable) - Number(back.round_off)).toBeCloseTo(
        Number(back.line_payable),
        2,
      );
      expect(Number(back.claim_amount), "the CGHS share is claimed").toBeGreaterThan(0);
      expect(
        priced.lines.some((l) => l.actual === 0),
        "a ₹0 line is on the bill",
      ).toBe(true);
      expect(
        priced.lines.some((l) => l.bill_discount > 0),
        "a whole-bill share",
      ).toBe(true);
      expect(
        priced.lines.some((l) => l.payable_discount > 0),
        "a step-8 discount",
      ).toBe(true);
    } finally {
      await fresh.close();
    }
  });
});

test.describe.serial("P4-02 the priced line fits the table", () => {
  test("12. a line straight out of priceLine saves, and the usage count reads it back", async () => {
    const { priceLine } = await import("../../../server/services/billing/priceLine.js");
    const { ruleUsage } = await import("../../../server/services/billing/discountRules.js");
    const fresh = await openFreshCopy(SQL);
    try {
      const { client } = fresh;
      const one = async (sql, params = []) => (await client.query(sql, params)).rows[0];
      const patient = (await one(`INSERT INTO patients (name) VALUES ('P402 Priced') RETURNING id`))
        .id;
      const visit = (
        await one(`INSERT INTO giniflow_visits (patient_id) VALUES ($1) RETURNING id`, [patient])
      ).id;
      const doctor = (
        await one(
          `INSERT INTO doctors (name, role) VALUES ('P402 Doctor', 'consultant') RETURNING id`,
        )
      ).id;
      const group = (
        await one(`INSERT INTO service_groups (code, name) VALUES ('P402-PG', 'OPD') RETURNING id`)
      ).id;
      const subgroup = (
        await one(
          `INSERT INTO service_subgroups (group_id, code, name) VALUES ($1, 'P402-PS', 'Consult') RETURNING id`,
          [group],
        )
      ).id;
      const item = (
        await one(
          `INSERT INTO service_items (code, name, subgroup_id, base_price, kind)
           VALUES ('P402-PI', 'Consultation', $1, 1000, 'procedure') RETURNING id`,
          [subgroup],
        )
      ).id;
      await one(
        `INSERT INTO patient_schemes (code, label, payer_name) VALUES ('p402_cghs', 'CGHS P402', 'CGHS')`,
      );
      const rule = (
        await one(
          `INSERT INTO category_payment_rules (scheme_code, name, service_item_id, patient_pays, patient_value)
           VALUES ('p402_cghs', 'CGHS Paid consultation', $1, 'amount', 700) RETURNING id`,
          [item],
        )
      ).id;
      const discount = (
        await one(
          `INSERT INTO discount_rules (name, code, method, kind, value, applies_on_scheme_rate)
           VALUES ('P402 Camp code', 'P402CC10', 'code', 'percent', 10, TRUE) RETURNING id`,
        )
      ).id;

      const bill = await one(
        `INSERT INTO bills (patient_id, visit_id, scheme_code, status, bill_no, series, fy, finalised_at)
           VALUES ($1, $2, 'p402_cghs', 'final', 'P402/000001', 'MAIN', '2026-27', NOW()) RETURNING id, bill_date`,
        [patient, visit],
      );

      const priced = await priceLine(
        { item, quantity: 1, category: "p402_cghs", codes: ["P402CC10"], role: "reception" },
        client,
      );
      expect(priced.patient_payable, "₹700 less the 10% camp code").toBe(63000);
      expect(priced.claim).toBe(30000);
      const rupees = (paise) => (paise / 100).toFixed(2);
      const saved = await one(
        `INSERT INTO bill_lines
           (bill_id, visit_id, line_no, service_item_id, source, doctor_id, group_code,
            subgroup_code, item_code, bill_code, bill_name, quantity, base_rate, rate,
            listed_actual, actual_amount, listed_discount, discount, payable_discount, tax_code,
            tax_rate_pct, taxable, cgst, sgst, payment_rule_id, payment_rule, patient_payable,
            claim_amount, adjustment_amount)
         VALUES ($1, $2, 1, $3, 'visit', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
                 $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27)
         RETURNING id`,
        [
          bill.id,
          visit,
          item,
          doctor,
          priced.group_code,
          priced.subgroup_code,
          priced.item_code,
          priced.bill_code,
          priced.bill_name,
          priced.quantity,
          rupees(priced.base_price),
          rupees(priced.rate),
          rupees(priced.listed_actual),
          rupees(priced.actual),
          rupees(priced.listed_discount),
          rupees(priced.discount),
          rupees(priced.payable_discount),
          priced.tax_code?.code ?? null,
          priced.tax_code?.rate_pct ?? null,
          rupees(priced.taxable),
          rupees(priced.cgst),
          rupees(priced.sgst),
          rule,
          priced.payment_rule_text,
          rupees(priced.patient_payable),
          rupees(priced.claim),
          rupees(priced.adjustment),
        ],
      );
      for (const step of priced.discounts) {
        await client.query(
          `INSERT INTO bill_line_discounts (bill_line_id, rule_id, code, method, taken_from, amount)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            saved.id,
            step.rule_id,
            step.method === "code" ? "P402CC10" : null,
            step.method,
            step.taken_from,
            rupees(step.amount),
          ],
        );
      }
      expect(priced.discounts).toHaveLength(1);

      expect(
        await ruleUsage(discount, { patientId: patient, date: bill.bill_date }, client),
        "the discount usage query reads the new tables by their own column names",
      ).toEqual({ total: 1, patient: 1, day: 1, doctor_day: 0 });
      expect(await ruleUsage(discount, { date: bill.bill_date, doctorId: doctor }, client)).toEqual(
        {
          total: 1,
          patient: 0,
          day: 1,
          doctor_day: 1,
        },
      );
    } finally {
      await fresh.close();
    }
  });
});
