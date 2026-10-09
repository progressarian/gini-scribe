import { test, expect } from "@playwright/test";
import { one } from "../../helpers/db.mjs";
import { loginAs } from "../../helpers/auth.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { desk, extraVisit, newTag, setUp, tearDown } from "../phase4/p4-bills-fixture.mjs";
import { db } from "../phase4b/p4b-refunds.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const deposits = await import("../../../server/services/billing/deposits.js");
const reports = await import("../../../server/services/billing/reports.js");
const exporter = await import("../../../server/services/billing/reportsExport.js");

const tag = newTag();
let ids;
let away;
let here;

const holders = (page) => page.getByRole("region", { name: "Patients holding a deposit now" });

test.describe.serial("D05 the patients holding a deposit, and opening one at the counter", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    away = (
      await one(`INSERT INTO patients (name, file_no) VALUES ($1, $2) RETURNING id`, [
        `P4 Away ${tag}`,
        `F4Away-${tag}`,
      ])
    ).id;
    here = await extraVisit(ids, "Here", { healthray: false });
    for (const [patient, amount] of [
      [away, 2500],
      [here.patient, 700],
    ]) {
      await deposits.receiveDeposit(
        patient,
        { mode: "upi", amount, reference: `UPI-${tag}` },
        desk,
        db,
      );
    }
  });

  test.afterAll(async () => {
    await tearDown(ids);
  });

  test("1. the list carries each holder's id for the link, and the Excel file leaves it out", async () => {
    const result = await reports.runReport("deposits", {}, db);
    const part = result.sections.find((section) => section.key === "holders");
    const row = part.rows.find((entry) => entry.patient_name === `P4 Away ${tag}`);
    expect(row).toMatchObject({ patient_id: away, balance: 250000, available: 250000 });
    const { buffer } = await exporter.reportWorkbook("deposits", {}, db);
    const ExcelJS = (await import("exceljs")).default;
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(buffer);
    const sheet = book.worksheets.find((ws) => ws.name.startsWith("Patients holding"));
    const headers = sheet.getRow(1).values.filter(Boolean);
    expect(headers).toContain("Deposit balance");
    expect(headers).not.toContain("Counter");
  });

  test("2. an admin opens a holder with no visit today and gets their deposit at the counter", async ({
    page,
  }) => {
    await loginAs(page, "admin");
    await gotoReady(page, "/billing/reports?report=deposits", () => holders(page));
    const row = holders(page).getByRole("row", { name: new RegExp(`P4 Away ${tag}`) });
    await expect(row).toContainText("₹2,500");
    await row.getByRole("link", { name: "Open at counter" }).click();
    await expect(page).toHaveURL(new RegExp(`tab=bill.*patient=${away}`));
    await expect(page.getByText("No visit on the floor today")).toBeVisible();
    const panel = page.getByRole("region", { name: "Patient deposit" });
    await expect(panel).toContainText("₹2,500");
    await expect(panel).toContainText(`P4 Away ${tag}`);
  });

  test("3. a holder who is here today opens straight onto their bill", async ({ page }) => {
    await loginAs(page, "admin");
    await gotoReady(page, "/billing/reports?report=deposits", () => holders(page));
    await holders(page)
      .getByRole("row", { name: new RegExp(`P4 Here ${tag}`) })
      .getByRole("link", { name: "Open at counter" })
      .click();
    await expect(page).toHaveURL(new RegExp(`visit=${here.visit}`));
    await expect(page.getByText("No visit on the floor today")).toHaveCount(0);
  });
});
