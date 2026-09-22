import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../../helpers/db.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { repoRoot } from "../../setup/testEnv.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { LATER_SHEETS } from "../../../server/services/billing/importColumns.js";
import { templateBuffer } from "../../../server/services/billing/importTemplate.js";
import { indiaToday } from "../../../server/services/billing/categoryResolver.js";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const { commitUpload: commitWith } =
  await import("../../../server/services/billing/importCommit.js");
const { previewUpload: previewWith } =
  await import("../../../server/services/billing/importPreview.js");
const { saveConsultantFee } = await import("../../../server/services/billing/consultantFees.js");
const commitUpload = (buffer, input) => commitWith(buffer, input, getPool());
const previewUpload = (buffer) => previewWith(buffer, getPool());
const ExcelJS = createRequire(path.join(repoRoot, "server", "package.json"))("exceljs");

const tag = crypto.randomBytes(3).toString("hex");
const T = tag.toUpperCase();
const G = `P322G_${T}`;
const PROC = `P322S_PROC_${T}`;
const OPD = `P322S_OPD_${T}`;
const DRESS = `P322-DRESS_${T}`;
const KIT = `P322-KIT_${T}`;
const NEW_FEE = `P322-NEW_${T}`;
const FU_FEE = `P322-FU_${T}`;
const TOP = `p322_${tag}`;
const SUB = `p322_sub_${tag}`;
const NOPAY = `p322_nopay_${tag}`;
const DOCTOR = `Dr P322 A ${tag}`;
const LONER = `Dr P322 B ${tag}`;
const TWIN = `Dr P322 Twin ${tag}`;
const BILL = `P322F${T}`;
const STAFF = `P322S${T}`;
const ctx = { actorId: USERS.reception_admin.id, ip: "127.0.0.1" };
const fileName = (name) => `p322-${name}-${tag}.xlsx`;
const doctors = {};

async function workbook(sheets) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await templateBuffer({ examples: false }));
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = wb.getWorksheet(name);
    const headers = ws.getRow(1).values.slice(1);
    for (const cells of rows) {
      for (const column of Object.keys(cells)) {
        expect(headers, `${name} has a ${column} column`).toContain(column);
      }
      ws.addRow(headers.map((h) => cells[h] ?? null));
    }
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const MASTER = () => ({
  Groups: [{ group_code: G, name: `P322 Group ${T}` }],
  Subgroups: [
    { subgroup_code: PROC, group_code: G, name: `P322 Procedures ${T}` },
    { subgroup_code: OPD, group_code: G, name: `P322 Consultations ${T}` },
  ],
  Items: [
    {
      item_code: DRESS,
      name: `P322 Dressing ${T}`,
      subgroup_code: PROC,
      base_price: 300,
      kind: "procedure",
    },
    { item_code: KIT, name: `P322 Kit ${T}`, subgroup_code: PROC, base_price: 90, kind: "other" },
    {
      item_code: NEW_FEE,
      name: `P322 New consult ${T}`,
      subgroup_code: OPD,
      base_price: 1000,
      kind: "consultation",
      doctor: DOCTOR,
      visit_type: "New",
    },
    {
      item_code: FU_FEE,
      name: `P322 Follow-up consult ${T}`,
      subgroup_code: OPD,
      base_price: 700,
      kind: "consultation",
      doctor: String(doctors.a),
      visit_type: "Follow Up",
    },
  ],
  Categories: [
    { category_code: TOP, label: `P322 Scheme ${T}`, payer_name: "P322 Payer" },
    { category_code: SUB, label: "P322 Paid", parent_code: TOP },
  ],
});

const RULES = () => [
  {
    category_code: SUB,
    rule_name: "Procedures 20%",
    subgroup_code: PROC,
    visit_types: "Follow Up, New",
    patient_pays: "percent",
    patient_value: 20,
    remainder: "claim",
  },
  {
    category_code: TOP.toUpperCase(),
    rule_name: "Kit free",
    item_code: KIT.toLowerCase(),
    patient_pays: "nothing",
    remainder: "adjustment",
    valid_from: "2026-10-01",
    priority: 10,
  },
];

