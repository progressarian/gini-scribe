import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { test, expect } from "@playwright/test";
import {
  BILLING_ROLES,
  IMPORT_SHEETS,
  RESERVED_CATEGORY_CODES,
  TODAY_ON_CREATE,
  blankValue,
} from "../../../server/services/billing/importColumns.js";
import {
  allowedValuesText,
  blankText,
  templateBuffer,
} from "../../../server/services/billing/importTemplate.js";
import { repoRoot } from "../../setup/testEnv.mjs";
import { CONSULTANTS } from "../../fixtures/data.mjs";

const COMMITTED = path.join(repoRoot, "docs", "gini-flow", "billing-template.xlsx");
const ExcelJS = createRequire(path.join(repoRoot, "server", "package.json"))("exceljs");

async function readme(source) {
  const workbook = new ExcelJS.Workbook();
  if (typeof source === "string") await workbook.xlsx.readFile(source);
  else await workbook.xlsx.load(source);
  const ws = workbook.getWorksheet("Read me");
  const rows = [];
  const raw = [];
  ws.eachRow({ includeEmpty: true }, (row) => {
    const values = Array.from({ length: 11 }, (_, i) => row.values[i + 1]);
    raw.push(values);
    rows.push(values.map((v) => (v == null ? "" : String(v))));
  });
  return { ws, rows, raw };
}

function rowsAfter(rows, title) {
  const start = rows.findIndex((r) => r[0] === title);
  expect(start, `section "${title}"`).toBeGreaterThan(-1);
  const out = [];
  for (let i = start + 1; i < rows.length && rows[i].some(Boolean); i += 1) out.push(rows[i]);
  return out;
}

