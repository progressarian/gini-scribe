import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { test, expect } from "@playwright/test";
import { loginAs } from "../../helpers/auth.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { one, query } from "../../helpers/db.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { repoRoot } from "../../setup/testEnv.mjs";
import { templateBuffer } from "../../../server/services/billing/importTemplate.js";
import { ERROR_COLUMN } from "../../../server/services/billing/importColumns.js";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const ExcelJS = createRequire(path.join(repoRoot, "server", "package.json"))("exceljs");

const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const tag = crypto.randomBytes(3).toString("hex");
const code = (name) => `P212_${name}_${tag}`.toUpperCase();
const category = (name) => `p212_${name}_${tag}`;
const fileName = (name) => `p212-${name}-${tag}.xlsx`;
const DOCTOR = `Dr P212 ${tag}`;
const TEST_NAME = `P212 Test ${tag}`;
const seed = {};

async function workbook(sheets) {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(await templateBuffer());
  for (const [sheetName, rows] of Object.entries(sheets)) {
    const ws = book.getWorksheet(sheetName);
    const columns = {};
    ws.getRow(1).eachCell((cell, col) => {
      columns[cell.text] = col;
    });
    rows.forEach((values, i) => {
      const row = ws.getRow(i + 2);
      for (const [column, value] of Object.entries(values)) {
        expect(columns[column], `${sheetName} has a ${column} column`).toBeTruthy();
        row.getCell(columns[column]).value = value;
      }
    });
  }
  return Buffer.from(await book.xlsx.writeBuffer());
}

const goodSheets = () => {
  const cghs = category("cghs");
  return {
    Groups: [{ group_code: code("G"), name: `P212 group ${tag}`, sort_order: 90 }],
    Subgroups: [
      { subgroup_code: code("PROC"), group_code: code("G"), name: "P212 procedures" },
      { subgroup_code: code("OPD"), group_code: code("G"), name: "P212 consultations" },
    ],
    Items: [
      {
        item_code: code("DRESS"),
        name: `P212 dressing ${tag}`,
        subgroup_code: code("PROC"),
        base_price: 200,
        kind: "procedure",
      },
      {
        item_code: code("FEE"),
        name: `P212 consultation ${tag}`,
        subgroup_code: code("OPD"),
        base_price: 900,
        kind: "consultation",
        doctor: String(seed.doctor.id),
        visit_type: "New",
      },
      {
        item_code: code("TEST"),
        name: `P212 ${TEST_NAME}`,
        subgroup_code: code("PROC"),
        base_price: 350,
        kind: "test",
        test_name: TEST_NAME,
      },
    ],
    Categories: [
      {
        category_code: cghs,
        label: `P212 CGHS ${tag}`,
        payer_name: "P212 payer",
        requires_ref: "yes",
      },
      { category_code: category("paid"), label: "Paid", parent_code: cghs },
      {
        category_code: category("ref"),
        label: "Referral",
        parent_code: cghs,
        requires_referral: "yes",
      },
      { category_code: category("pen"), label: "Pensioner", parent_code: cghs },
    ],
    "Category rules": [
      {
        category_code: category("pen"),
        rule_name: "P212 card 60+",
        min_age: 60,
        requires_card: "yes",
        mode: "suggest",
      },
    ],
    "Category rates": [
      {
        category_code: cghs,
        item_code: code("DRESS"),
        valid_from: "2026-10-01",
        rate: 150,
        bill_code: `SM${tag}`.toUpperCase(),
      },
    ],
  };
};

const badSheets = () => ({
  Groups: [{ group_code: code("G2"), name: `P212 group two ${tag}` }],
  Subgroups: [{ subgroup_code: code("SUB2"), group_code: code("G2"), name: "P212 two" }],
  Items: [
    {
      item_code: code("OK2"),
      name: "P212 fine",
      subgroup_code: code("SUB2"),
      base_price: 10,
      kind: "other",
    },
    {
      item_code: code("BAD2"),
      name: "P212 broken",
      subgroup_code: code("SUB2"),
      base_price: "₹1,200",
      kind: "other",
    },
  ],
  Categories: [{ category_code: category("two"), label: `P212 two ${tag}` }],
});

