import { test, expect } from "@playwright/test";
import { loginAs } from "../helpers/auth.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { clearClinical, newTag, seedClinical } from "./clinical-fixture.mjs";

const tag = newTag();
let seeded;

const heading = (page) => page.getByText("📊 Clinical Reports");
const scorecard = (page) => page.getByRole("region", { name: "Patient target scorecard" });

async function open(page) {
  await loginAs(page, "admin");
  await gotoReady(page, "/reports", () => heading(page));
}

test.describe.serial("R04 Clinical Reports page loads fast and pages its lists", () => {
  test.beforeAll(async () => {
    seeded = await seedClinical(tag);
  });

  test.afterAll(async () => {
    await clearClinical(tag);
  });

  test("1. the dashboard shows without waiting for the other tabs", async ({ page }) => {
    let diagnosesAsked = 0;
    await page.route("**/api/reports/diagnoses**", async (route) => {
      diagnosesAsked += 1;
      await new Promise((resolve) => setTimeout(resolve, 15_000));
      await route.continue().catch(() => {});
    });
    await open(page);
    await expect(page.getByText("Patients Seen")).toBeVisible();
    await expect(page.getByText("🎯 BIOMARKER CONTROL RATES")).toBeVisible();
    expect(diagnosesAsked).toBe(0);
    await page.getByRole("button", { name: "🏥 Diagnoses" }).click();
    await expect.poll(() => diagnosesAsked).toBe(1);
  });

  test("2. a biomarker opens a paged, filterable patient list", async ({ page }) => {
    await open(page);
    await page.getByText("HbA1c", { exact: true }).first().click();
    const search = page.getByLabel("Search HbA1c patients");
    await search.fill(tag);
    const rows = page.locator(".rep-row");
    await expect(rows).toHaveCount(3);
    await expect(rows.first()).toContainText(`R03 P3 ${tag}`);
    await page.getByRole("button", { name: /^❌ Out/ }).click();
    await expect(rows).toHaveCount(1);
    await expect(page.getByText(/patients with no HbA1c data/)).toBeVisible();
  });

  test("3. the scorecard pages, searches and expands a patient", async ({ page }) => {
    await open(page);
    const card = scorecard(page);
    await card.getByLabel("Search scorecard patients").fill(tag);
    const rows = card.locator(".rep-score");
    await expect(rows).toHaveCount(4);
    await expect(rows.first()).toContainText(`R03 P2 ${tag}`);
    await card.getByRole("button", { name: new RegExp(`R03 P1 ${tag}`) }).click();
    await expect(card.getByText("Type 2 Diabetes Mellitus")).toBeVisible();
    await expect(card.getByRole("button", { name: "Open Patient →" })).toBeVisible();
    await expect(card.getByText("Showing 1–4 of 4 patients")).toBeVisible();
  });

  test("4. Diagnoses and Doctors load when their tab opens", async ({ page }) => {
    await open(page);
    const asked = [];
    page.on("request", (r) => {
      if (/\/api\/reports\/(diagnoses|doctors)/.test(r.url())) asked.push(r.url());
    });
    await page.getByRole("button", { name: "👨‍⚕️ Doctors" }).click();
    await expect.poll(() => asked.filter((u) => u.includes("doctors")).length).toBe(1);
    await page.getByRole("button", { name: "🏥 Diagnoses" }).click();
    await expect.poll(() => asked.filter((u) => u.includes("diagnoses")).length).toBe(1);
  });

  test("5. a failed list says so and can be retried", async ({ page }) => {
    let fail = true;
    await page.route("**/api/reports/today/scorecard**", (route) =>
      fail
        ? route.fulfill({ status: 500, contentType: "application/json", body: "{}" })
        : route.continue(),
    );
    await open(page);
    const card = scorecard(page);
    await expect(card.getByText("Couldn't load the scorecard.")).toBeVisible({ timeout: 20_000 });
    fail = false;
    await card.getByRole("button", { name: "Try again" }).click();
    await expect(card.locator(".rep-score").first()).toBeVisible();
  });
});
