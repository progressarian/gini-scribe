import path from "node:path";
import { createRequire } from "node:module";
import { test, expect } from "@playwright/test";
import {
  IMPORT_SHEETS,
  TEMPLATE_SHEET_NAMES,
  YES_NO,
} from "../../../server/services/billing/importColumns.js";
import { TEMPLATE_ROWS, templateBuffer } from "../../../server/services/billing/importTemplate.js";
import { repoRoot } from "../../setup/testEnv.mjs";

const COMMITTED = path.join(repoRoot, "docs", "gini-flow", "billing-template.xlsx");
const ExcelJS = createRequire(path.join(repoRoot, "server", "package.json"))("exceljs");

const EXPECTED_HEADERS = {
  Groups: ["group_code", "name", "sort_order", "active"],
  Subgroups: ["subgroup_code", "group_code", "name", "sort_order", "active"],
  Items: [
    "item_code",
    "name",
    "subgroup_code",
    "base_price",
    "unit",
    "allow_quantity",
    "max_quantity",
    "tax_code",
    "kind",
    "doctor",
    "visit_type",
    "test_name",
    "active",
  ],
  Categories: [
    "category_code",
    "label",
    "parent_code",
    "payer_name",
    "requires_ref",
    "requires_referral",
    "requires_referral_doc",
    "print_on_bill",
    "allow_pay_later",
    "daily_cap",
    "active",
  ],
  "Category rules": [
    "category_code",
    "rule_name",
    "min_age",
    "max_age",
    "gender",
    "requires_card",
    "mode",
    "priority",
    "active",
  ],
  "Category rates": [
    "category_code",
    "item_code",
    "valid_from",
    "rate",
    "bill_name",
    "bill_code",
    "valid_to",
  ],
  "Payment rules": [
    "category_code",
    "rule_name",
    "group_code",
    "subgroup_code",
    "item_code",
    "visit_types",
    "patient_pays",
    "patient_value",
    "remainder",
    "valid_from",
    "valid_to",
    "priority",
    "active",
  ],
  "Consultant fees": [
    "doctor",
    "visit_type",
    "category_code",
    "fee",
    "patient_pays",
    "patient_value",
    "remainder",
    "bill_name",
    "bill_code",
    "valid_from",
    "valid_to",
  ],
  Discounts: [
    "rule_name",
    "code",
    "method",
    "kind",
    "value",
    "max_discount",
    "groups",
    "subgroups",
    "items",
    "doctors",
    "visit_types",
    "categories",
    "min_age",
    "max_age",
    "gender",
    "valid_from",
    "valid_to",
    "max_uses_total",
    "max_uses_per_patient",
    "max_uses_per_day",
    "max_uses_per_doctor_per_day",
    "priority",
    "stackable",
    "applies_on_scheme_rate",
    "allowed_roles",
    "active",
  ],
};

const GENDERS = ["Male", "Female", "Other"];

const EXPECTED_LISTS = {
  "Items.kind": ["consultation", "test", "procedure", "medicine", "other"],
  "Items.visit_type": ["New", "Follow Up"],
  "Consultant fees.visit_type": ["New", "Follow Up"],
  "Category rules.gender": GENDERS,
  "Discounts.gender": GENDERS,
  "Category rules.mode": ["suggest", "auto"],
  "Payment rules.patient_pays": ["full", "amount", "percent", "nothing"],
  "Payment rules.remainder": ["claim", "adjustment"],
  "Consultant fees.patient_pays": ["full", "amount", "percent", "nothing"],
  "Consultant fees.remainder": ["claim", "adjustment"],
  "Discounts.method": ["auto", "code"],
  "Discounts.kind": ["percent", "flat", "fixed_price"],
};

function headers(ws) {
  return ws.getRow(1).values.slice(1);
}

function listValues(ws, columnIndex) {
  const cell = ws.getRow(2).getCell(columnIndex);
  const rule = cell.dataValidation;
  if (!rule || rule.type !== "list") return null;
  return rule.formulae[0].replace(/^"|"$/g, "").split(",");
}

