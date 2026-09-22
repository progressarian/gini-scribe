import crypto from "node:crypto";
import path from "node:path";
import { createRequire } from "node:module";
import { test, expect } from "@playwright/test";
import { getPool, query } from "../../helpers/db.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { repoRoot } from "../../setup/testEnv.mjs";
import { templateBuffer } from "../../../server/services/billing/importTemplate.js";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const { markStatus, previewUpload } =
  await import("../../../server/services/billing/importPreview.js");
const { checkMasterRows } = await import("../../../server/services/billing/importValidate.js");
const { parseRow, sheetByName } = await import("../../../server/services/billing/importColumns.js");
const ExcelJS = createRequire(path.join(repoRoot, "server", "package.json"))("exceljs");

const tag = crypto.randomBytes(3).toString("hex");
const T = tag.toUpperCase();
const G = `P207G_${T}`;
const S = `P207S_${T}`;
const ITEM = `P207-I_${T}`;
const CAT = `p207_${tag}`;
const ids = {};

async function upload(sheets) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await templateBuffer({ examples: false }));
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = workbook.getWorksheet(name);
    const headers = ws.getRow(1).values.slice(1);
    for (const cells of rows) ws.addRow(headers.map((h) => cells[h] ?? null));
  }
  return previewUpload(Buffer.from(await workbook.xlsx.writeBuffer()), getPool(), {
    canChangeDailyCap: true,
  });
}

const sheetOf = (preview, name) => preview.sheets.find((s) => s.name === name);
const statuses = (preview, name) => sheetOf(preview, name).rows.map((r) => r.status);

const SAME = {
  Groups: [{ group_code: G, name: `P207 Group ${T}`, sort_order: 5, active: "yes" }],
  Subgroups: [{ subgroup_code: S, group_code: G, name: `P207 Sub ${T}`, sort_order: 0 }],
  Items: [
    {
      item_code: ITEM,
      name: `P207 Item ${T}`,
      subgroup_code: S,
      base_price: 100,
      kind: "other",
    },
  ],
  Categories: [{ category_code: CAT, label: `P207 Category ${T}`, daily_cap: 10 }],
  "Category rules": [{ category_code: CAT, rule_name: "Over 60", min_age: 60, mode: "suggest" }],
  "Category rates": [
    { category_code: CAT, item_code: ITEM, valid_from: "2026-04-01", rate: 80, bill_code: "PX1" },
  ],
};

