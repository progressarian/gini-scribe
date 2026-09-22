import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { test, expect } from "@playwright/test";
import { loginAs } from "../../helpers/auth.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { query } from "../../helpers/db.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { repoRoot } from "../../setup/testEnv.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { PAGE_CAPABILITIES } from "../../../src/config/routes.js";
import { CAPABILITIES } from "../../../shared/permissions.js";
import { templateBuffer } from "../../../server/services/billing/importTemplate.js";
import { ERROR_COLUMN } from "../../../server/services/billing/importColumns.js";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const ExcelJS = createRequire(path.join(repoRoot, "server", "package.json"))("exceljs");

const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PAGE = "/settings/bulk-import";
const tag = crypto.randomBytes(3).toString("hex");
const T = tag.toUpperCase();
const GROUP = `P211G_${T}`;
const SUB = `P211S_${T}`;
const ITEM = `P211I_${T}`;
const fileName = (name) => `p211-${name}-${tag}.xlsx`;

async function workbook(sheets) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await templateBuffer());
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = wb.getWorksheet(name);
    const headers = ws.getRow(1).values.slice(1);
    for (const cells of rows) ws.addRow(headers.map((h) => cells[h] ?? null));
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const good = (groupName = `P211 Group ${T}`) => ({
  Groups: [{ group_code: GROUP, name: groupName }],
  Subgroups: [{ subgroup_code: SUB, group_code: GROUP, name: `P211 Sub ${T}` }],
  Items: [
    {
      item_code: ITEM,
      name: `P211 Item ${T}`,
      subgroup_code: SUB,
      base_price: 250,
      kind: "other",
    },
  ],
  Discounts: [{ rule_name: `P211 Discount ${T}` }],
});

const withErrors = () => ({
  Groups: [{ group_code: `P211G_BAD_${T}`, name: `P211 Bad group ${T}` }],
  Subgroups: [
    { subgroup_code: `P211S_BAD_${T}`, group_code: `P211_NOPE_${T}`, name: "P211 Orphan" },
  ],
  Items: [
    {
      item_code: `P211I_BAD_${T}`,
      name: `P211 Bad item ${T}`,
      subgroup_code: `P211S_BAD_${T}`,
      base_price: "₹1,200",
      kind: "other",
    },
  ],
});

const picker = (page) => page.getByLabel("Filled-in template (.xlsx)", { exact: true });
const preview = (page) => page.getByRole("region", { name: "Preview", exact: true });
const importButton = (page) => preview(page).getByRole("button", { name: "Import", exact: true });
const countsOf = (page, name) =>
  page.getByRole("list", { name, exact: true }).getByRole("listitem");
const rowsOf = (page, sheet) => page.getByRole("table", { name: `${sheet} rows`, exact: true });
const history = (page) => page.getByRole("table", { name: "Past imports", exact: true });

async function openPage(page, role = "reception_admin") {
  await loginAs(page, role);
  await gotoReady(page, PAGE, () => picker(page));
}

async function upload(page, name, buffer) {
  await picker(page).setInputFiles({ name, mimeType: XLSX_TYPE, buffer });
}

const importsNamed = async (name) =>
  (
    await query(
      `SELECT status, imported_by, counts FROM billing_imports WHERE file_name = $1 ORDER BY id`,
      [name],
    )
  ).rows;

test.describe("P2-11 bulk import page — wiring", () => {
  test("0. the page is gated by billing master and has a hook for every import route", () => {
    expect(PAGE_CAPABILITIES[PAGE]).toBe(CAPABILITIES.BILLING_MASTER);
    const read = (file) => fs.readFileSync(path.join(repoRoot, file), "utf8");
    const routes = [
      ...read("server/routes/billingImport.js").matchAll(
        /router\.(get|post)\(\s*`\$\{BASE\}([^`]*)`/g,
      ),
    ].map(([, method, route]) => `${method} ${route}`);
    expect(routes.sort()).toEqual(
      ["get /history", "get /template", "post /commit", "post /errors", "post /preview"].sort(),
    );
    const hooks = read("src/queries/hooks/useBillingMaster.js");
    for (const route of routes) {
      const [method, url] = route.split(" ");
      const call =
        method === "get"
          ? new RegExp(`(read|api\\s*\\.get)\\(\\s*\`\\$\\{IMPORT\\}${url}\``)
          : new RegExp(`sendFile\\(\`\\$\\{IMPORT\\}${url}\``);
      expect(hooks, route).toMatch(call);
    }
    expect(read("src/router.jsx")).toMatch(
      /\{ path: "bulk-import", element: lazyEl\(BillingImportPage\) \}/,
    );
  });
});