const SHEETS = ["Groups", "Subgroups", "Items", "Categories", "Category rules", "Category rates"];
const EXPECTED = [1, 2, 3, 4, 1, 1];

const tagged = async () =>
  one(
    `SELECT (SELECT count(*) FROM service_groups WHERE code ILIKE $1)::int AS groups,
            (SELECT count(*) FROM service_subgroups WHERE code ILIKE $1)::int AS subgroups,
            (SELECT count(*) FROM service_items WHERE code ILIKE $1)::int AS items,
            (SELECT count(*) FROM patient_schemes WHERE code LIKE $2)::int AS categories,
            (SELECT count(*) FROM category_rules WHERE scheme_code LIKE $2)::int AS rules,
            (SELECT count(*) FROM category_item_rates WHERE scheme_code LIKE $2)::int AS rates`,
    [`P212_%_${tag}`, `p212_%_${tag}`],
  );

const picker = (page) => page.getByLabel("Filled-in template (.xlsx)", { exact: true });
const preview = (page) => page.getByRole("region", { name: "Preview", exact: true });
const importButton = (page) => preview(page).getByRole("button", { name: "Import", exact: true });
const countsOf = (page, name) =>
  page.getByRole("list", { name, exact: true }).getByRole("listitem");

async function open(page) {
  await loginAs(page, "reception_admin");
  await gotoReady(page, "/settings/bulk-import", () => picker(page));
}

async function upload(page, name, buffer) {
  await picker(page).setInputFiles({ name, mimeType: XLSX_TYPE, buffer });
  await expect(preview(page)).toContainText(name);
}