test.describe.serial("P2-07 row status and preview", () => {
  test.beforeAll(async () => {
    const one = async (sql, params) => (await query(sql, params)).rows[0];
    ids.group = (
      await one(
        `INSERT INTO service_groups (code, name, sort_order) VALUES ($1, $2, 5) RETURNING id`,
        [G, `P207 Group ${T}`],
      )
    ).id;
    ids.subgroup = (
      await one(
        `INSERT INTO service_subgroups (group_id, code, name) VALUES ($1, $2, $3) RETURNING id`,
        [ids.group, S, `P207 Sub ${T}`],
      )
    ).id;
    ids.item = (
      await one(
        `INSERT INTO service_items (code, name, subgroup_id, base_price, kind)
         VALUES ($1, $2, $3, 100, 'other') RETURNING id`,
        [ITEM, `P207 Item ${T}`, ids.subgroup],
      )
    ).id;
    await query(`INSERT INTO patient_schemes (code, label, daily_cap) VALUES ($1, $2, 10)`, [
      CAT,
      `P207 Category ${T}`,
    ]);
    await query(
      `INSERT INTO category_rules (scheme_code, name, min_age, mode) VALUES ($1, 'Over 60', 60, 'suggest')`,
      [CAT],
    );
    await query(
      `INSERT INTO category_item_rates (scheme_code, service_item_id, rate, bill_code, valid_from)
       VALUES ($1, $2, 80, 'PX1', '2026-04-01')`,
      [CAT, ids.item],
    );
  });

  test.afterAll(async () => {
    await query(`DELETE FROM category_item_rates WHERE scheme_code = $1`, [CAT]);
    await query(`DELETE FROM category_rules WHERE scheme_code = $1`, [CAT]);
    await query(`DELETE FROM patient_schemes WHERE code = $1`, [CAT]);
    await query(`DELETE FROM service_items WHERE subgroup_id = $1`, [ids.subgroup]);
    await query(`DELETE FROM service_subgroups WHERE id = $1`, [ids.subgroup]);
    await query(`DELETE FROM service_groups WHERE id = $1`, [ids.group]);
  });

  test("1. a row that matches Scribe is unchanged, on every sheet", async () => {
    const preview = await upload(SAME);
    expect(preview.problems).toEqual([]);
    for (const name of Object.keys(SAME)) {
      expect(statuses(preview, name), name).toEqual(["unchanged"]);
      expect(sheetOf(preview, name).rows[0].changes, name).toEqual([]);
    }
    expect(preview.counts).toMatchObject({ new: 0, update: 0, unchanged: 6, error: 0 });
    expect(preview.canImport, "nothing to save").toBe(false);
  });

  test("2. changed values are updates, listing each change; new keys are new", async () => {
    const preview = await upload({
      Groups: [
        { ...SAME.Groups[0], name: `P207 Renamed ${T}` },
        { group_code: `${G}_NEW`, name: `P207 New group ${T}` },
      ],
      Items: [
        { ...SAME.Items[0], item_code: ITEM.toLowerCase(), base_price: "120.50", unit: "box" },
      ],
      Categories: [
        { ...SAME.Categories[0], category_code: CAT.toUpperCase(), requires_ref: "yes" },
      ],
      "Category rules": [{ ...SAME["Category rules"][0], rule_name: "OVER 60", priority: 5 }],
      "Category rates": [
        { ...SAME["Category rates"][0], valid_to: "2026-12-31" },
        { ...SAME["Category rates"][0], valid_from: "2027-01-01", rate: 90 },
      ],
    });
    expect(statuses(preview, "Groups")).toEqual(["update", "new"]);
    expect(sheetOf(preview, "Groups").rows[0].changes).toEqual([
      { column: "name", from: `P207 Group ${T}`, to: `P207 Renamed ${T}` },
    ]);
    const [item] = sheetOf(preview, "Items").rows;
    expect(item.status, "matched ignoring the code's case").toBe("update");
    expect(item.changes).toEqual([
      { column: "base_price", from: 100, to: 120.5 },
      { column: "unit", from: "each", to: "box" },
    ]);
    expect(sheetOf(preview, "Categories").rows[0].changes).toEqual([
      { column: "requires_ref", from: false, to: true },
    ]);
    expect(sheetOf(preview, "Category rules").rows[0]).toMatchObject({
      status: "update",
      changes: [{ column: "priority", from: 100, to: 5 }],
    });
    expect(statuses(preview, "Category rates")).toEqual(["update", "new"]);
    expect(sheetOf(preview, "Category rates").rows[0].changes).toEqual([
      { column: "valid_to", from: null, to: "2026-12-31" },
    ]);
    expect(preview.counts).toMatchObject({ new: 2, update: 5, unchanged: 0, error: 0 });
    expect(preview.canImport).toBe(true);
  });

  test("3. a row with errors is an error row, counted per sheet, and blocks the import", async () => {
    const preview = await upload({
      Groups: [SAME.Groups[0]],
      Items: [
        { ...SAME.Items[0], base_price: 150 },
        {
          item_code: `${ITEM}-X`,
          name: "P207 bad",
          subgroup_code: "P207_NONE",
          base_price: 1,
          kind: "other",
        },
      ],
    });
    expect(statuses(preview, "Items")).toEqual(["update", "error"]);
    expect(sheetOf(preview, "Items").counts).toMatchObject({ update: 1, error: 1 });
    expect(sheetOf(preview, "Items").rows[1].errors[0].message).toContain(
      "There is no subgroup P207_NONE",
    );
    expect(preview.counts.error).toBe(1);
    expect(preview.canImport).toBe(false);
  });

  test("4. a new code with the name of an existing row warns that the code may have been changed on screen", async () => {
    const preview = await upload({
      Items: [{ ...SAME.Items[0], item_code: `P207-OLD_${T}` }],
      Groups: [{ group_code: `P207G_OLD_${T}`, name: `p207 group ${T}` }],
    });
    const [item] = sheetOf(preview, "Items").rows;
    expect(item.status).toBe("error");
    expect(item.warnings).toEqual([
      {
        column: "item_code",
        message: `Looks like P207-OLD_${T}, which now has code ${ITEM} — was the code changed on the admin screen?`,
      },
    ]);
    const [group] = sheetOf(preview, "Groups").rows;
    expect(group.warnings[0].message).toBe(
      `Looks like P207G_OLD_${T}, which now has code ${G} — was the code changed on the admin screen?`,
    );
    expect(sheetOf(preview, "Groups").counts.warning).toBe(1);
  });

  test("5. since P3-22 the Phase 3 sheets are checked like the others, and a refused file returns only its problems", async () => {
    const preview = await upload({
      Groups: [SAME.Groups[0]],
      Discounts: [{ rule_name: "Staff" }, { rule_name: "Senior" }],
    });
    const discounts = sheetOf(preview, "Discounts");
    expect(discounts).toMatchObject({ later: false, counts: { notImported: 0, error: 2 } });
    expect(discounts.rows.map((r) => [r.row, r.status, r.errors.map((e) => e.message)])).toEqual([
      [2, "error", ["method is required", "kind is required", "value is required"]],
      [3, "error", ["method is required", "kind is required", "value is required"]],
    ]);
    expect(preview.counts.notImported).toBe(0);
    expect(preview.canImport).toBe(false);

    const refused = await previewUpload(Buffer.from("not a spreadsheet"), getPool());
    expect(refused).toEqual({
      problems: [expect.stringContaining("isn't an Excel .xlsx file")],
      canImport: false,
      counts: { new: 0, update: 0, unchanged: 0, error: 0, warning: 0, notImported: 0 },
      sheets: [],
    });
  });

  test("6. each preview row carries what the P2-09 error file and the preview page need", async () => {
    const preview = await upload({ Items: [{ ...SAME.Items[0], base_price: "₹100" }] });
    const [row] = sheetOf(preview, "Items").rows;
    expect(Object.keys(row).sort()).toEqual(
      ["changes", "errors", "input", "row", "status", "values", "warnings"].sort(),
    );
    expect(row).toMatchObject({ row: 2, status: "error", input: { base_price: "₹100" } });
  });

  test("7. review: no renamed-code warning when the file itself renames the old row", () => {
    const ref = {
      groups: [{ id: 1, code: "LAB", name: "Lab", sort_order: 0, is_active: true }],
      subgroups: [
        { id: 11, code: "BIO", name: "Bio", group_id: 1, sort_order: 0, is_active: true },
      ],
      items: [
        {
          id: 101,
          code: "LAB-A1C",
          name: "HbA1c",
          subgroup_id: 11,
          base_price: "500.00",
          unit: "each",
          allow_quantity: false,
          max_quantity: null,
          tax_code_id: null,
          kind: "other",
          doctor_id: null,
          visit_type: null,
          test_catalog_id: null,
          is_active: true,
        },
      ],
      doctors: [],
      tests: [],
      taxCodes: [],
      machines: [],
      categories: [],
      rules: [],
      rates: [],
    };
    const run = (rows) => {
      const sheets = [
        {
          name: "Items",
          later: false,
          notImported: 0,
          rows: rows.map((cells, i) => ({
            row: i + 2,
            input: {},
            ...parseRow(sheetByName("Items"), { subgroup_code: "BIO", kind: "other", ...cells }),
          })),
        },
      ];
      checkMasterRows(sheets, structuredClone(ref), {});
      markStatus(sheets, structuredClone(ref));
      return sheets[0].rows;
    };
    const renamed = run([
      { item_code: "LAB-A1C", name: "HbA1c (old)", base_price: 500 },
      { item_code: "LAB-A1C2", name: "HbA1c", base_price: 550 },
    ]);
    expect(renamed.map((r) => r.status)).toEqual(["update", "new"]);
    expect(renamed[1].warnings).toEqual([]);
    const kept = run([
      { item_code: "LAB-A1C", name: "HbA1c", base_price: 500 },
      { item_code: "LAB-A1C2", name: "HbA1c", base_price: 550 },
    ]);
    expect(kept[1].status).toBe("error");
    expect(kept[1].warnings[0].message).toContain(
      "Looks like LAB-A1C2, which now has code LAB-A1C",
    );
  });
});
