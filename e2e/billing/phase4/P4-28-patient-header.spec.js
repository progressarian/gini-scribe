import { test, expect } from "@playwright/test";
import { getPool, query } from "../../helpers/db.mjs";
import { loginAs } from "../../helpers/auth.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { desk, extraVisit, newTag, payRule, setUp, tearDown } from "./p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");

const db = getPool();
const tag = newTag();
const PATIENT = `P4 Patient ${tag}`;
let ids;
let second;

const open = (page, visitId) =>
  gotoReady(page, `/giniflow/station/billing?visit=${visitId}`, () =>
    page.getByRole("region", { name: "Bill lines" }),
  );

const header = (page) => page.getByRole("region", { name: "Patient", exact: true });

const patientPays = (page) =>
  page.getByRole("table", { name: "Bill lines" }).getByRole("row").nth(1).getByRole("cell").nth(6);

test.describe.serial("P4-28 patient header", () => {
  test.describe.configure({ retries: 1 });

  test.beforeAll(async () => {
    ids = await setUp(tag);
    await payRule(ids, ids.paid, {
      name: "paid consults",
      service_item_id: ids.consultDoctorNew,
      patient_pays: "amount",
      patient_value: 700,
    });
    await payRule(ids, ids.pensioner, { name: "pensioner pays nothing", patient_pays: "nothing" });
    ids.bill = (await bills.openDraft(ids.visit, desk, db)).id;
    await bills.addLine(ids.bill, { item_id: ids.consultDoctorNew }, desk, db);
    await bills.setCategory(ids.bill, { category: ids.paid }, desk, db);

    second = await extraVisit(ids, "Suggest");
    await query(`UPDATE appointments SET patient_category = $2 WHERE id = $1`, [
      second.appointment,
      ids.parent,
    ]);
  });

  test.afterAll(async () => {
    await tearDown(ids);
  });

  test("1. the header names the patient, their UHID and their age", async ({ page }) => {
    await loginAs(page, "reception");
    await open(page, ids.visit);
    await expect(header(page).getByRole("heading", { name: PATIENT })).toBeVisible();
    await expect(header(page).getByText(`F4-${tag}`)).toBeVisible();
    await expect(header(page).getByText("55M", { exact: false })).toBeVisible();
  });

  test("2. changing CGHS Paid to Pensioner reprices the bill on screen", async ({ page }) => {
    await loginAs(page, "reception");
    await open(page, ids.visit);
    await expect(page.getByText(`P4 CGHS ${tag} › Paid`)).toBeVisible();
    await expect(patientPays(page)).toHaveText("₹700");

    await page.getByLabel("Category").selectOption(ids.pensioner);
    await page.getByRole("button", { name: "Confirm category" }).click();

    await expect(page.getByText(`P4 CGHS ${tag} › Pensioner`)).toBeVisible();
    await expect(patientPays(page)).toHaveText("₹0");
    expect((await bills.readBill(ids.bill, db)).category).toBe(ids.pensioner);
  });

  test("3. the bare parent is never offered — only its sub-categories are", async ({ page }) => {
    await loginAs(page, "reception");
    await open(page, ids.visit);
    await expect(page.locator(`option[value="${ids.parent}"]`)).toHaveCount(0);
    await expect(page.locator(`optgroup[label="P4 CGHS ${tag}"]`)).toHaveCount(1);
    for (const code of [ids.paid, ids.pensioner, ids.referral]) {
      await expect(page.locator(`option[value="${code}"]`)).toHaveCount(1);
    }
  });

  test("4. card, referral and scan appear only where the sub-category needs them", async ({
    page,
  }) => {
    await loginAs(page, "reception");
    await open(page, ids.visit);
    await page.getByLabel("Category").selectOption(ids.pensioner);
    await page.getByRole("button", { name: "Confirm category" }).click();
    await expect(page.getByText(`› Pensioner`)).toBeVisible();
    await expect(page.getByLabel("Referral number")).toHaveCount(0);
    await expect(page.getByLabel("Referral scan", { exact: false })).toHaveCount(0);

    await page.getByLabel("Category").selectOption(ids.referral);
    await page.getByRole("button", { name: "Confirm category" }).click();
    await expect(page.getByLabel("Referral number")).toBeVisible();
    await expect(page.getByLabel("Referral scan", { exact: false })).toBeVisible();
  });

  test("5. a suggested sub-category is applied in one tap", async ({ page }) => {
    await loginAs(page, "reception");
    await open(page, second.visit);
    await expect(page.getByText("Category not confirmed")).toBeVisible();
    await page.getByRole("button", { name: `P4 CGHS ${tag} › Pensioner` }).click();
    await expect(page.getByText(`P4 CGHS ${tag} › Pensioner`)).toBeVisible();
  });
});
