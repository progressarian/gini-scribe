import path from "node:path";
import { createRequire } from "node:module";
import { test, expect } from "@playwright/test";
import { repoRoot } from "../../setup/testEnv.mjs";
import {
  IMPORT_SHEETS,
  LATER_SHEETS,
  blankValue,
  parseRow,
  sheetByName,
} from "../../../server/services/billing/importColumns.js";
import { templateBuffer } from "../../../server/services/billing/importTemplate.js";
import { SHEET_EXAMPLES } from "../../../server/services/billing/importReadme.js";
import {
  MAX_SHEET_ROWS,
  MAX_UPLOAD_BYTES,
  parseUpload,
} from "../../../server/services/billing/importParse.js";

const ExcelJS = createRequire(path.join(repoRoot, "server", "package.json"))("exceljs");

async function template() {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await templateBuffer({ examples: false }));
  return workbook;
}

const bytes = async (workbook) => Buffer.from(await workbook.xlsx.writeBuffer());

function fill(workbook, sheetName, rows) {
  const ws = workbook.getWorksheet(sheetName);
  const names = ws.getRow(1).values.slice(1);
  for (const values of rows) ws.addRow(names.map((name) => values[name] ?? null));
  return ws;
}

async function parseFilled(build) {
  const workbook = await template();
  await build(workbook);
  return parseUpload(await bytes(workbook));
}

const sheetOf = (result, name) => result.sheets.find((s) => s.name === name);