test.describe.serial("P2-12 smoke files through the Bulk import page", () => {
  test.describe.configure({ retries: 1 });

  test.beforeAll(async () => {
    seed.doctor = await one(
      `INSERT INTO doctors (name, role, is_active) VALUES ($1, 'consultant', TRUE) RETURNING id`,
      [DOCTOR],
    );
    seed.test = await one(
      `INSERT INTO giniflow_test_catalog (test_name, price) VALUES ($1, 90) RETURNING id`,
      [TEST_NAME],
    );
  });

  test.afterAll(async () => {
    await query(`DELETE FROM category_item_rates WHERE scheme_code LIKE $1`, ["p212%"]);
    await query(`DELETE FROM category_rules WHERE scheme_code LIKE $1`, ["p212%"]);
    await query(`DELETE FROM patient_schemes WHERE parent_code LIKE $1`, ["p212%"]);
    await query(`DELETE FROM patient_schemes WHERE code LIKE $1`, ["p212%"]);
    await query(`DELETE FROM service_items WHERE code ILIKE $1`, ["P212%"]);
    await query(`DELETE FROM doctors WHERE name = $1`, [DOCTOR]);
    await query(`DELETE FROM giniflow_test_catalog WHERE test_name = $1`, [TEST_NAME]);
    await query(`DELETE FROM service_subgroups WHERE code ILIKE $1`, ["P212%"]);
    await query(`DELETE FROM service_groups WHERE code ILIKE $1`, ["P212%"]);
  });

  test("1. the good file (CGHS with three sub-categories) imports every row", async ({ page }) => {
    await open(page);
    await upload(page, fileName("good"), await workbook(goodSheets()));
    await expect(countsOf(page, "All sheets")).toHaveText(["12 new", "1 with warnings"]);
    for (const [i, sheet] of SHEETS.entries()) {
      await expect(countsOf(page, `${sheet} counts`), sheet).toHaveText(
        sheet === "Items" ? ["3 new", "1 with warnings"] : [`${EXPECTED[i]} new`],
      );
    }
    const warned = page.getByRole("table", { name: "Items rows", exact: true }).getByRole("row");
    await expect(warned.nth(1)).toContainText(
      `subgroup_code: ${TEST_NAME} is a Lab test, but P212 procedures is in the P212 group ${tag} group`,
    );
    await importButton(page).click();
    const dialog = page.getByRole("dialog", { name: `Import ${fileName("good")}?`, exact: true });
    await expect(dialog).toContainText("12 new rows and 0 updates will be saved");
    await dialog.getByRole("button", { name: "Yes, import", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: `Imported ${fileName("good")}`, exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("list", { name: "What was saved", exact: true }).getByRole("listitem"),
    ).toHaveText(SHEETS.map((sheet, i) => `${sheet}: ${EXPECTED[i]} new`));

    expect(await tagged()).toEqual({
      groups: 1,
      subgroups: 2,
      items: 3,
      categories: 4,
      rules: 1,
      rates: 1,
    });
    const subs = await query(
      `SELECT label FROM patient_schemes WHERE parent_code = $1 ORDER BY label`,
      [category("cghs")],
    );
    expect(subs.rows.map((r) => r.label)).toEqual(["Paid", "Pensioner", "Referral"]);
    const links = await one(
      `SELECT (SELECT doctor_id FROM service_items WHERE code = $1) AS doctor,
              (SELECT test_catalog_id FROM service_items WHERE code = $2) AS test`,
      [code("FEE"), code("TEST")],
    );
    expect(links).toEqual({ doctor: seed.doctor.id, test: seed.test.id });
    const imported = await query(`SELECT status FROM billing_imports WHERE file_name = $1`, [
      fileName("good"),
    ]);
    expect(imported.rows).toEqual([{ status: "saved" }]);
    await expect(
      page
        .getByRole("table", { name: "Past imports", exact: true })
        .getByRole("row")
        .filter({ hasText: fileName("good") }),
    ).toContainText("Saved");
  });

  test("2. the same file again is all unchanged and can't be imported", async ({ page }) => {
    const before = await tagged();
    await open(page);
    await upload(page, fileName("again"), await workbook(goodSheets()));
    await expect(countsOf(page, "All sheets")).toHaveText(["12 unchanged", "1 with warnings"]);
    for (const [i, sheet] of SHEETS.entries()) {
      await expect(countsOf(page, `${sheet} counts`), sheet).toHaveText(
        sheet === "Items" ? ["3 unchanged", "1 with warnings"] : [`${EXPECTED[i]} unchanged`],
      );
    }
    const items = page.getByRole("table", { name: "Items rows", exact: true }).getByRole("row");
    await expect(items).toHaveCount(2);
    await expect(items.nth(1).getByRole("cell").nth(1)).toHaveText("Unchanged");
    await expect(preview(page).getByRole("table")).toHaveCount(1);
    await expect(importButton(page)).toBeDisabled();
    expect(await tagged()).toEqual(before);
  });

  test("3. the file with one bad row imports nothing and offers the error download", async ({
    page,
  }) => {
    const before = await tagged();
    await open(page);
    const name = fileName("bad");
    await upload(page, name, await workbook(badSheets()));
    await expect(countsOf(page, "All sheets")).toHaveText(["4 new", "1 with errors"]);
    await expect(importButton(page)).toBeDisabled();
    const bad = page.getByRole("table", { name: "Items rows", exact: true }).getByRole("row");
    await expect(bad.nth(1)).toContainText("Error");
    await expect(bad.nth(1)).toContainText('typed "₹1,200"');

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      preview(page).getByRole("button", { name: "Download errors", exact: true }).click(),
    ]);
    expect(download.suggestedFilename()).toBe(`p212-bad-${tag} - errors.xlsx`);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(fs.readFileSync(await download.path()));
    const ws = wb.getWorksheet("Items");
    const col = ws.getRow(1).values.slice(1).indexOf(ERROR_COLUMN) + 1;
    expect(col).toBeGreaterThan(0);
    expect(ws.getRow(3).getCell(col).text).not.toBe("");
    expect(ws.getRow(2).getCell(col).text).toBe("");

    expect(await tagged()).toEqual(before);
    const imported = await query(`SELECT 1 FROM billing_imports WHERE file_name = $1`, [name]);
    expect(imported.rows).toEqual([]);
  });
});
