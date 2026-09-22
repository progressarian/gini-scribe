import crypto from "node:crypto";
import path from "node:path";
import { createRequire } from "node:module";
import { test, expect } from "@playwright/test";
import { getPool, query } from "../../helpers/db.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { repoRoot } from "../../setup/testEnv.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { templateBuffer } from "../../../server/services/billing/importTemplate.js";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const { previewUpload } = await import("../../../server/services/billing/importPreview.js");
const { commitUpload } = await import("../../../server/services/billing/importCommit.js");
const { errorFile, errorFileName } =
  await import("../../../server/services/billing/importErrorFile.js");
const ExcelJS = createRequire(path.join(repoRoot, "server", "package.json"))("exceljs");

const tag = crypto.randomBytes(3).toString("hex");
const T = tag.toUpperCase();
const G = `P209G_${T}`;
const S = `P209S_${T}`;
const options = { canChangeDailyCap: true };
const ctx = { actorId: USERS.admin.id };

async function build(sheets) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await templateBuffer());
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = wb.getWorksheet(name);
    const headers = ws.getRow(1).values.slice(1);
    for (const cells of rows) ws.addRow(headers.map((h) => cells[h] ?? null));
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function load(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  return wb;
}

const preview = (buffer) => previewUpload(buffer, getPool(), options);

const headerCol = (ws, name) => ws.getRow(1).values.findIndex((v) => String(v ?? "") === name);

const FILE = {
  Groups: [{ group_code: G, name: `P209 Group ${T}` }],
  Subgroups: [{ subgroup_code: S, group_code: G, name: `P209 Sub ${T}` }],
  Items: [
    {
      item_code: `P209-OK_${T}`,
      name: `P209 Good ${T}`,
      subgroup_code: S,
      base_price: 100,
      kind: "other",
    },
    {
      item_code: `P209-BAD_${T}`,
      name: `P209 Bad ${T}`,
      subgroup_code: S,
      base_price: "₹1,200",
      kind: "service",
    },
    {
      item_code: `P209-ORPHAN_${T}`,
      name: `P209 Orphan ${T}`,
      subgroup_code: "P209_NONE",
      base_price: 5,
      kind: "other",
    },
  ],
  Discounts: [{ rule_name: "Staff discount", method: "code", code: "STAFF10" }],
};