test.describe("P2-04 parse the upload", () => {
  test("1. a filled template parses into rows per sheet, in template order", async () => {
    const result = await parseFilled((wb) => {
      fill(wb, "Category rates", [
        {
          category_code: "cghs",
          item_code: "LAB-HBA1C",
          valid_from: new Date(Date.UTC(2026, 9, 1)),
          rate: "450.50",
          bill_code: "CC02",
          valid_to: "2027-03-31",
        },
      ]);
      const groups = fill(wb, "Groups", [
        { group_code: "  LAB ", name: " Laboratory ", sort_order: "10", active: "Yes" },
      ]);
      groups.addRow(["   ", "", " "]);
      fill(wb, "Groups", [{ group_code: "OPD", name: "OPD", sort_order: 5, active: "no" }]);
      fill(wb, "Items", [
        {
          item_code: "LAB-HBA1C",
          name: "HbA1c",
          subgroup_code: "LAB_BIOCHEM",
          base_price: 500,
          allow_quantity: "YES",
          max_quantity: "3",
          kind: "Test",
          test_name: "HbA1c",
        },
      ]);
    });
    expect(result.problems).toEqual([]);
    expect(result.sheets.map((s) => s.name)).toEqual(["Groups", "Items", "Category rates"]);

    const groups = sheetOf(result, "Groups");
    expect(groups.rows.map((r) => r.row)).toEqual([2, 4]);
    expect(groups.rows.map((r) => r.values)).toEqual([
      { group_code: "LAB", name: "Laboratory", sort_order: 10, active: true },
      { group_code: "OPD", name: "OPD", sort_order: 5, active: false },
    ]);
    expect(groups.rows[0].input.group_code).toBe("LAB");

    const [item] = sheetOf(result, "Items").rows;
    expect(item.errors).toEqual([]);
    expect(item.values).toMatchObject({
      base_price: 500,
      allow_quantity: true,
      max_quantity: 3,
      kind: "test",
      unit: "each",
      active: true,
    });

    const [rate] = sheetOf(result, "Category rates").rows;
    expect(rate.values).toMatchObject({
      valid_from: "2026-10-01",
      valid_to: "2027-03-31",
      rate: 450.5,
      bill_name: null,
    });
    expect(rate.input.valid_from, "a date cell is shown as the admin would type it").toBe(
      "2026-10-01",
    );
  });

  test("2. every optional column left blank takes its default from importColumns.js", async () => {
    const importable = IMPORT_SHEETS.filter((sheet) => !LATER_SHEETS.includes(sheet.name));
    const result = await parseFilled((wb) => {
      for (const sheet of importable) {
        const row = Object.fromEntries(
          sheet.columns.filter((c) => c.required).map((c) => [c.name, c.example]),
        );
        fill(wb, sheet.name, [row]);
      }
    });
    expect(result.problems).toEqual([]);
    for (const sheet of importable) {
      const [row] = sheetOf(result, sheet.name).rows;
      expect(row.errors, `${sheet.name} examples parse`).toEqual([]);
      for (const column of sheet.columns.filter((c) => !c.required)) {
        expect(row.values[column.name], `${sheet.name}.${column.name}`).toEqual(
          blankValue(sheet.name, column.name),
        );
      }
    }
    expect(sheetOf(result, "Items").rows[0].values).toMatchObject({
      unit: "each",
      active: true,
      allow_quantity: false,
    });
    expect(sheetOf(result, "Category rules").rows[0].values.priority).toBe(100);
    expect(sheetOf(result, "Groups").rows[0].values.sort_order).toBe(0);
  });

  test("3. bad values become errors on their row, named by column; the row is still returned", async () => {
    const result = await parseFilled((wb) =>
      fill(wb, "Items", [
        {
          item_code: "LAB BAD",
          name: "Bad",
          subgroup_code: "LAB_BIOCHEM",
          base_price: "₹1,200",
          allow_quantity: "maybe",
          kind: "service",
        },
      ]),
    );
    expect(result.problems).toEqual([]);
    const [row] = sheetOf(result, "Items").rows;
    expect(row.row).toBe(2);
    expect(row.errors.map((e) => e.column)).toEqual([
      "item_code",
      "base_price",
      "allow_quantity",
      "kind",
    ]);
    expect(row.input.base_price).toBe("₹1,200");
  });

  test("4. formulas, rich text and Excel errors are read the way P2-02 defines", async () => {
    const result = await parseFilled((wb) => {
      const ws = fill(wb, "Groups", [{ group_code: "A", name: "x" }]);
      ws.getCell("B2").value = { richText: [{ text: "Lab" }, { text: "oratory" }] };
      ws.getCell("C2").value = { formula: "5*2", result: 10 };
      fill(wb, "Groups", [{ group_code: "B", name: "y" }]);
      ws.getCell("B3").value = { error: "#N/A" };
    });
    const [a, b] = sheetOf(result, "Groups").rows;
    expect(a.values).toMatchObject({ name: "Laboratory", sort_order: 10 });
    expect(b.errors[0].message).toContain("shows an Excel error (#N/A)");
  });

  test("5. headers and sheet names are matched ignoring case and spaces, columns in any order", async () => {
    const workbook = new ExcelJS.Workbook();
    const ws = workbook.addWorksheet(" groups ");
    ws.addRow(["Active", "Name", " SORT_ORDER", " GROUP_CODE "]);
    ws.addRow(["no", "Laboratory", 3, "LAB"]);
    const result = await parseUpload(await bytes(workbook));
    expect(result.problems).toEqual([]);
    expect(sheetOf(result, "Groups").rows[0].values).toEqual({
      group_code: "LAB",
      name: "Laboratory",
      sort_order: 3,
      active: false,
    });
  });

  test("6. since P3-22 Payment rules, Consultant fees and Discounts rows are parsed like every other sheet", async () => {
    const result = await parseFilled((wb) => {
      fill(wb, "Discounts", [{ rule_name: "Staff", method: "nonsense" }, { rule_name: "Two" }]);
      fill(wb, "Consultant fees", [{ doctor: "[Doctor A]", fee: "abc" }]);
      fill(wb, "Groups", [{ group_code: "LAB", name: "Lab" }]);
    });
    expect(result.problems).toEqual([]);
    const discounts = sheetOf(result, "Discounts");
    expect(discounts).toMatchObject({ name: "Discounts", later: false, notImported: 0 });
    expect(discounts.rows.map((r) => [r.row, r.errors.map((e) => e.message)])).toEqual([
      [2, ["method must be one of: auto, code", "kind is required", "value is required"]],
      [3, ["method is required", "kind is required", "value is required"]],
    ]);
    const [fee] = sheetOf(result, "Consultant fees").rows;
    expect(fee.errors.map((e) => e.column)).toEqual([
      "category_code",
      "fee",
      "patient_pays",
      "remainder",
    ]);
    expect(fee.values.doctor).toBe("[Doctor A]");
    expect(sheetOf(result, "Payment rules")).toBeUndefined();
    expect(sheetOf(result, "Groups").later).toBe(false);
  });

  test("7. the untouched template, the Read me and an empty extra sheet add no rows", async () => {
    const untouched = await parseUpload(Buffer.from(await templateBuffer()));
    expect(untouched).toEqual({ problems: ["The file has no rows to import"], sheets: [] });
    const result = await parseFilled((wb) => {
      wb.addWorksheet("Sheet1");
      wb.getWorksheet("Read me").addRow(["anything", "at all"]);
      fill(wb, "Groups", [{ group_code: "LAB", name: "Lab" }]);
    });
    expect(result.problems).toEqual([]);
    expect(result.sheets.map((s) => s.name)).toEqual(["Groups"]);
  });

  test("8. the whole file is refused, with every reason listed, for a bad sheet or header", async () => {
    const result = await parseFilled((wb) => {
      const notes = wb.addWorksheet("My notes");
      notes.addRow(["call the lab"]);
      const items = wb.getWorksheet("Items");
      items.getCell("A1").value = "code";
      items.getCell("E1").value = "base_price";
      fill(wb, "Items", [{ name: "HbA1c" }]);
      const groups = wb.getWorksheet("Groups");
      groups.getCell("F1").value = "colour";
      fill(wb, "Groups", [{ group_code: "LAB", name: "Lab" }]);
    });
    expect(result.sheets).toEqual([]);
    expect(result.problems).toEqual([
      "The sheet \"My notes\" isn't one of the template's sheets; rename it or delete it",
      "Groups: the column \"colour\" isn't one of this sheet's columns; fix its name or delete the column",
      "Items: the column base_price appears twice",
      "Items: the column \"code\" isn't one of this sheet's columns; fix its name or delete the column",
      "Items: the columns item_code and unit are missing; put the header back (leave its cells empty to use the default)",
    ]);
  });

  test("9. files that aren't .xlsx, are empty, too big or too long are refused", async () => {
    expect((await parseUpload(Buffer.alloc(0))).problems).toEqual(["The file is empty"]);
    expect((await parseUpload(Buffer.from("item_code,name\nA,B"))).problems[0]).toMatch(
      /isn't an Excel \.xlsx file/,
    );
    expect((await parseUpload(Buffer.alloc(MAX_UPLOAD_BYTES + 1))).problems[0]).toMatch(
      /larger than 5 MB/,
    );
    const workbook = new ExcelJS.Workbook();
    const ws = workbook.addWorksheet("Groups");
    ws.addRow(sheetByName("Groups").columns.map((c) => c.name));
    for (let i = 0; i <= MAX_SHEET_ROWS; i += 1) ws.addRow([`G${i}`, "Group"]);
    expect((await parseUpload(await bytes(workbook))).problems).toEqual([
      `Groups has ${MAX_SHEET_ROWS + 1} rows; at most ${MAX_SHEET_ROWS} can be uploaded at once`,
    ]);
  });

  test("10. review: a deleted header is refused, so its values can't silently become defaults", async () => {
    const result = await parseFilled((wb) => {
      const groups = fill(wb, "Groups", [{ group_code: "LAB", name: "Lab", active: "no" }]);
      groups.getCell("D1").value = null;
    });
    expect(result.sheets).toEqual([]);
    expect(result.problems).toEqual([
      "Groups: the column active is missing; put the header back (leave its cells empty to use the default)",
      "Groups: column D has values but no header; put the header back or clear the column",
    ]);
    const partial = new ExcelJS.Workbook();
    const ws = partial.addWorksheet("Items");
    ws.addRow(["item_code", "base_price"]);
    ws.addRow(["LAB-HBA1C", 450]);
    expect((await parseUpload(await bytes(partial))).problems[0]).toMatch(
      /^Items: the columns name, subgroup_code, unit, .* and active are missing/,
    );
  });

  test("11. review: the same sheet twice is refused", async () => {
    const result = await parseFilled((wb) => {
      fill(wb, "Groups", [{ group_code: "LAB", name: "Lab" }]);
      const twin = wb.addWorksheet("groups ");
      twin.addRow(["group_code", "name", "sort_order", "active"]);
      twin.addRow(["LAB", "Other"]);
    });
    expect(result.problems).toEqual([
      'The sheet Groups appears twice ("Groups" and "groups "); keep one',
    ]);
  });

  test("12. review: a title row above the headers says row 1 must hold the column names", async () => {
    const result = await parseFilled((wb) => {
      const groups = wb.getWorksheet("Groups");
      groups.spliceRows(1, 0, ["Gini billing data"]);
      groups.addRow(["LAB", "Lab"]);
    });
    expect(result.problems).toEqual([
      "Groups: row 1 must hold the column names (group_code, name, sort_order, active)",
    ]);
  });

  test("13. review: a value Excel turned into a date is an error, not a date number", async () => {
    const result = await parseFilled((wb) => {
      const groups = fill(wb, "Groups", [{ group_code: "LAB", name: "x", sort_order: 1 }]);
      for (const address of ["B2", "C2"]) {
        groups.getCell(address).value = new Date(Date.UTC(2026, 0, 2));
        groups.getCell(address).numFmt = "d-mmm";
      }
    });
    const [row] = sheetOf(result, "Groups").rows;
    expect(row.errors).toEqual([
      {
        column: "name",
        message:
          "name is a date, so Excel has probably changed what was typed; format the column as Text and type it again",
      },
      {
        column: "sort_order",
        message:
          "sort_order is a date, so Excel has probably changed what was typed; format the column as Text and type it again",
      },
    ]);
  });

  test("14. the template's example rows are valid, and an upload always skips them", async () => {
    for (const sheet of IMPORT_SHEETS) {
      const examples = SHEET_EXAMPLES[sheet.name];
      expect(examples, `${sheet.name} has two examples`).toHaveLength(2);
      for (const example of examples) {
        expect(String(example[sheet.columns[0].name]), sheet.name).toMatch(/^example/i);
        expect(parseRow(sheet, example).errors, `${sheet.name} example`).toEqual([]);
      }
    }

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await templateBuffer());
    const add = (name, cells) => {
      const ws = wb.getWorksheet(name);
      const names = ws.getRow(1).values.slice(1);
      ws.addRow(names.map((n) => cells[n] ?? null));
    };
    add("Groups", { group_code: "REAL_LAB", name: "Real lab" });
    add("Discounts", {
      rule_name: "Staff",
      method: "code",
      code: "STAFF1",
      kind: "flat",
      value: 50,
    });
    const result = await parseUpload(await bytes(wb));
    expect(result.problems).toEqual([]);
    expect(result.sheets.map((s) => [s.name, s.rows.map((r) => r.row), s.notImported])).toEqual([
      ["Groups", [4], 0],
      ["Discounts", [4], 0],
    ]);

    const moved = new ExcelJS.Workbook();
    const ws = moved.addWorksheet("Groups");
    ws.addRow(["name", "sort_order", "active", "group_code"]);
    ws.addRow(["Lab (example)", 1, "yes", "EXAMPLE_LAB"]);
    ws.addRow(["Real lab", 1, "yes", "REAL_LAB"]);
    const reordered = await parseUpload(await bytes(moved));
    expect(reordered.sheets[0].rows.map((r) => r.values.group_code)).toEqual(["REAL_LAB"]);
  });
});