async function load(source) {
  const workbook = new ExcelJS.Workbook();
  if (Buffer.isBuffer(source) || source instanceof ArrayBuffer) await workbook.xlsx.load(source);
  else await workbook.xlsx.readFile(source);
  return workbook;
}

function checkWorkbook(workbook) {
  expect(workbook.worksheets.map((ws) => ws.name)).toEqual([
    "Groups",
    "Subgroups",
    "Items",
    "Categories",
    "Category rules",
    "Category rates",
    "Payment rules",
    "Consultant fees",
    "Discounts",
    "Read me",
  ]);
  expect(TEMPLATE_SHEET_NAMES).toEqual(workbook.worksheets.map((ws) => ws.name));

  for (const [sheetName, expected] of Object.entries(EXPECTED_HEADERS)) {
    const ws = workbook.getWorksheet(sheetName);
    expect(headers(ws), sheetName).toEqual(expected);
    expect(ws.views[0], `${sheetName} frozen header`).toMatchObject({ state: "frozen", ySplit: 1 });
    expect(ws.rowCount, `${sheetName} has no data rows`).toBe(1);
  }

  for (const sheet of IMPORT_SHEETS) {
    const ws = workbook.getWorksheet(sheet.name);
    expect(headers(ws), `${sheet.name} matches importColumns.js`).toEqual(
      sheet.columns.map((column) => column.name),
    );
    sheet.columns.forEach((column, i) => {
      const values = listValues(ws, i + 1);
      const label = `${sheet.name}.${column.name}`;
      if (column.type === "boolean") expect(values, label).toEqual(YES_NO);
      else if (EXPECTED_LISTS[label]) expect(values, label).toEqual(EXPECTED_LISTS[label]);
      else expect(values, `${label} has no drop-down`).toBeNull();
    });
    const lastRow = ws.getRow(TEMPLATE_ROWS + 1);
    const firstList = sheet.columns.findIndex((column) => column.values);
    if (firstList >= 0) {
      expect(lastRow.getCell(firstList + 1).dataValidation?.type, `${sheet.name} last row`).toBe(
        "list",
      );
      expect(
        ws.getRow(TEMPLATE_ROWS + 2).getCell(firstList + 1).dataValidation,
        `${sheet.name} beyond the range`,
      ).toBeUndefined();
    }
  }

  for (const [label, values] of Object.entries(EXPECTED_LISTS)) {
    const [sheetName, columnName] = label.split(".");
    const index = EXPECTED_HEADERS[sheetName].indexOf(columnName) + 1;
    const rule = workbook.getWorksheet(sheetName).getRow(5).getCell(index).dataValidation;
    expect(rule.showErrorMessage, `${label} rejects other values`).toBe(true);
    expect(rule.errorStyle ?? "stop", label).toBe("stop");
    expect(rule.error, label).toContain(values.join(", "));
  }

  const feeVisitType = workbook
    .getWorksheet("Consultant fees")
    .getRow(2)
    .getCell(EXPECTED_HEADERS["Consultant fees"].indexOf("visit_type") + 1).dataValidation;
  expect(feeVisitType.allowBlank, "Consultant fees visit_type may be blank").toBe(true);
  const itemKind = workbook
    .getWorksheet("Items")
    .getRow(2)
    .getCell(EXPECTED_HEADERS.Items.indexOf("kind") + 1).dataValidation;
  expect(itemKind.allowBlank ?? false, "Items kind is required").toBe(false);

  expect(headers(workbook.getWorksheet("Read me"))).toEqual([
    "sheet",
    "column",
    "required",
    "allowed values",
    "meaning",
    "if left blank",
    "example",
  ]);
}

test.describe("P0-01 blank Excel template", () => {
  test("the generated template has every sheet, header and drop-down", async () => {
    checkWorkbook(await load(Buffer.from(await templateBuffer())));
  });

  test("the committed file in docs matches the generator", async () => {
    checkWorkbook(await load(COMMITTED));
  });
});
