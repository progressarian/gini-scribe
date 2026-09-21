import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { repoRoot } from "../../setup/testEnv.mjs";
import {
  IMPORT_SHEETS,
  TODAY_ON_CREATE,
  parseCell,
  parseRow,
  sheetByName,
} from "../../../server/services/billing/importColumns.js";
import { INT_MAX, MONEY_MAX } from "../../../shared/billingVocab.js";

const PLAN = fs.readFileSync(
  path.join(repoRoot, "docs", "gini-flow", "52-BILLING-PLAN.md"),
  "utf8",
);

function planSheets() {
  const start = PLAN.indexOf("## 9. Bulk import from Excel");
  const section = PLAN.slice(start, PLAN.indexOf("\n## 10.", start));
  const rows = section.split("\n").filter((line) => /^\| `[^`]+` +\|/.test(line));
  return rows.map((line) => {
    const [, sheetCell, keyCell, columnsCell] = line.split("|").map((c) => c.trim());
    const key = [...keyCell.split("(")[0].matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    const extraKeys = [...(keyCell.split("(")[1] ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    const columns = columnsCell
      .split(" — ")[0]
      .replace(/\([^)]*\)/g, "")
      .split(/,|\//)
      .map((c) => c.trim())
      .filter(Boolean);
    return { name: sheetCell.replaceAll("`", ""), key, columns: [...extraKeys, ...columns] };
  });
}

const col = (sheet, name) => sheetByName(sheet).columns.find((c) => c.name === name);

