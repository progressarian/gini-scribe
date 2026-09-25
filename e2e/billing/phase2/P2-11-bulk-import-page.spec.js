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
  await wb.xlsx.load(await templateBuffer({ examples: false }));
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
  Discounts: [
    { rule_name: `P211 Discount ${T}`, method: "code", code: `P211D${T}`, kind: "flat", value: 25 },
  ],
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
const card = (page) => page.getByRole("region", { name: /^Import( report)?$/ });
const commitButton = (page) => card(page).getByRole("button", { name: "Commit", exact: true });
const summary = (page) =>
  page.getByRole("list", { name: "All rows", exact: true }).getByRole("listitem");
const chip = (page, name) =>
  page
    .getByRole("group", { name: "Show rows", exact: true })
    .getByRole("button", { name: new RegExp(`^${name} · `) });
const table = (page) => page.getByRole("table", { name: "Import rows", exact: true });
const bodyRows = (page) => table(page).locator("tbody tr");
const rowOf = (page, key) => bodyRows(page).filter({ has: page.getByText(key, { exact: true }) });
const commitDialog = (page, name) =>
  page.getByRole("dialog", { name: `Commit ${name}?`, exact: true });
const outcome = (page) =>
  page.getByRole("list", { name: "What happened", exact: true }).getByRole("listitem");
const history = (page) => page.getByRole("table", { name: "Past imports", exact: true });

async function openPage(page, role = "reception_admin") {
  await loginAs(page, role);
  await gotoReady(page, PAGE, () => picker(page));
}

async function upload(page, name, buffer) {
  await picker(page).setInputFiles({ name, mimeType: XLSX_TYPE, buffer });
}

async function commitAll(page, name, rows) {
  await commitButton(page).click();
  await commitDialog(page, name)
    .getByRole("button", { name: `Yes, save ${rows} ${rows === 1 ? "row" : "rows"}`, exact: true })
    .click();
  await expect(page.getByRole("heading", { name: `Imported ${name}`, exact: true })).toBeVisible({
    timeout: 30_000,
  });
}

const importsNamed = async (name) =>
  (
    await query(
      `SELECT status, imported_by, counts FROM billing_imports WHERE file_name = $1 ORDER BY id`,
      [name],
    )
  ).rows;

const HOOK_CALLS = {
  "get /template": "`${IMPORT}/template`",
  "get /history": "`${IMPORT}/history`",
  "post /sessions": "sendFile(SESSIONS, file)",
  "get /sessions/:id": "read(`${SESSIONS}/${id}`)",
  "get /sessions/:id/rows": "read(`${SESSIONS}/${id}/rows`",
  "post /sessions/:id/decisions": "api.post(`${SESSIONS}/${id}/decisions`",
  "post /sessions/:id/commit": "api.post(`${SESSIONS}/${id}/commit`",
  "get /sessions/:id/failed": ".get(`${SESSIONS}/${id}/failed`",
  "post /sessions/:id/abandon": "api.post(`${SESSIONS}/${id}/abandon`",
};

