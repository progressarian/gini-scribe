import { test, expect } from "@playwright/test";
import { getPool } from "../../helpers/db.mjs";
import { loginAs } from "../../helpers/auth.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { desk, newTag, setUp, tearDown } from "./p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");

const db = getPool();
const tag = newTag();
const PATIENT = `P4 Patient ${tag}`;
let ids;

const counter = (page, search = "") =>
  gotoReady(page, `/giniflow/station/billing${search}`, () =>
    page.getByRole("searchbox", { name: "Search today's patients" }),
  );

const header = (page) => page.getByRole("heading", { name: PATIENT });

test.describe.serial("P4-27 page shell", () => {
  test.describe.configure({ retries: 1 });

  test.beforeAll(async () => {
    ids = await setUp(tag);
    const draft = await bills.openDraft(ids.visit, desk, db);
    await bills.addLine(draft.id, { item_id: ids.consultNew }, desk, db);
  });

  test.afterAll(async () => {
    await tearDown(ids);
  });

  test("1. reception picks today's patient from the list and their bill opens", async ({
    page,
  }) => {
    await loginAs(page, "reception");
    await counter(page);
    await expect(page.getByText("Choose a patient to see their bills.")).toBeVisible();
    await page.getByRole("button", { name: PATIENT }).click();
    await expect(header(page)).toBeVisible();
    await expect(page.getByRole("table", { name: "Bill lines" })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`visit=${ids.visit}`));
  });

  test("2. the search narrows today's list to that patient", async ({ page }) => {
    await loginAs(page, "reception");
    await counter(page);
    await page.getByRole("searchbox", { name: "Search today's patients" }).fill(tag);
    await expect(page.getByRole("button", { name: PATIENT })).toBeVisible();
  });

  test("3. ?visit= opens the patient directly", async ({ page }) => {
    await loginAs(page, "reception");
    await counter(page, `?visit=${ids.visit}`);
    await expect(header(page)).toBeVisible();
  });

  test("4. ?patient= opens the patient directly", async ({ page }) => {
    await loginAs(page, "reception");
    await counter(page, `?patient=${ids.patient}`);
    await expect(header(page)).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`visit=${ids.visit}`));
  });

  test("5. a role without the billing desk cannot open it", async ({ page }) => {
    await loginAs(page, "coordinator");
    await page.goto(`/giniflow/station/billing?visit=${ids.visit}`);
    await expect(header(page)).toHaveCount(0);
    await expect(page).not.toHaveURL(/giniflow\/station\/billing/);
  });

  test("6. the counter fits a phone without scrolling sideways", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginAs(page, "reception");
    await counter(page, `?visit=${ids.visit}`);
    await expect(page.getByRole("table", { name: "Bill lines" })).toBeVisible();
    const overflow = await page.evaluate(() => {
      const root = document.documentElement;
      const cards = [...document.querySelectorAll(".bc-panel .bc-card")];
      return {
        page: root.scrollWidth - root.clientWidth,
        cards: cards.map((card) => card.scrollWidth - card.clientWidth),
      };
    });
    expect(overflow.page).toBeLessThanOrEqual(1);
    for (const card of overflow.cards) expect(card).toBeLessThanOrEqual(1);
  });
});