test.describe("P2-02 column definitions in one place", () => {
  test("1. every sheet and column in plan §9 is defined, and nothing else", () => {
    const planned = planSheets();
    expect(planned.map((s) => s.name).sort()).toEqual(IMPORT_SHEETS.map((s) => s.name).sort());
    for (const sheet of planned) {
      const defined = sheetByName(sheet.name);
      expect(defined.key, `${sheet.name} key`).toEqual(sheet.key);
      expect(defined.columns.map((c) => c.name).sort(), `${sheet.name} columns`).toEqual(
        [...new Set([...sheet.key, ...sheet.columns])].sort(),
      );
    }
  });

  test("2. every column says how to parse it", () => {
    for (const sheet of IMPORT_SHEETS) {
      for (const c of sheet.columns) {
        const where = `${sheet.name}.${c.name}`;
        expect(["text", "number", "date", "boolean", "list"], where).toContain(c.type);
        if (c.required) expect(c.blank, where).toBeUndefined();
        else expect(Object.hasOwn(c.blank ?? {}, "value"), where).toBe(true);
        if (c.type === "list") expect(c.values?.length, where).toBeGreaterThan(0);
        if (c.type === "number") expect(["money", "whole"], where).toContain(c.numberKind);
        if (c.multi)
          expect(
            c.values,
            `${where}: a comma list gets no single-choice drop-down`,
          ).toBeUndefined();
      }
      for (const key of sheet.key) {
        const optional = sheet.name === "Consultant fees" && key === "visit_type";
        expect(col(sheet.name, key)?.required ?? false, `${sheet.name} key ${key}`).toBe(!optional);
      }
    }
    expect(col("Items", "base_price").numberKind).toBe("money");
    expect(col("Category rates", "rate").numberKind).toBe("money");
    expect(col("Consultant fees", "fee").numberKind).toBe("money");
    expect(col("Categories", "daily_cap").numberKind).toBe("whole");
    expect(col("Groups", "sort_order").min).toBe(-INT_MAX);
    expect(col("Payment rules", "visit_types")).toMatchObject({ multi: true });
    expect(col("Consultant fees", "visit_type").blank.value, "blank = every visit type").toBeNull();
    expect(col("Discounts", "allowed_roles").choices).toEqual([
      "reception",
      "reception_admin",
      "admin",
    ]);
  });

  test("3. numbers: plain, within limits, whole or money", () => {
    const price = col("Items", "base_price");
    const cap = col("Categories", "daily_cap");
    const order = col("Groups", "sort_order");
    expect(parseCell(price, 1200)).toEqual({ value: 1200 });
    expect(parseCell(price, " 1200.50 ")).toEqual({ value: 1200.5 });
    expect(parseCell(price, "1,200").error).toMatch(/plain number/);
    expect(parseCell(price, "₹1200").error).toMatch(/plain number/);
    expect(parseCell(price, 12.345).error).toMatch(/2 decimals/);
    expect(parseCell(price, -1).error).toMatch(/less than 0/);
    expect(parseCell(price, MONEY_MAX + 1).error).toMatch(/too large/);
    expect(parseCell(cap, "30")).toEqual({ value: 30 });
    expect(parseCell(cap, 2.5).error).toMatch(/whole number/);
    expect(parseCell(cap, INT_MAX + 1).error).toMatch(/too large/);
    expect(parseCell(order, -5)).toEqual({ value: -5 });
  });

  test("4. dates, yes/no and choices", () => {
    const from = col("Category rates", "valid_from");
    const to = col("Category rates", "valid_to");
    expect(parseCell(from, "2026-10-01")).toEqual({ value: "2026-10-01" });
    expect(parseCell(from, new Date(Date.UTC(2026, 9, 1)))).toEqual({ value: "2026-10-01" });
    expect(parseCell(from, 46296), "an Excel date serial").toEqual({ value: "2026-10-01" });
    expect(parseCell(from, "2026-02-30").error).toMatch(/date like/);
    expect(parseCell(from, "01/10/2026").error).toMatch(/date like/);
    expect(parseCell(to, "")).toEqual({ value: null, blank: true });
    const yes = col("Items", "allow_quantity");
    expect(parseCell(yes, "Yes")).toEqual({ value: true });
    expect(parseCell(yes, " NO ")).toEqual({ value: false });
    expect(parseCell(yes, true)).toEqual({ value: true });
    expect(parseCell(yes, "maybe").error).toMatch(/yes or no/);
    const kind = col("Items", "kind");
    expect(parseCell(kind, "TEST")).toEqual({ value: "test" });
    expect(parseCell(kind, "service").error).toMatch(/one of: consultation, test/);
  });

  test("5. comma lists, blanks and Excel's rich cells", () => {
    const visits = col("Payment rules", "visit_types");
    expect(parseCell(visits, "new, follow up, New ,")).toEqual({ value: ["New", "Follow Up"] });
    expect(parseCell(visits, "New, Tele").error).toMatch(/Tele is not allowed/);
    expect(parseCell(col("Discounts", "groups"), "OPD, LAB")).toEqual({ value: ["OPD", "LAB"] });
    expect(parseCell(col("Discounts", "groups"), "")).toEqual({ value: null, blank: true });
    expect(parseCell(col("Items", "unit"), "  ")).toEqual({ value: "each", blank: true });
    expect(parseCell(col("Items", "item_code"), null).error).toBe("item_code is required");
    expect(parseCell(col("Payment rules", "valid_from"), "")).toEqual({
      value: TODAY_ON_CREATE,
      blank: true,
    });
    expect(parseCell(col("Items", "item_code"), 123)).toEqual({ value: "123" });
    expect(
      parseCell(col("Items", "name"), { richText: [{ text: "Hb" }, { text: "A1c" }] }),
    ).toEqual({ value: "HbA1c" });
    expect(parseCell(col("Items", "base_price"), { formula: "=100*5", result: 500 })).toEqual({
      value: 500,
    });
  });

  test("6. a whole row is parsed with every error named by its column", () => {
    const { values, errors } = parseRow(sheetByName("Items"), {
      item_code: "LAB-HBA1C",
      name: "HbA1c",
      subgroup_code: "LAB_BIOCHEM",
      base_price: "5OO",
      kind: "test",
      allow_quantity: "sometimes",
    });
    expect(errors).toEqual([
      { column: "base_price", message: "base_price must be a plain number (no ₹ sign, no commas)" },
      { column: "allow_quantity", message: "allow_quantity must be yes or no" },
    ]);
    expect(values).toMatchObject({
      item_code: "LAB-HBA1C",
      unit: "each",
      max_quantity: null,
      tax_code: null,
      active: true,
    });
  });

  test("7. review: Excel errors and unsaved formulas are refused, never saved as text", () => {
    expect(parseCell(col("Items", "name"), { error: "#N/A" }).error).toBe(
      "name shows an Excel error (#N/A); fix the cell and upload again",
    );
    expect(
      parseCell(col("Items", "base_price"), { formula: "=A1", result: { error: "#REF!" } }).error,
    ).toMatch(/Excel error \(#REF!\)/);
    expect(parseCell(col("Items", "name"), { formula: "=B2" }).error).toMatch(
      /formula with no saved value/,
    );
    expect(parseCell(col("Items", "unit"), { sharedFormula: "A1" }).error).toMatch(
      /formula with no saved value/,
    );
    expect(parseCell(col("Items", "name"), { something: 1 }).error).toMatch(/can't be read/);
    for (const raw of [{ error: "#N/A" }, { formula: "=B2" }, { something: 1 }]) {
      expect(JSON.stringify(parseCell(col("Items", "name"), raw))).not.toContain("[object Object]");
    }
  });

  test("8. review: formula rounding noise in money is accepted as paise", () => {
    expect(
      parseCell(col("Items", "base_price"), { formula: "=0.1+0.2", result: 0.1 + 0.2 }),
    ).toEqual({ value: 0.3 });
    expect(parseCell(col("Items", "base_price"), 0.305).error).toMatch(/2 decimals/);
  });

  test("9. review: a comma list of only commas is blank, not an empty list", () => {
    expect(parseCell(col("Payment rules", "visit_types"), " , , ")).toEqual({
      value: null,
      blank: true,
    });
    expect(parseCell(col("Discounts", "groups"), ",,")).toEqual({ value: null, blank: true });
  });

  test("10. review: text lengths and codes are checked at parse time", () => {
    expect(parseCell(col("Items", "name"), "x".repeat(200)).value).toHaveLength(200);
    expect(parseCell(col("Items", "name"), "x".repeat(201)).error).toBe(
      "name can be at most 200 characters",
    );
    expect(parseCell(col("Items", "unit"), "x".repeat(31)).error).toBe(
      "unit can be at most 30 characters",
    );
    expect(parseCell(col("Items", "item_code"), "x".repeat(41)).error).toBe(
      "item_code can be at most 40 characters",
    );
    expect(parseCell(col("Items", "item_code"), "LAB HBA1C").error).toBe(
      "item_code can't contain spaces",
    );
    expect(parseCell(col("Category rates", "bill_code"), "CC 02").error).toBe(
      "bill_code can't contain spaces",
    );
    expect(parseCell(col("Items", "name"), "Dressing - large")).toEqual({
      value: "Dressing - large",
    });
    for (const sheet of IMPORT_SHEETS) {
      for (const c of sheet.columns.filter((c) => c.type === "text" && !c.multi)) {
        expect(c.maxLength, `${sheet.name}.${c.name}`).toBeGreaterThan(0);
      }
    }
  });

  test("11. review: a date typed with a time keeps its date", () => {
    const from = col("Category rates", "valid_from");
    expect(parseCell(from, "2026-10-01 00:00:00")).toEqual({ value: "2026-10-01" });
    expect(parseCell(from, "2026-10-01T00:00:00.000Z")).toEqual({ value: "2026-10-01" });
    expect(parseCell(from, "2026-10-01 banana").error).toMatch(/date like/);
  });
});