test.describe.serial("P2-09 error file", () => {
  test.afterAll(async () => {
    await query(
      `DELETE FROM service_item_price_history WHERE service_item_id IN
                   (SELECT id FROM service_items WHERE code ILIKE $1)`,
      ["P209-%"],
    );
    await query(`DELETE FROM service_items WHERE code ILIKE $1`, ["P209-%"]);
    await query(`DELETE FROM service_subgroups WHERE code ILIKE $1`, ["P209S%"]);
    await query(`DELETE FROM service_groups WHERE code ILIKE $1`, ["P209G%"]);
  });

  test("1. the error file is the admin's own file, with an error column on the error rows only", async () => {
    const original = await build(FILE);
    const checked = await preview(original);
    expect(checked.counts.error).toBe(2);
    const wb = await load(await errorFile(original, checked));

    const items = wb.getWorksheet("Items");
    const errorCol = headerCol(items, "error");
    expect(errorCol, "the error column comes after the last header").toBe(
      items.getRow(1).values.length - 1,
    );
    expect(items.getRow(2).getCell(errorCol).value, "a good row has no error").toBeNull();
    expect(items.getRow(3).getCell(errorCol).value).toBe(
      "base_price must be a plain number (no ₹ sign, no commas); kind must be one of: consultation, test, procedure, medicine, other",
    );
    expect(items.getRow(4).getCell(errorCol).value).toBe(
      "There is no subgroup P209_NONE, in this file or in Scribe",
    );
    const fillOf = (row, column) =>
      items.getRow(row).getCell(headerCol(items, column)).fill?.fgColor?.argb;
    expect(fillOf(3, "base_price"), "the cells at fault are highlighted").toBe("FFFDE2E1");
    expect(fillOf(3, "kind")).toBe("FFFDE2E1");
    expect(fillOf(3, "name"), "cells without a problem are not").not.toBe("FFFDE2E1");
    expect(
      items.getRow(3).getCell(headerCol(items, "base_price")).text,
      "what was typed is kept",
    ).toBe("₹1,200");

    expect(
      headerCol(wb.getWorksheet("Groups"), "error"),
      "a sheet without errors gets no column",
    ).toBe(-1);
    const discounts = wb.getWorksheet("Discounts");
    expect(discounts.getRow(2).getCell(1).value, "Phase 3 sheets keep their rows").toBe(
      "Staff discount",
    );
    expect(wb.worksheets.map((ws) => ws.name)).toContain("Read me");
    expect(errorFileName("master prices.xlsx")).toBe("master prices - errors.xlsx");
    expect(errorFileName("")).toBe("billing-import - errors.xlsx");
  });

  test("2. uploaded again unchanged, the error column is ignored and the same rows are in error", async () => {
    const original = await build(FILE);
    const again = await preview(await errorFile(original, await preview(original)));
    expect(again.problems, "no 'column isn't one of this sheet's columns'").toEqual([]);
    const items = again.sheets.find((s) => s.name === "Items");
    expect(items.rows.map((r) => r.status)).toEqual(["new", "error", "error"]);
  });

  test("3. once fixed in place, the error file uploads and saves cleanly", async () => {
    const original = await build(FILE);
    const wb = await load(await errorFile(original, await preview(original)));
    const items = wb.getWorksheet("Items");
    items.getRow(3).getCell(headerCol(items, "base_price")).value = "1200";
    items.getRow(3).getCell(headerCol(items, "kind")).value = "procedure";
    items.getRow(4).getCell(headerCol(items, "subgroup_code")).value = S;
    const fixed = Buffer.from(await wb.xlsx.writeBuffer());

    const checked = await preview(fixed);
    expect(checked.problems).toEqual([]);
    expect(checked.counts).toMatchObject({ error: 0, new: 5 });
    expect(checked.canImport).toBe(true);
    const saved = await commitUpload(
      fixed,
      { fileName: errorFileName("p209.xlsx"), ctx, options },
      getPool(),
    );
    expect(saved.saved).toBe(true);
    const rows = (
      await query(
        `SELECT code, base_price::text, kind FROM service_items WHERE code ILIKE $1 ORDER BY code`,
        ["P209-%"],
      )
    ).rows;
    expect(rows).toEqual([
      { code: `P209-BAD_${T}`, base_price: "1200.00", kind: "procedure" },
      { code: `P209-OK_${T}`, base_price: "100.00", kind: "other" },
      { code: `P209-ORPHAN_${T}`, base_price: "5.00", kind: "other" },
    ]);
  });

  test("4. a second round clears old messages from rows that are now fixed", async () => {
    const original = await build({
      Items: [
        {
          item_code: `P209-R1_${T}`,
          name: `P209 R1 ${T}`,
          subgroup_code: S,
          base_price: "x",
          kind: "other",
        },
        {
          item_code: `P209-R2_${T}`,
          name: `P209 R2 ${T}`,
          subgroup_code: S,
          base_price: "y",
          kind: "other",
        },
      ],
    });
    const first = await load(await errorFile(original, await preview(original)));
    const items = first.getWorksheet("Items");
    items.getRow(2).getCell(headerCol(items, "base_price")).value = 10;
    const halfFixed = Buffer.from(await first.xlsx.writeBuffer());
    const second = await load(await errorFile(halfFixed, await preview(halfFixed)));
    const again = second.getWorksheet("Items");
    const errorCol = headerCol(again, "error");
    expect(headerCol(again, "error"), "the existing error column is reused").toBe(errorCol);
    expect(again.getRow(1).values.filter((v) => v === "error")).toHaveLength(1);
    expect(again.getRow(2).getCell(errorCol).value, "the fixed row's message is gone").toBeNull();
    expect(again.getRow(3).getCell(errorCol).value).toMatch(/base_price must be a plain number/);
  });

  test("5. a row holding only an old error message is skipped, and 'Error' in any case is ignored", async () => {
    const wb = await load(
      await build({
        Items: [
          {
            item_code: `P209-C_${T}`,
            name: `P209 C ${T}`,
            subgroup_code: S,
            base_price: 1,
            kind: "other",
          },
        ],
      }),
    );
    const items = wb.getWorksheet("Items");
    const col = items.getRow(1).values.length;
    items.getRow(1).getCell(col).value = " Error ";
    items.getRow(2).getCell(col).value = "old message";
    items.getRow(3).getCell(col).value = "a row the admin emptied";
    const checked = await preview(Buffer.from(await wb.xlsx.writeBuffer()));
    expect(checked.problems).toEqual([]);
    expect(checked.sheets.find((s) => s.name === "Items").rows.map((r) => r.row)).toEqual([2]);
  });

  test("6. no error file when there is nothing to fix, or the whole file was refused", async () => {
    const clean = await build({ Groups: [{ group_code: `P209G_X_${T}`, name: `P209 X ${T}` }] });
    expect(await errorFile(clean, await preview(clean))).toBeNull();
    const refused = Buffer.from("not a spreadsheet");
    expect(await errorFile(refused, await preview(refused))).toBeNull();
  });
});