function checkReadme({ ws, rows, raw }) {
  expect(rows[0].slice(0, 7)).toEqual([
    "sheet",
    "column",
    "required",
    "allowed values",
    "meaning",
    "if left blank",
    "example",
  ]);
  expect(ws.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
  expect(rows[1][0]).toBe("Gini Scribe — billing data template");

  const rules = rowsAfter(rows, "How to fill this file")
    .map((r) => r[4])
    .join("\n");
  for (const needle of [
    "Every test is its own item",
    "There are no packages",
    "YYYY-MM-DD",
    "Codes are unique",
    "A discount code may never be the same as a bill code",
    "may not be higher than the price",
    "comma-separated",
    "a blank visit_type means the fee is for both New and Follow Up",
    "Investigation visits have no consultation fee",
    "set active to no",
    "column order does not matter",
    "The category code general is reserved",
    "later uploads keep it",
  ]) {
    expect(rules, `rule mentions "${needle}"`).toContain(needle);
  }

  const glossary = rowsAfter(rows, "Allowed values");
  const has = (column, value) =>
    glossary.some((r) => r[1] === column && r[3] === value && r[4].length > 10);
  for (const value of ["full", "amount", "percent", "nothing"])
    expect(has("patient_pays", value), value).toBe(true);
  for (const value of ["claim", "adjustment"]) expect(has("remainder", value), value).toBe(true);
  for (const value of ["auto", "code"]) expect(has("method", value), value).toBe(true);
  for (const value of ["suggest", "auto"]) expect(has("mode", value), value).toBe(true);

  const columnRows = rows.filter((r) => IMPORT_SHEETS.some((s) => s.name === r[0]));
  for (const sheet of IMPORT_SHEETS) {
    const purpose = columnRows.find(
      (r) => r[0] === sheet.name && r[1] === "(what this sheet is for)",
    );
    expect(purpose?.[4], `${sheet.name} purpose`).toBe(sheet.purpose);
    for (const column of sheet.columns) {
      const matches = columnRows.filter((r) => r[0] === sheet.name && r[1] === column.name);
      expect(matches.length, `${sheet.name}.${column.name} has exactly one row`).toBe(1);
      const [, , required, allowed, meaning, blankCell, example] = matches[0];
      expect(blankCell, `${sheet.name}.${column.name} if left blank`).toBe(blankText(column));
      if (column.required) expect(column.blank).toBeUndefined();
      else
        expect(column.blank?.text?.length, `${sheet.name}.${column.name} blank`).toBeGreaterThan(0);
      expect(required, `${sheet.name}.${column.name} required`).toBe(
        column.required ? "yes" : "no",
      );
      expect(allowed, `${sheet.name}.${column.name} allowed`).toBe(allowedValuesText(column));
      expect(meaning.length, `${sheet.name}.${column.name} meaning`).toBeGreaterThan(5);
      expect(example, `${sheet.name}.${column.name} example`).not.toBe("");
      if (column.values && example !== "(blank)") {
        expect(column.values, `${sheet.name}.${column.name} example is allowed`).toContain(example);
      }
    }
  }

  for (const sheetName of ["Payment rules", "Consultant fees", "Discounts"]) {
    expect(blankValue(sheetName, "valid_from"), `${sheetName}.valid_from`).toBe(TODAY_ON_CREATE);
    const text = rows.find((r) => r[0] === sheetName && r[1] === "valid_from")[5];
    expect(text).toContain("later uploads keep the start date");
  }
  expect(blankValue("Category rates", "valid_from")).toBeUndefined();
  expect(blankValue("Groups", "sort_order")).toBe(0);
  expect(blankValue("Groups", "active")).toBe(true);
  expect(blankValue("Items", "unit")).toBe("each");
  expect(blankValue("Items", "allow_quantity")).toBe(false);
  expect(blankValue("Category rules", "priority")).toBe(100);
  expect(blankValue("Discounts", "allowed_roles")).toEqual(BILLING_ROLES);
  expect(blankValue("Categories", "allow_pay_later")).toBeNull();
  expect(blankValue("Consultant fees", "visit_type")).toBeNull();
  expect(rows.find((r) => r[0] === "Consultant fees" && r[1] === "visit_type")[5]).toBe(
    "both New and Follow Up for this doctor",
  );
  expect(rows.find((r) => r[0] === "Items" && r[1] === "doctor")[4]).toContain(
    "hospital's default fee",
  );
  expect(RESERVED_CATEGORY_CODES).toContain("general");
  expect(rows.find((r) => r[0] === "Categories" && r[1] === "category_code")[4]).toContain(
    "general is reserved",
  );

  expect(rows.some((r) => r[0].startsWith("Example only. Nothing here is saved"))).toBe(true);

  const categoriesHeader = IMPORT_SHEETS.find((s) => s.name === "Categories").columns.map(
    (c) => c.name,
  );
  const cats = rowsAfter(
    rows,
    "Example only: how a category and its sub-categories are laid out (Categories sheet)",
  );
  expect(cats[0]).toEqual(categoriesHeader);
  const catRows = cats.slice(1, 5);
  expect(catRows[0][2]).toBe("");
  for (const row of catRows.slice(1)) expect(row[2], `${row[0]} parent`).toBe(catRows[0][0]);
  expect(cats[cats.length - 1][0]).toContain("CGHS Paid, CGHS Referral and Pensioner");
  expect(cats[cats.length - 1][0]).toContain("Example only");

  const feesHeader = IMPORT_SHEETS.find((s) => s.name === "Consultant fees").columns.map(
    (c) => c.name,
  );
  const fees = rowsAfter(
    rows,
    "Example only: how doctors' fees are laid out (Consultant fees sheet)",
  );
  expect(fees[0]).toEqual(feesHeader);
  const feeRows = fees.slice(1).filter((r) => r[2] && r[0] !== r[2]);
  expect(feeRows.length).toBeGreaterThan(0);
  for (const row of feeRows) {
    expect(row[0], "doctor is a placeholder").toMatch(/^\[.+\]$/);
    expect(row[3], "fee is a placeholder").toBe("[fee]");
    IMPORT_SHEETS.find((s) => s.name === "Consultant fees").columns.forEach((column, i) => {
      if (column.values && row[i]) expect(column.values, column.name).toContain(row[i]);
    });
  }
  expect(fees[fees.length - 1][0]).toContain("Example only");
}

test.describe("P0-02 Read me sheet", () => {
  test("no doctor, fee or bill code from the hospital is written in the template code", () => {
    for (const file of ["importColumns.js", "importReadme.js", "importTemplate.js"]) {
      const source = fs.readFileSync(
        path.join(repoRoot, "server", "services", "billing", file),
        "utf8",
      );
      for (const doctor of Object.values(CONSULTANTS)) {
        const surname = doctor.short_name.replace(/^Dr\s+/, "");
        expect(source, `${file} mentions ${surname}`).not.toContain(surname);
      }
      expect(source, `${file} has a rupee amount`).not.toMatch(/₹\s?[1-9]/);
      expect(source, `${file} has a bill code`).not.toMatch(/\bCC\d+\b/);
    }
  });

  test("the generated Read me explains every column, value, rule and the CGHS example", async () => {
    checkReadme(await readme(Buffer.from(await templateBuffer())));
  });

  test("the committed template carries the same Read me", async () => {
    checkReadme(await readme(COMMITTED));
  });
});
