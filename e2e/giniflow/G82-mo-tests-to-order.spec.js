import { test, expect } from "@playwright/test";
import { query } from "../helpers/db.mjs";
import { loginAs } from "../helpers/auth.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { extraVisit, newTag, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);

const tag = newTag();
let ids;

test.describe.serial("G82 the MO orders tests the way the consultant does", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
  });

  test.afterAll(async () => {
    await tearDown(ids);
  });

  test("1. when, panels with their tests, most used or all, and a search box", async ({ page }) => {
    const made = await extraVisit(ids, "MoTests", { healthray: false });
    await query(`UPDATE giniflow_visits SET current_status = 'vitals_done' WHERE id = $1`, [
      made.visit,
    ]);
    await query(
      `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, occurred_at)
       VALUES ($1, 'checked_in', 'reception', NOW() - interval '20 minutes'),
              ($1, 'vitals_done', 'vitals', NOW() - interval '5 minutes')`,
      [made.visit],
    );

    await loginAs(page, "admin");
    await gotoReady(page, "/giniflow/station/mo", () =>
      page.getByText(`P4 MoTests ${tag}`).first(),
    );
    await page.getByText(`P4 MoTests ${tag}`).first().click();

    const section = page.locator(".dp-sec").filter({ hasText: "🔬 Tests to order" });
    await expect(section.getByText("When are these needed?")).toBeVisible();
    await expect(section.getByRole("button", { name: /^Today/ })).toContainText("lab now");
    await expect(section.getByText("Quick panels")).toBeVisible();
    const heading = section.locator(".tst-head");
    await expect(heading).toContainText("Most used tests");

    const showAll = section.getByRole("button", { name: /^Show all \d+/ });
    await showAll.click();
    await expect(heading).toContainText("All tests");
    await section.getByRole("button", { name: "Show most used only" }).click();

    await section.getByRole("searchbox", { name: "Search tests" }).fill(ids.hba1cName);
    await expect(heading).toContainText("Matching tests");
    await expect(section.locator(".tst-chip").first()).toContainText(ids.hba1cName);

    await section.getByRole("searchbox", { name: "Search tests" }).fill(`Zz Unlisted ${tag}`);
    await expect(section.getByText("is not in the list")).toBeVisible();
    await section.getByRole("textbox", { name: `Price for Zz Unlisted ${tag}` }).fill("250");
    await section.getByRole("button", { name: "+ Add for this patient" }).click();
    await expect(section.locator(".tst-bar")).toContainText("1 tests");
    await expect(section.locator(".tst-bar")).toContainText("₹250");
  });
});