test.describe.serial("P2-11 bulk import page", () => {
  test.describe.configure({ retries: 1 });

  test.afterAll(async () => {
    await query(`DELETE FROM service_items WHERE code ILIKE $1`, ["P211I%"]);
    await query(`DELETE FROM service_subgroups WHERE code ILIKE $1`, ["P211S%"]);
    await query(`DELETE FROM service_groups WHERE code ILIKE $1`, ["P211G%"]);
  });

  test("1. the template downloads from the page", async ({ page }) => {
    await openPage(page);
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Download template", exact: true }).click(),
    ]);
    expect(download.suggestedFilename()).toBe("gini-billing-template.xlsx");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(fs.readFileSync(await download.path()));
    for (const sheet of ["Groups", "Subgroups", "Items", "Categories", "Discounts"]) {
      expect(wb.getWorksheet(sheet), sheet).toBeTruthy();
    }
  });

  test("2. a good file is previewed with its counts, imported, and shows in the history", async ({
    page,
  }) => {
    await openPage(page);
    await upload(page, fileName("good"), await workbook(good()));
    await expect(preview(page)).toContainText(fileName("good"));
    await expect(countsOf(page, "All sheets")).toHaveText(["3 new", "1 not imported yet"]);
    await expect(countsOf(page, "Items counts")).toHaveText(["1 new"]);
    await expect(rowsOf(page, "Items")).toContainText(`item_code: ${ITEM}`);
    await expect(countsOf(page, "Discounts counts")).toHaveText(["1 not imported yet"]);
    await expect(
      preview(page).getByRole("region", { name: "Discounts", exact: true }),
    ).toContainText("1 row on this sheet can't be imported yet");
    await expect(rowsOf(page, "Discounts")).toHaveCount(0);
    await expect(
      preview(page).getByRole("button", { name: "Download errors", exact: true }),
    ).toHaveCount(0);
    expect(await query(`SELECT 1 FROM service_groups WHERE code = $1`, [GROUP])).toMatchObject({
      rows: [],
    });

    await importButton(page).click();
    const dialog = page.getByRole("dialog", { name: `Import ${fileName("good")}?`, exact: true });
    await expect(dialog).toContainText("3 new rows and 0 updates will be saved");
    await expect(dialog.getByRole("list", { name: "What will be saved" })).toContainText(
      "Items: 1 new, 0 to update",
    );
    await expect(dialog).toContainText("1 row on Phase 3 sheets will not be imported.");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect((await query(`SELECT 1 FROM service_groups WHERE code = $1`, [GROUP])).rows).toEqual([]);

    await importButton(page).click();
    await dialog.getByRole("button", { name: "Yes, import", exact: true }).click();
    const done = page.getByRole("status").filter({
      has: page.getByRole("heading", { name: `Imported ${fileName("good")}`, exact: true }),
    });
    await expect(done).toBeVisible();
    await expect(
      done.getByRole("list", { name: "What was saved", exact: true }).getByRole("listitem"),
    ).toHaveText(["Groups: 1 new", "Subgroups: 1 new", "Items: 1 new"]);
    await expect(preview(page)).toHaveCount(0);

    const item = await query(
      `SELECT i.name, i.base_price::text AS price, s.code AS sub, g.code AS grp
         FROM service_items i JOIN service_subgroups s ON s.id = i.subgroup_id
         JOIN service_groups g ON g.id = s.group_id WHERE i.code = $1`,
      [ITEM],
    );
    expect(item.rows).toEqual([{ name: `P211 Item ${T}`, price: "250.00", sub: SUB, grp: GROUP }]);
    expect(await importsNamed(fileName("good"))).toMatchObject([
      { status: "saved", imported_by: USERS.reception_admin.id },
    ]);

    const mine = history(page)
      .getByRole("row")
      .filter({ hasText: fileName("good") });
    await expect(mine).toHaveCount(1);
    await expect(mine).toContainText(USERS.reception_admin.name);
    await expect(mine).toContainText("Saved");
    await expect(mine).toContainText("Items: 1 new");
    await expect(history(page).getByRole("row").nth(1)).toContainText(fileName("good"));
  });

  test("3. a changed row shows what changes, unchanged rows are folded away, and it imports", async ({
    page,
  }) => {
    await openPage(page, "admin");
    await upload(page, fileName("rename"), await workbook(good(`P211 Renamed ${T}`)));
    await expect(countsOf(page, "All sheets")).toHaveText([
      "1 to update",
      "2 unchanged",
      "1 not imported yet",
    ]);
    const groups = rowsOf(page, "Groups");
    await expect(groups.getByRole("row")).toHaveCount(2);
    await expect(groups).toContainText("Update");
    await expect(groups).toContainText(`name: P211 Group ${T} → P211 Renamed ${T}`);
    await expect(rowsOf(page, "Items")).toHaveCount(0);
    await expect(preview(page).getByRole("region", { name: "Items", exact: true })).toContainText(
      "1 unchanged row not listed",
    );
    await importButton(page).click();
    await page.getByRole("button", { name: "Yes, import", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: `Imported ${fileName("rename")}`, exact: true }),
    ).toBeVisible();
    expect((await query(`SELECT name FROM service_groups WHERE code = $1`, [GROUP])).rows).toEqual([
      { name: `P211 Renamed ${T}` },
    ]);
    await expect(
      history(page)
        .getByRole("row")
        .filter({ hasText: fileName("rename") }),
    ).toContainText(USERS.admin.name);
  });

  test("4. the same file again has nothing to save, so Import stays off", async ({ page }) => {
    await openPage(page);
    await upload(page, fileName("again"), await workbook(good(`P211 Renamed ${T}`)));
    await expect(countsOf(page, "All sheets")).toHaveText(["3 unchanged", "1 not imported yet"]);
    await expect(importButton(page)).toBeDisabled();
    await expect(preview(page)).toContainText(
      "Nothing to save — every row already matches Scribe.",
    );
  });

  test("5. a file with errors lists the error rows, blocks Import, and downloads the error file", async ({
    page,
  }) => {
    await openPage(page);
    const name = fileName("errors");
    await upload(page, name, await workbook(withErrors()));
    await expect(countsOf(page, "All sheets")).toHaveText(["1 new", "2 with errors"]);
    await expect(importButton(page)).toBeDisabled();

    const sub = rowsOf(page, "Subgroups").getByRole("row").nth(1);
    await expect(sub.getByRole("cell").nth(0)).toHaveText("2");
    await expect(sub.getByRole("cell").nth(1)).toHaveText("Error");
    await expect(sub).toContainText("group_code:");
    await expect(sub).toContainText(`typed "P211_NOPE_${T}"`);
    const item = rowsOf(page, "Items").getByRole("row").nth(1);
    await expect(item).toContainText("base_price:");
    await expect(item).toContainText('typed "₹1,200"');

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      preview(page).getByRole("button", { name: "Download errors", exact: true }).click(),
    ]);
    expect(download.suggestedFilename()).toBe(`p211-errors-${tag} - errors.xlsx`);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(fs.readFileSync(await download.path()));
    const ws = wb.getWorksheet("Subgroups");
    const col = ws.getRow(1).values.slice(1).indexOf(ERROR_COLUMN) + 1;
    expect(col).toBeGreaterThan(0);
    expect(String(ws.getRow(2).getCell(col).value)).toMatch(new RegExp(`P211_NOPE_${T}`, "i"));

    expect(await importsNamed(name)).toEqual([]);
    expect(
      (await query(`SELECT 1 FROM service_groups WHERE code = $1`, [`P211G_BAD_${T}`])).rows,
    ).toEqual([]);
  });

  test("6. a refused file shows its problems; a wrong file name is explained", async ({ page }) => {
    await openPage(page);
    await upload(page, fileName("junk"), Buffer.from("not a spreadsheet"));
    await expect(
      page.getByRole("list", { name: "Problems with the file", exact: true }),
    ).toHaveText(
      "This isn't an Excel .xlsx file; save it as an Excel Workbook (.xlsx) and upload again",
    );
    await expect(importButton(page)).toBeDisabled();
    await expect(
      preview(page).getByRole("button", { name: "Download errors", exact: true }),
    ).toHaveCount(0);

    await picker(page).setInputFiles({
      name: `p211-${tag}.csv`,
      mimeType: "text/csv",
      buffer: Buffer.from("a,b"),
    });
    await expect(
      page.getByRole("region", { name: "Bulk import", exact: true }).getByRole("alert"),
    ).toHaveText("File name must end in .xlsx — upload the Excel template");
    await expect(preview(page)).toHaveCount(0);
  });

  test("7. if the data changed before Import, the new preview is shown and nothing is saved", async ({
    page,
  }) => {
    await openPage(page);
    const name = fileName("raced");
    await upload(page, name, await workbook(good(`P211 Raced ${T}`)));
    await expect(countsOf(page, "All sheets")).toHaveText([
      "1 to update",
      "2 unchanged",
      "1 not imported yet",
    ]);
    await page.route("**/api/billing/import/commit**", async (route) => {
      const response = await route.fetch({
        url: route.request().url().replace("/commit", "/preview"),
      });
      const fresh = await response.json();
      fresh.canImport = false;
      fresh.counts.error = 1;
      fresh.sheets[0].counts.error = 1;
      fresh.sheets[0].rows[0] = {
        ...fresh.sheets[0].rows[0],
        status: "error",
        errors: [{ column: "name", message: "Changed meanwhile" }],
      };
      await route.fulfill({ json: { saved: false, preview: fresh } });
    });
    await importButton(page).click();
    await page.getByRole("button", { name: "Yes, import", exact: true }).click();
    await expect(preview(page).getByRole("alert")).toContainText("Nothing was saved.");
    await expect(rowsOf(page, "Groups")).toContainText("Changed meanwhile");
    await expect(importButton(page)).toBeDisabled();
    expect((await query(`SELECT name FROM service_groups WHERE code = $1`, [GROUP])).rows).toEqual([
      { name: `P211 Renamed ${T}` },
    ]);
  });

  test("8. a long history pages", async ({ page }) => {
    const entry = (id) => ({
      id,
      file_name: `p211-page-${id}.xlsx`,
      imported_at: "2026-09-22T06:00:00.000Z",
      status: id === 26 ? "failed" : "saved",
      counts: { Groups: { new: 1, update: 0, unchanged: 0 } },
      imported_by: USERS.admin.id,
      imported_by_name: USERS.admin.name,
    });
    const offsets = [];
    await page.route("**/api/billing/import/history**", (route) => {
      const offset = Number(new URL(route.request().url()).searchParams.get("offset") ?? 0);
      offsets.push(offset);
      const ids = Array.from({ length: offset ? 5 : 25 }, (_, i) => offset + i + 1);
      route.fulfill({ json: { total: 30, limit: 25, offset, imports: ids.map(entry) } });
    });
    await openPage(page);
    await expect(page.getByText("1–25 of 30", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Newer", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Older", exact: true }).click();
    await expect(page.getByText("26–30 of 30", { exact: true })).toBeVisible();
    await expect(history(page).getByRole("row")).toHaveCount(6);
    await expect(history(page).getByRole("row").nth(1)).toContainText("Failed");
    await expect(page.getByRole("button", { name: "Older", exact: true })).toBeDisabled();
    expect(offsets).toContain(25);
  });

  test("9. on a phone the preview fits the screen", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await openPage(page);
    await upload(page, fileName("phone"), await workbook(withErrors()));
    await expect(rowsOf(page, "Subgroups")).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      )
      .toBe(0);
  });
});

test.describe("P2-11 bulk import page — who is turned away", () => {
  test.describe.configure({ retries: 1 });

  for (const role of ["reception", "coordinator", "lab", "banshali"]) {
    test(`10. ${role} is turned away`, async ({ page }) => {
      await loginAs(page, role);
      await gotoReady(page, PAGE, () => page.locator(".tabs"));
      await expect(page).not.toHaveURL(/\/settings|\/login/);
      await expect(page.locator(".tabs").getByRole("link", { name: /Settings/ })).toHaveCount(0);
      await expect(picker(page)).toHaveCount(0);
    });
  }
});