test.describe("P2-11 bulk import page — wiring", () => {
  test("0. the page is gated by billing master and has a hook for every import route", () => {
    expect(PAGE_CAPABILITIES[PAGE]).toBe(CAPABILITIES.BILLING_MASTER);
    const read = (file) => fs.readFileSync(path.join(repoRoot, file), "utf8");
    const source = read("server/routes/billingImport.js");
    const routes = [
      ...source.matchAll(
        /router\.(get|post)\(\s*(?:`\$\{BASE\}([^`]*)`|`\$\{SESSIONS\}([^`]*)`|(SESSIONS)\s*,)/g,
      ),
    ].map(([, method, base, session, bare]) =>
      base !== undefined ? `${method} ${base}` : `${method} /sessions${bare ? "" : session}`,
    );
    expect(routes.sort()).toEqual(Object.keys(HOOK_CALLS).sort());
    const hooks = read("src/queries/hooks/useBillingMaster.js");
    for (const [route, call] of Object.entries(HOOK_CALLS)) expect(hooks, route).toContain(call);
    for (const retired of ["preview", "commit", "errors"]) {
      expect(hooks, retired).not.toContain(`\`\${IMPORT}/${retired}\``);
    }
    expect(read("src/router.jsx")).toMatch(
      /\{ path: "bulk-import", element: lazyEl\(BillingImportPage\) \}/,
    );
  });
});

test.describe.serial("P2-11 bulk import page", () => {
  test.describe.configure({ retries: 1 });

  test.afterAll(async () => {
    await query(`DELETE FROM billing_import_sessions WHERE file_name ILIKE $1`, [`%${tag}%`]);
    await query(`DELETE FROM discount_rules WHERE name LIKE $1`, ["P211 Discount %"]);
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

  test("2. a good file is checked with its counts, committed, and shows in the history with its report", async ({
    page,
  }) => {
    await openPage(page);
    await upload(page, fileName("good"), await workbook(good()));
    await expect(card(page)).toContainText(fileName("good"), { timeout: 30_000 });
    await expect(summary(page)).toHaveText(["4 ready"]);
    await expect(rowOf(page, ITEM)).toContainText("Ready");
    await expect(table(page)).toContainText(`P211 Discount ${T}`);
    await expect(
      card(page).getByRole("button", { name: "Download failed rows", exact: true }),
    ).toHaveCount(0);
    expect(await query(`SELECT 1 FROM service_groups WHERE code = $1`, [GROUP])).toMatchObject({
      rows: [],
    });

    await commitButton(page).click();
    const dialog = commitDialog(page, fileName("good"));
    await expect(dialog.getByRole("list", { name: "What will happen" })).toContainText(
      "4 rows will be saved — new rows, and the changes you chose to override",
    );
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect((await query(`SELECT 1 FROM service_groups WHERE code = $1`, [GROUP])).rows).toEqual([]);

    await commitAll(page, fileName("good"), 4);
    await expect(outcome(page)).toHaveText([
      "4 saved",
      "0 kept as they were — not changed",
      "0 failed — skipped",
      "0 unchanged",
    ]);
    const sessionId = new URL(page.url()).searchParams.get("session");

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

    await openPage(page);
    await expect(card(page)).toHaveCount(0);
    const mine = history(page)
      .getByRole("row")
      .filter({ hasText: fileName("good") });
    await expect(mine).toHaveCount(1);
    await expect(mine).toContainText(USERS.reception_admin.name);
    await expect(mine).toContainText("Saved");
    await expect(mine).toContainText("Items: 1 new");
    await expect(history(page).getByRole("row").nth(1)).toContainText(fileName("good"));
    await mine
      .getByRole("link", { name: `View the report for ${fileName("good")}`, exact: true })
      .click();
    await expect(page.getByRole("heading", { name: "Import report", exact: true })).toBeVisible();
    expect(new URL(page.url()).searchParams.get("session")).toBe(sessionId);
    await expect(outcome(page).first()).toHaveText("4 saved");
  });

  test("3. a changed row shows what changes and is saved only when overridden", async ({
    page,
  }) => {
    await openPage(page, "admin");
    await upload(page, fileName("rename"), await workbook(good(`P211 Renamed ${T}`)));
    await expect(summary(page)).toHaveText(["1 needs override", "3 unchanged"], {
      timeout: 30_000,
    });
    await chip(page, "Unchanged").click();
    await expect(bodyRows(page)).toHaveCount(3);
    await chip(page, "Needs override").click();
    await expect(bodyRows(page)).toHaveCount(1);
    const group = rowOf(page, GROUP);
    await expect(group).toContainText("Needs override");
    await expect(group).toContainText(`name: P211 Group ${T} → P211 Renamed ${T}`);
    await expect(group).toContainText("Undecided — will be kept");
    await expect(commitButton(page)).toBeDisabled();

    await group.getByRole("button", { name: "Override Groups row 2", exact: true }).click();
    await expect(group).toContainText("Override — will be saved");
    await commitAll(page, fileName("rename"), 1);
    await expect(outcome(page)).toHaveText([
      "1 saved",
      "0 kept as they were — not changed",
      "0 failed — skipped",
      "3 unchanged",
    ]);
    expect((await query(`SELECT name FROM service_groups WHERE code = $1`, [GROUP])).rows).toEqual([
      { name: `P211 Renamed ${T}` },
    ]);
    await expect(
      history(page)
        .getByRole("row")
        .filter({ hasText: fileName("rename") }),
    ).toContainText(USERS.admin.name);
  });

  test("4. the same file again has nothing to save, so Commit stays off", async ({ page }) => {
    await openPage(page);
    await upload(page, fileName("again"), await workbook(good(`P211 Renamed ${T}`)));
    await expect(summary(page)).toHaveText(["4 unchanged"], { timeout: 30_000 });
    await expect(commitButton(page)).toBeDisabled();
    await expect(card(page)).toContainText(
      "Nothing to save yet — no row is ready and no change is overridden.",
    );
  });

  test("5. a file with errors lists the failed rows with their reasons, downloads them, and commits only the good row", async ({
    page,
  }) => {
    await openPage(page);
    const name = fileName("errors");
    await upload(page, name, await workbook(withErrors()));
    await expect(summary(page)).toHaveText(["1 ready", "2 failed"], { timeout: 30_000 });
    await chip(page, "Failed").click();
    await expect(bodyRows(page)).toHaveCount(2);

    const sub = rowOf(page, `P211S_BAD_${T}`);
    await expect(sub.getByRole("cell").nth(0)).toContainText("Subgroups");
    await expect(sub.getByRole("cell").nth(0)).toContainText("row 2");
    await expect(sub.getByRole("cell").nth(2)).toHaveText("Failed");
    await expect(sub).toContainText("group_code:");
    await expect(sub).toContainText(`typed "P211_NOPE_${T}"`);
    const item = rowOf(page, `P211I_BAD_${T}`);
    await expect(item).toContainText("base_price:");
    await expect(item).toContainText('typed "₹1,200"');

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      card(page).getByRole("button", { name: "Download failed rows", exact: true }).click(),
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

    await commitAll(page, name, 1);
    await expect(outcome(page)).toHaveText([
      "1 saved",
      "0 kept as they were — not changed",
      "2 failed — skipped",
      "0 unchanged",
    ]);
    expect(
      (await query(`SELECT 1 FROM service_groups WHERE code = $1`, [`P211G_BAD_${T}`])).rows,
    ).toHaveLength(1);
    expect(
      (await query(`SELECT 1 FROM service_subgroups WHERE code = $1`, [`P211S_BAD_${T}`])).rows,
    ).toEqual([]);
    expect(
      (await query(`SELECT 1 FROM service_items WHERE code = $1`, [`P211I_BAD_${T}`])).rows,
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
    await expect(card(page)).toHaveCount(0);

    await picker(page).setInputFiles({
      name: `p211-${tag}.csv`,
      mimeType: "text/csv",
      buffer: Buffer.from("a,b"),
    });
    await expect(
      page.getByRole("region", { name: "Bulk import", exact: true }).getByRole("alert"),
    ).toHaveText("File name must end in .xlsx — upload the Excel template");
    await expect(card(page)).toHaveCount(0);
  });

  test("7. a row changed in Scribe after the upload fails at commit instead of being overwritten", async ({
    page,
  }) => {
    await openPage(page);
    const name = fileName("raced");
    await upload(page, name, await workbook(good(`P211 Raced ${T}`)));
    await expect(summary(page)).toHaveText(["1 needs override", "3 unchanged"], {
      timeout: 30_000,
    });
    await chip(page, "Needs override").click();
    await rowOf(page, GROUP)
      .getByRole("button", { name: "Override Groups row 2", exact: true })
      .click();
    await expect(rowOf(page, GROUP)).toContainText("Override — will be saved");
    await query(`UPDATE service_groups SET name = $2 WHERE code = $1`, [
      GROUP,
      `P211 Meanwhile ${T}`,
    ]);

    await commitAll(page, name, 1);
    await expect(outcome(page)).toHaveText([
      "0 saved",
      "0 kept as they were — not changed",
      "1 failed — skipped",
      "3 unchanged",
    ]);
    await chip(page, "Failed").click();
    await expect(rowOf(page, GROUP)).toContainText(
      `Changed since you uploaded (now name "P211 Meanwhile ${T}") — upload again`,
    );
    expect((await query(`SELECT name FROM service_groups WHERE code = $1`, [GROUP])).rows).toEqual([
      { name: `P211 Meanwhile ${T}` },
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
      session_id: null,
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
    await expect(history(page).getByRole("link")).toHaveCount(0);
    await page.getByRole("button", { name: "Older", exact: true }).click();
    await expect(page.getByText("26–30 of 30", { exact: true })).toBeVisible();
    await expect(history(page).getByRole("row")).toHaveCount(6);
    await expect(history(page).getByRole("row").nth(1)).toContainText("Failed");
    await expect(page.getByRole("button", { name: "Older", exact: true })).toBeDisabled();
    expect(offsets).toContain(25);
  });

  test("9. on a phone the import fits the screen", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await openPage(page);
    await upload(page, fileName("phone"), await workbook(withErrors()));
    await expect(table(page)).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      )
      .toBe(0);
  });
});

test.describe("P2-11 bulk import page — review", () => {
  test("10. review: a failed request says why — no answer from the server, or its status", async ({
    page,
  }) => {
    await openPage(page, "admin");
    const download = page.getByRole("button", { name: "Download template", exact: true });
    await page.route("**/api/billing/import/template", (route) => route.abort("connectionrefused"));
    await download.click();
    await expect(page.locator(".toast").last()).toContainText(
      "Could not download the template: Scribe's server didn't answer — check it is running, then try again",
    );
    await page.unroute("**/api/billing/import/template");
    await page.route("**/api/billing/import/template", (route) =>
      route.fulfill({ status: 502, contentType: "text/html", body: "<h1>Bad gateway</h1>" }),
    );
    await download.click();
    await expect(page.locator(".toast").last()).toContainText(
      "Could not download the template (the server answered 502)",
    );
    await page.route("**/api/billing/import/sessions**", (route) =>
      route.abort("connectionrefused"),
    );
    await upload(page, "prices.xlsx", Buffer.from("x"));
    await expect(
      page.getByRole("alert").filter({ hasText: "Could not check the file" }),
    ).toContainText("Scribe's server didn't answer");
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