const FEES = () => [
  {
    doctor: DOCTOR,
    category_code: SUB,
    fee: 800,
    patient_pays: "amount",
    patient_value: 200,
    remainder: "claim",
    bill_code: BILL,
  },
];

const DISCOUNTS = () => [
  {
    rule_name: `P322 Staff ${T}`,
    code: STAFF,
    method: "code",
    kind: "percent",
    value: 10,
    max_discount: 100,
    groups: G,
    doctors: `${DOCTOR}, ${doctors.b}`,
    visit_types: "New",
    categories: `general, ${TOP}`,
    max_uses_per_day: 5,
    max_uses_per_doctor_per_day: 2,
    allowed_roles: "admin, reception_admin",
  },
  {
    rule_name: `P322 Senior ${T}`,
    method: "auto",
    kind: "flat",
    value: 50,
    min_age: 60,
    active: "no",
  },
];

const FULL = () => ({
  ...MASTER(),
  "Payment rules": RULES(),
  "Consultant fees": FEES(),
  Discounts: DISCOUNTS(),
});

const sheetOf = (preview, name) => preview.sheets.find((s) => s.name === name);
const errorsOf = (preview, name) =>
  sheetOf(preview, name)
    .rows.filter((r) => r.status === "error")
    .map((r) => r.errors.map((e) => `${e.column}: ${e.message}`).join(" | "));

const rulesOf = async (codes) =>
  (
    await query(
      `SELECT r.scheme_code, r.name, i.code AS item, sg.code AS subgroup, r.visit_types,
              r.patient_pays, r.patient_value::float8 AS value, r.remainder,
              r.valid_from::text AS valid_from, r.valid_to::text AS valid_to, r.priority,
              r.is_active
         FROM category_payment_rules r
         LEFT JOIN service_items i ON i.id = r.service_item_id
         LEFT JOIN service_subgroups sg ON sg.id = r.subgroup_id
        WHERE r.scheme_code = ANY($1::text[])
        ORDER BY r.scheme_code, r.name`,
      [codes],
    )
  ).rows;

const discountsOf = async () =>
  (
    await query(
      `SELECT d.name, d.code, d.method, d.kind, d.value::float8 AS value,
              d.max_discount::float8 AS max_discount,
              (SELECT array_agg(g.code) FROM service_groups g WHERE g.id = ANY(d.group_ids)) AS groups,
              d.doctor_ids, d.visit_types, d.scheme_codes, d.min_age,
              d.valid_from::text AS valid_from, d.max_uses_per_day, d.max_uses_per_doctor_per_day,
              d.allowed_roles, d.is_active
         FROM discount_rules d WHERE d.name LIKE $1 ORDER BY d.name`,
      [`P322 %${T}`],
    )
  ).rows;

async function cleanUp() {
  await query(`UPDATE discount_rules SET is_active = FALSE WHERE name LIKE 'P322 %'`);
  await query(`DELETE FROM discount_rules WHERE name LIKE 'P322 %'`);
  await query(`DELETE FROM category_payment_rules WHERE scheme_code LIKE 'p322%'`);
  await query(`DELETE FROM category_item_rates WHERE scheme_code LIKE 'p322%'`);
  await query(`DELETE FROM category_rules WHERE scheme_code LIKE 'p322%'`);
  await query(`DELETE FROM patient_schemes WHERE parent_code LIKE 'p322%'`);
  await query(`DELETE FROM patient_schemes WHERE code LIKE 'p322%'`);
  await query(
    `DELETE FROM service_item_price_history WHERE service_item_id IN
       (SELECT id FROM service_items WHERE code ILIKE 'P322-%')`,
  );
  await query(`DELETE FROM service_items WHERE code ILIKE 'P322-%'`);
  await query(`DELETE FROM service_subgroups WHERE code ILIKE 'P322S%'`);
  await query(`DELETE FROM service_groups WHERE code ILIKE 'P322G%'`);
  await query(`DELETE FROM doctors WHERE name LIKE 'Dr P322 %'`);
}

