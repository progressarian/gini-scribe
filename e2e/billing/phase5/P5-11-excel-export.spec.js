import fs from "node:fs";
import { test, expect } from "@playwright/test";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { loginAs } from "../../helpers/auth.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { newTag } from "../phase4/p4-bills-fixture.mjs";
import { db, SEED_WAIT_MS, seedReports, unseed } from "./p5-reports-seed.mjs";
import { REPORTS_PATH, callAs, mountReports, proxyReports, readWorkbook } from "./p5-http.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const reports = await import("../../../server/services/billing/reports.js");

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const TOTALLED = new Set(["money", "count", "quantity"]);

const tag = newTag();
let ids;
let api;

const day = () => ({ from: ids.privateDay, to: ids.privateDay });

function expectSheetMatches(sheet, part) {
  const [header, ...body] = sheet.rows;
  expect(header, part.key).toEqual(part.columns.map((column) => column.label));
  const data = body.slice(0, part.rows.length);
  expect(data.length, `${part.key} rows`).toBe(part.rows.length);
  const totalRow = body[part.rows.length];
  if (!part.total) return;
  expect(totalRow[0], `${part.key} total label`).toBe("Total");
  part.columns.forEach((column, index) => {
    if (!TOTALLED.has(column.kind)) return;
    const cell = Number(totalRow[index] ?? 0);
    const asPaise = column.kind === "money" ? Math.round(cell * 100) : cell;
    expect(asPaise, `${part.key} total ${column.key}`).toBe(part.total[column.key]);
    const moneyRows = data.map((row) => Number(row[index] ?? 0));
    if (column.kind === "money") {
      part.rows.forEach((row, n) => {
        expect(Math.round(moneyRows[n] * 100), `${part.key} row ${n} ${column.key}`).toBe(
          row[column.key],
        );
      });
    }
  });
}

test.describe.serial("P5-11 Excel export", () => {
  test.beforeAll(async () => {
    test.setTimeout(SEED_WAIT_MS + 60000);
    ids = await seedReports(tag);
    api = await mountReports();
  });

  test.afterAll(async () => {
    await api?.close();
    await unseed(ids);
  });

  test("1. every report downloads as .xlsx with the same filters and the same totals", async () => {
    for (const key of reports.REPORT_KEYS) {
      const res = await callAs(api.url, "admin", `${REPORTS_PATH}/${key}/export`, day());
      expect(res.status, key).toBe(200);
      expect(res.headers.get("content-type")).toContain(XLSX);
      expect(res.headers.get("content-disposition")).toBe(
        `attachment; filename="billing-${key.replace(/_/g, "-")}-${ids.privateDay}-to-${ids.privateDay}.xlsx"`,
      );
      const sheets = await readWorkbook(res.body);
      const screen = await reports.runReport(key, day(), db);
      expect(sheets.map((sheet) => sheet.name)).toEqual([
        "Filters",
        ...screen.sections.map((part) => part.title.replace(/›/g, ">").slice(0, 31).trim()),
      ]);
      const filters = Object.fromEntries(sheets[0].rows.slice(1));
      expect(filters).toMatchObject({
        Report: screen.title,
        From: ids.privateDay,
        To: ids.privateDay,
      });
      screen.sections.forEach((part, index) => expectSheetMatches(sheets[index + 1], part));
    }
  });

  test("2. the filters travel into the file", async () => {
    const res = await callAs(api.url, "admin", `${REPORTS_PATH}/collections/export`, {
      ...day(),
      sub_category: ids.paid,
    });
    const sheets = await readWorkbook(res.body);
    const filters = Object.fromEntries(sheets[0].rows.slice(1));
    expect(filters["Sub-category"]).toBe(`Paid (${ids.paid})`);
    const screen = await reports.runReport("collections", { ...day(), sub_category: ids.paid }, db);
    screen.sections.forEach((part, index) => expectSheetMatches(sheets[index + 1], part));
    expect(screen.sections[0].total.net).toBe(30000);

    const refused = await callAs(api.url, "admin", `${REPORTS_PATH}/coupons/export`, {
      ...day(),
      group: "LAB",
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/can't be filtered by group/);
  });

  test("3. in the browser, Download Excel saves the report on screen", async ({ page }) => {
    await loginAs(page, "admin");
    await proxyReports(page, api.url);
    await gotoReady(page, "/billing/reports?report=revenue_categories", () =>
      page.getByRole("tab", { name: "Revenue by category" }),
    );
    await page.getByLabel("From", { exact: true }).fill(ids.privateDay);
    await page.getByLabel("To", { exact: true }).fill(ids.privateDay);
    await page.getByLabel("Sub-category", { exact: true }).selectOption(ids.paid);
    const table = page.getByRole("table", { name: "Category › sub-category" });
    await expect(table.locator("tfoot")).toContainText("₹1,500");
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Download Excel" }).click(),
    ]);
    expect(download.suggestedFilename()).toBe(
      `billing-revenue-categories-${ids.privateDay}-to-${ids.privateDay}.xlsx`,
    );
    const sheets = await readWorkbook(fs.readFileSync(await download.path()));
    const filters = Object.fromEntries(sheets[0].rows.slice(1));
    expect(filters["Sub-category"]).toBe(`Paid (${ids.paid})`);
    const screen = await reports.runReport(
      "revenue_categories",
      { ...day(), sub_category: ids.paid },
      db,
    );
    expectSheetMatches(sheets[1], screen.sections[0]);
  });
});