test.describe
  .serial("P3-22 switch on the Payment rules, Consultant fees and Discounts sheets", () => {
  test.beforeAll(async () => {
    await cleanUp();
    const add = async (name) =>
      (
        await one(
          `INSERT INTO doctors (name, role, is_active) VALUES ($1, 'consultant', TRUE) RETURNING id`,
          [name],
        )
      ).id;
    doctors.a = await add(DOCTOR);
    doctors.b = await add(LONER);
    doctors.twin1 = await add(TWIN);
    doctors.twin2 = await add(TWIN);
  });

  test.afterAll(cleanUp);

  test("1. the three sheets are switched on in the template and read on upload", async () => {
    expect(LATER_SHEETS).toEqual([]);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await templateBuffer());
    for (const name of ["Payment rules", "Consultant fees", "Discounts"]) {
      const ws = wb.getWorksheet(name);
      expect(ws.properties.tabColor ?? null, `${name} tab`).toBeNull();
      expect(ws.getCell("A1").note ?? null, `${name} note`).toBeNull();
    }
    const readme = [];
    wb.getWorksheet("Read me").eachRow((row) => readme.push(row.values.slice(1).join(" ")));
    expect(readme.join("\n")).not.toContain("available after Phase 3");
    const committed = new ExcelJS.Workbook();
    await committed.xlsx.load(
      fs.readFileSync(path.join(repoRoot, "docs", "gini-flow", "billing-template.xlsx")),
    );
    expect(committed.getWorksheet("Discounts").properties.tabColor ?? null).toBeNull();
  });

  test("2. a workbook with all three sheets previews and imports, audited under the import", async () => {
    const file = await workbook(FULL());
    const preview = await previewUpload(file);
    expect(preview.problems).toEqual([]);
    expect(
      preview.sheets.flatMap((s) => s.rows.filter((r) => r.errors.length).map((r) => r.errors)),
    ).toEqual([]);
    expect(preview.canImport).toBe(true);
    const counts = (p) => Object.fromEntries(p.sheets.map((s) => [s.name, s.counts.new]));
    expect(counts(preview)).toMatchObject({
      "Payment rules": 2,
      "Consultant fees": 1,
      Discounts: 2,
    });
    expect(sheetOf(preview, "Discounts").later).toBe(false);

    const saved = await commitUpload(file, { fileName: fileName("full"), ctx });
    expect(saved.saved).toBe(true);
    const today = indiaToday();
    expect(await rulesOf([TOP, SUB])).toEqual([
      {
        scheme_code: TOP,
        name: "Kit free",
        item: KIT,
        subgroup: null,
        visit_types: null,
        patient_pays: "nothing",
        value: null,
        remainder: "adjustment",
        valid_from: "2026-10-01",
        valid_to: null,
        priority: 10,
        is_active: true,
      },
      {
        scheme_code: SUB,
        name: `P322 Follow-up consult ${T}`,
        item: FU_FEE,
        subgroup: null,
        visit_types: null,
        patient_pays: "amount",
        value: 200,
        remainder: "claim",
        valid_from: today,
        valid_to: null,
        priority: 100,
        is_active: true,
      },
      {
        scheme_code: SUB,
        name: `P322 New consult ${T}`,
        item: NEW_FEE,
        subgroup: null,
        visit_types: null,
        patient_pays: "amount",
        value: 200,
        remainder: "claim",
        valid_from: today,
        valid_to: null,
        priority: 100,
        is_active: true,
      },
      {
        scheme_code: SUB,
        name: "Procedures 20%",
        item: null,
        subgroup: PROC,
        visit_types: ["New", "Follow Up"],
        patient_pays: "percent",
        value: 20,
        remainder: "claim",
        valid_from: today,
        valid_to: null,
        priority: 100,
        is_active: true,
      },
    ]);
    const rates = await query(
      `SELECT i.code, r.rate::float8 AS rate, r.bill_code, r.valid_from::text AS valid_from
         FROM category_item_rates r JOIN service_items i ON i.id = r.service_item_id
        WHERE r.scheme_code = $1 ORDER BY i.code`,
      [SUB],
    );
    expect(rates.rows).toEqual([
      { code: FU_FEE, rate: 800, bill_code: BILL, valid_from: today },
      { code: NEW_FEE, rate: 800, bill_code: BILL, valid_from: today },
    ]);
    const [senior, staff] = await discountsOf();
    expect(staff).toMatchObject({
      code: STAFF,
      method: "code",
      kind: "percent",
      value: 10,
      max_discount: 100,
      groups: [G],
      doctor_ids: [doctors.a, doctors.b],
      visit_types: ["New"],
      scheme_codes: ["general", TOP],
      valid_from: today,
      max_uses_per_day: 5,
      max_uses_per_doctor_per_day: 2,
      allowed_roles: ["reception_admin", "admin"],
      is_active: true,
    });
    expect(senior).toMatchObject({
      code: null,
      method: "auto",
      kind: "flat",
      value: 50,
      min_age: 60,
      allowed_roles: null,
      is_active: false,
    });
    const audit = await query(
      `SELECT entity, action, count(*)::int AS n FROM billing_audit WHERE import_id = $1
        GROUP BY entity, action ORDER BY entity, action`,
      [saved.importId],
    );
    expect(audit.rows).toEqual(
      expect.arrayContaining([
        { entity: "category_item_rates", action: "create", n: 2 },
        { entity: "category_payment_rules", action: "create", n: 4 },
        { entity: "discount_rules", action: "create", n: 2 },
      ]),
    );
    const imported = await one(`SELECT counts FROM billing_imports WHERE id = $1`, [
      saved.importId,
    ]);
    expect(imported.counts).toMatchObject({
      "Payment rules": { new: 2 },
      "Consultant fees": { new: 1 },
      Discounts: { new: 2 },
    });
  });

  test("3. the same file again is unchanged on every sheet and saves nothing", async () => {
    const result = await commitUpload(await workbook(FULL()), {
      fileName: fileName("again"),
      ctx,
    });
    expect(result.saved).toBe(false);
    for (const name of ["Payment rules", "Consultant fees", "Discounts"]) {
      const sheet = sheetOf(result.preview, name);
      expect(
        sheet.rows.map((r) => [r.status, r.changes]),
        name,
      ).toEqual(sheet.rows.map(() => ["unchanged", []]));
    }
  });

  test("4. a bad row on each sheet is reported readably and blocks the save", async () => {
    const before = [await rulesOf([TOP, SUB]), await discountsOf()];
    const file = await workbook({
      "Payment rules": [
        ...RULES(),
        {
          category_code: SUB,
          rule_name: "Two scopes",
          group_code: G,
          item_code: DRESS,
          patient_pays: "full",
          remainder: "claim",
        },
      ],
      "Consultant fees": [
        ...FEES(),
        {
          doctor: LONER,
          visit_type: "New",
          category_code: SUB,
          fee: 500,
          patient_pays: "nothing",
          remainder: "claim",
        },
      ],
      Discounts: [
        ...DISCOUNTS(),
        {
          rule_name: `P322 Clash ${T}`,
          code: BILL.toLowerCase(),
          method: "code",
          kind: "flat",
          value: 20,
        },
      ],
    });
    const preview = await previewUpload(file);
    expect(preview.canImport).toBe(false);
    expect(errorsOf(preview, "Payment rules")).toEqual([
      "group_code: Choose one of a group, a subgroup or an item — or none, for the whole category",
    ]);
    expect(errorsOf(preview, "Consultant fees")).toEqual([
      `visit_type: ${LONER} has no active New consultation item; create it first on the Services or Consultant fees page (or on the Items sheet of this file), then upload again`,
    ]);
    expect(errorsOf(preview, "Discounts")).toEqual([
      `code: ${BILL} is already the bill code of P322 Follow-up consult ${T} for P322 Scheme ${T} › P322 Paid; choose another discount code`,
    ]);
    const result = await commitUpload(file, { fileName: fileName("bad"), ctx });
    expect(result.saved).toBe(false);
    expect(result.preview.counts.error).toBe(3);
    expect([await rulesOf([TOP, SUB]), await discountsOf()]).toEqual(before);
    expect(
      (await query(`SELECT 1 FROM billing_imports WHERE file_name = $1`, [fileName("bad")])).rows,
    ).toEqual([]);
  });

  test("5. an amount above a covered item's price is refused on its row, in the preview and the save", async () => {
    const file = await workbook({
      "Payment rules": [
        {
          category_code: TOP,
          rule_name: "Procedures ₹400",
          subgroup_code: PROC,
          patient_pays: "amount",
          patient_value: 400,
          remainder: "claim",
        },
      ],
    });
    const preview = await previewUpload(file);
    expect(preview.canImport).toBe(false);
    expect(preview.problems).toEqual([]);
    const [message] = errorsOf(preview, "Payment rules");
    expect(message).toBe(
      `patient_value: The patient can't pay ₹400 for items that cost less: P322 Kit ${T} (₹90), P322 Dressing ${T} (₹300). Lower the amount, or put the rule on only the items it is meant for.`,
    );
    await expect(commitUpload(file, { fileName: fileName("cheap"), ctx })).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("This price is too low for a payment rule"),
    });
    expect((await rulesOf([TOP])).map((r) => r.name)).toEqual(["Kit free"]);

    const fee = await workbook({
      "Consultant fees": [{ ...FEES()[0], patient_value: 900 }],
    });
    expect(errorsOf(await previewUpload(fee), "Consultant fees")).toEqual([
      [
        `patient_value: The patient can't pay ₹900 for P322 New consult ${T} in P322 Scheme ${T} › P322 Paid: the fee there is ₹800. Lower the amount, or raise the fee.`,
        `patient_value: The patient can't pay ₹900 for P322 Follow-up consult ${T} in P322 Scheme ${T} › P322 Paid: the fee there is ₹800. Lower the amount, or raise the fee.`,
      ].join(" | "),
    ]);
  });

  test("6. payment rule rows get the payment rules service's checks", async () => {
    await query(`UPDATE service_items SET is_active = FALSE WHERE code = $1`, [KIT]);
    const rows = [
      ["percent over 100", { patient_pays: "percent", patient_value: 120 }],
      ["full with a value", { patient_pays: "full", patient_value: 10 }],
      ["amount without a value", { patient_pays: "amount" }],
      ["dates the wrong way", { valid_from: "2026-10-02", valid_to: "2026-10-01" }],
      ["no payer", { category_code: NOPAY }],
      ["deactivated item", { item_code: KIT }],
      ["unknown group", { group_code: `P322_NONE_${T}` }],
      ["general", { category_code: "general" }],
    ].map(([rule_name, extra]) => ({
      category_code: SUB,
      rule_name,
      patient_pays: "nothing",
      remainder: "claim",
      ...extra,
    }));
    const preview = await previewUpload(
      await workbook({
        Categories: [{ category_code: NOPAY, label: `P322 No payer ${T}` }],
        "Payment rules": [
          ...rows,
          { ...rows[0], rule_name: "PERCENT OVER 100", patient_value: 10 },
        ],
      }),
    );
    await query(`UPDATE service_items SET is_active = TRUE WHERE code = $1`, [KIT]);
    expect(errorsOf(preview, "Payment rules")).toEqual([
      `category_code: ${SUB} + percent over 100 is also on row 10; each category_code + rule_name can appear only once | patient_value: The percent must be from 0 to 100`,
      'patient_value: A "full" rule takes no value; only amount and percent rules do',
      "patient_value: Enter the amount in rupees the patient pays",
      "valid_to: To date can't be before the From date",
      `remainder: P322 No payer ${T} has no payer name, so there is no one to claim the rest from. Add a payer name to the category, or send the rest to adjustment.`,
      `item_code: The item P322 Kit ${T} is deactivated`,
      `group_code: There is no group P322_NONE_${T}, in this file or in Scribe`,
      "category_code: There is no category general, in this file or in Scribe",
      `category_code: ${SUB} + PERCENT OVER 100 is also on row 2; each category_code + rule_name can appear only once`,
    ]);
  });

  test("7. consultant fee rows: doctor by name or id, ambiguous names refused, General refused", async () => {
    const fee = FEES()[0];
    const preview = await previewUpload(
      await workbook({
        "Consultant fees": [
          { ...fee, doctor: TWIN },
          { ...fee, category_code: "general" },
          { ...fee, doctor: `Dr Nobody ${tag}` },
          { ...fee, doctor: String(doctors.a), visit_type: "New" },
          { ...fee, category_code: NOPAY },
          fee,
        ],
      }),
    );
    expect(errorsOf(preview, "Consultant fees")).toEqual([
      `doctor: 2 doctors are called "${TWIN}"; write the doctor's id instead (${doctors.twin1} or ${doctors.twin2})`,
      "category_code: The General fee is the consultation item's own price; change it on the Items sheet or the Services page",
      `doctor: There is no doctor called "Dr Nobody ${tag}" in Scribe`,
      `doctor: ${DOCTOR} (New) in ${SUB} is also on row 7; each doctor + visit_type + category_code can appear only once`,
      `category_code: There is no category ${NOPAY}, in this file or in Scribe`,
      `doctor: ${DOCTOR} (New) in ${SUB} is also on row 5; each doctor + visit_type + category_code can appear only once`,
    ]);
  });

  test("8. discount rows get the discount service's checks, with codes checked against the file too", async () => {
    const base = { method: "code", kind: "flat", value: 20 };
    const rows = [
      { rule_name: `P322 D1 ${T}`, ...base, code: `P322A${T}`, kind: "percent", value: 0 },
      { rule_name: `P322 D2 ${T}`, ...base, method: "auto", code: `P322X${T}` },
      { rule_name: `P322 D3 ${T}`, ...base, method: "auto", code: null, allowed_roles: "admin" },
      {
        rule_name: `P322 D4 ${T}`,
        ...base,
        code: `P322B${T}`,
        categories: `${TOP}, ${SUB.toUpperCase()}`,
      },
      { rule_name: `P322 D5 ${T}`, ...base, code: `P322C${T}`, max_uses_per_day: 0 },
      { rule_name: `P322 D6 ${T}`, ...base, code: `P322R${T}` },
      { rule_name: `P322 D7 ${T}`, ...base, code: `p322c${tag}` },
      { rule_name: `P322 D8 ${T}`, ...base, code: STAFF },
      { rule_name: `P322 D9 ${T}`, ...base, code: `P322D${T}`, doctors: TWIN },
      { rule_name: `P322 D10 ${T}`, ...base, code: `P322E${T}`, max_discount: 10 },
    ];
    const preview = await previewUpload(
      await workbook({
        "Category rates": [
          {
            category_code: SUB,
            item_code: DRESS,
            valid_from: "2026-11-01",
            bill_code: `P322R${T}`,
          },
        ],
        Discounts: rows,
      }),
    );
    expect(errorsOf(preview, "Discounts")).toEqual([
      "value: A 0% discount takes nothing off; enter more than 0",
      "code: An automatic discount applies by itself, so it has no code; leave the code empty",
      "allowed_roles: An automatic discount applies by itself, so no desk role enters it; leave the roles empty",
      `categories: P322 Scheme ${T} already covers its sub-categories, so P322 Scheme ${T} › P322 Paid is already included; choose the category or its sub-categories, not both`,
      `code: P322C${T} is also on row 8; each code can appear only once | max_uses_per_day: max_uses_per_day must be 1 or more; leave it blank for no limit`,
      `code: P322R${T} is already the bill code of P322 Dressing ${T} for P322 Scheme ${T} › P322 Paid; choose another discount code`,
      `code: p322c${tag} is also on row 6; each code can appear only once`,
      `code: The discount "P322 Staff ${T}" already uses the code ${STAFF}`,
      `doctors: 2 doctors are called "${TWIN}"; write the doctor's id instead (${doctors.twin1} or ${doctors.twin2})`,
      "max_discount: Only a percent discount can have a largest discount",
    ]);
    expect(errorsOf(preview, "Category rates")).toEqual([
      `bill_code: P322R${T} is already the code of the discount "P322 D6 ${T}"; choose another bill code`,
    ]);
  });

  test("9. changed rows are updates: the fee keeps its start date and its rule, and a second upload is unchanged", async () => {
    const changed = () => ({
      "Payment rules": [{ ...RULES()[0], patient_value: 25 }, RULES()[1]],
      "Consultant fees": [{ ...FEES()[0], fee: 900, patient_value: 250 }],
      Discounts: [{ ...DISCOUNTS()[0], value: 15, max_uses_per_day: "" }, DISCOUNTS()[1]],
    });
    const preview = await previewUpload(await workbook(changed()));
    expect(preview.canImport).toBe(true);
    const statuses = (name) => sheetOf(preview, name).rows.map((r) => r.status);
    expect(statuses("Payment rules")).toEqual(["update", "unchanged"]);
    expect(statuses("Consultant fees")).toEqual(["update"]);
    expect(statuses("Discounts")).toEqual(["update", "unchanged"]);
    expect(sheetOf(preview, "Payment rules").rows[0].changes).toEqual([
      { column: "patient_value", from: 20, to: 25 },
    ]);
    expect(sheetOf(preview, "Consultant fees").rows[0].changes).toEqual([
      { column: "fee", from: 800, to: 900 },
      { column: "patient_value", from: 200, to: 250 },
    ]);
    expect(sheetOf(preview, "Discounts").rows[0].changes).toEqual([
      { column: "value", from: 10, to: 15 },
      { column: "max_uses_per_day", from: 5, to: null },
    ]);

    const saved = await commitUpload(await workbook(changed()), {
      fileName: fileName("changed"),
      ctx,
    });
    expect(saved.saved).toBe(true);
    const today = indiaToday();
    const rules = await rulesOf([SUB]);
    expect(rules.map((r) => [r.name, r.value, r.valid_from])).toEqual([
      [`P322 Follow-up consult ${T}`, 250, today],
      [`P322 New consult ${T}`, 250, today],
      ["Procedures 20%", 25, today],
    ]);
    const rates = await query(
      `SELECT rate::float8 AS rate, valid_from::text AS valid_from FROM category_item_rates
        WHERE scheme_code = $1 ORDER BY service_item_id`,
      [SUB],
    );
    expect(rates.rows).toEqual([
      { rate: 900, valid_from: today },
      { rate: 900, valid_from: today },
    ]);
    const [, staff] = await discountsOf();
    expect([staff.value, staff.max_uses_per_day]).toEqual([15, null]);
    const audit = await query(
      `SELECT entity, action, count(*)::int AS n FROM billing_audit WHERE import_id = $1
        GROUP BY entity, action ORDER BY entity, action`,
      [saved.importId],
    );
    expect(audit.rows).toEqual([
      { entity: "billing_imports", action: "import", n: 1 },
      { entity: "category_item_rates", action: "update", n: 2 },
      { entity: "category_payment_rules", action: "update", n: 3 },
      { entity: "discount_rules", action: "update", n: 1 },
    ]);

    const again = await commitUpload(await workbook(changed()), {
      fileName: fileName("changed-again"),
      ctx,
    });
    expect(again.saved).toBe(false);
    expect(again.preview.counts).toMatchObject({ new: 0, update: 0, error: 0, unchanged: 5 });
  });

  test("10. a fee from a later start date ends the current rule and adds a new one", async () => {
    const file = await workbook({
      "Consultant fees": [
        {
          ...FEES()[0],
          visit_type: "New",
          fee: 900,
          patient_pays: "nothing",
          patient_value: null,
          valid_from: "2027-01-01",
        },
      ],
    });
    const preview = await previewUpload(file);
    const [row] = sheetOf(preview, "Consultant fees").rows;
    expect(row.status).toBe("update");
    expect(row.warnings.map((w) => w.message)).toEqual([
      `The rate from ${indiaToday()} in Scribe will end on 2026-12-31`,
    ]);
    const saved = await commitUpload(file, { fileName: fileName("later"), ctx });
    expect(saved.saved).toBe(true);
    const rules = (await rulesOf([SUB])).filter((r) => r.item === NEW_FEE);
    expect(rules.map((r) => [r.name, r.patient_pays, r.valid_from, r.valid_to])).toEqual([
      [`P322 New consult ${T}`, "amount", indiaToday(), "2026-12-31"],
      [`P322 New consult ${T} from 2027-01-01`, "nothing", "2027-01-01", null],
    ]);
  });

  test("11. a fee row and a Payment rules row can't both set what the patient pays for one cell", async () => {
    const fee = {
      ...FEES()[0],
      visit_type: "New",
      fee: 900,
      patient_pays: "nothing",
      patient_value: null,
      valid_to: "2026-12-31",
    };
    const own = {
      category_code: SUB,
      rule_name: `Own new consult ${T}`,
      item_code: NEW_FEE,
      patient_pays: "full",
      remainder: "claim",
      priority: 10,
    };
    const elsewhere = { ...own, category_code: TOP, rule_name: `Top new consult ${T}` };
    const later = { ...own, rule_name: `Next year ${T}`, valid_from: "2027-02-01" };
    const preview = await previewUpload(
      await workbook({ "Payment rules": [own, elsewhere, later], "Consultant fees": [fee] }),
    );
    expect(errorsOf(preview, "Payment rules")).toEqual([]);
    expect(errorsOf(preview, "Consultant fees")).toEqual([
      `patient_pays: The Payment rules sheet (row 2) also sets what the patient pays for P322 New consult ${T} in P322 Scheme ${T} › P322 Paid; set it in one place`,
    ]);
    const alone = await previewUpload(
      await workbook({ "Payment rules": [elsewhere, later], "Consultant fees": [fee] }),
    );
    expect(alone.canImport).toBe(true);
  });

  test("12. a fee row can't stretch its payment rule over one scheduled for a later date", async () => {
    const scheduled = await saveConsultantFee(
      {
        scheme_code: SUB,
        service_item_id: (await one(`SELECT id FROM service_items WHERE code = $1`, [FU_FEE])).id,
        patient_pays: "nothing",
        valid_from: "2027-06-01",
      },
      ctx,
      getPool(),
    );
    const fee = {
      ...FEES()[0],
      visit_type: "Follow Up",
      fee: 900,
      patient_value: 250,
    };
    const preview = await previewUpload(await workbook({ "Consultant fees": [fee] }));
    expect(errorsOf(preview, "Consultant fees")).toEqual([
      `valid_to: P322 Follow-up consult ${T} in P322 Scheme ${T} › P322 Paid already has the payment rule "${scheduled.rule.name}" from 2027-06-01; give this one a To date of 2027-05-31 or earlier, or change that rule`,
    ]);
    const fixed = await previewUpload(
      await workbook({ "Consultant fees": [{ ...fee, valid_to: "2027-05-31" }] }),
    );
    expect(fixed.canImport).toBe(true);
  });

  test("13. a fee row's problem is reported once, on the column at fault", async () => {
    const fee = {
      ...FEES()[0],
      visit_type: "New",
      category_code: TOP,
      fee: 1000,
      patient_value: 950,
    };
    const past = await previewUpload(
      await workbook({
        "Consultant fees": [
          { ...fee, patient_pays: "nothing", patient_value: null, valid_to: "2026-01-01" },
        ],
      }),
    );
    expect(errorsOf(past, "Consultant fees")).toEqual([
      "valid_to: To date can't be before the From date",
    ]);
    const cheap = await previewUpload(await workbook({ "Consultant fees": [fee] }));
    const [row] = sheetOf(cheap, "Consultant fees").rows;
    expect(row.errors.map((e) => e.column)).toEqual(["patient_value"]);
    expect(row.errors[0].message).toMatch(
      new RegExp(
        `^The patient can't pay ₹950 for items that cost less: P322 New consult ${T} \\(₹900 `,
      ),
    );
  });
});
