import { test, expect } from "@playwright/test";
import { query } from "../helpers/db.mjs";
import { loginAs } from "../helpers/auth.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { extraVisit, newTag, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);

const tag = newTag();
let ids;
let held;
let free;

async function atRxDesk(label) {
  const made = await extraVisit(ids, label, { healthray: false });
  await query(`UPDATE giniflow_visits SET current_status = 'rx_pending' WHERE id = $1`, [
    made.visit,
  ]);
  await query(
    `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, occurred_at)
     VALUES ($1, 'rx_pending', 'system', NOW() - interval '8 minutes')`,
    [made.visit],
  );
  return made;
}

test.describe.serial("G113 the Flow Manager tracks patients with the Care Coordinator", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    held = await atRxDesk("Held");
    free = await atRxDesk("Free");
    await query(
      `INSERT INTO giniflow_coordinator_holds (visit_id, patient_id, visit_date, sources, opened_at)
       VALUES ($1, $2, $3::date, ARRAY['gf_referral'], NOW() - interval '7 minutes')`,
      [held.visit, held.patient, ids.day],
    );
  });

  test.afterAll(async () => {
    await query(`DELETE FROM giniflow_coordinator_holds WHERE visit_id = ANY($1)`, [
      [held.visit, free.visit],
    ]);
    await tearDown(ids);
  });

  test("1. the tile counts who is waiting, shows the longest wait, and filters the board to them", async ({
    page,
  }) => {
    await loginAs(page, "admin");
    await gotoReady(page, "/giniflow/manager", () =>
      page.locator(`[data-card-id="${held.visit}"]`),
    );
    const tile = page
      .locator('[aria-label="Day totals — select one to filter the board"]')
      .getByRole("button", { name: /With Care Coordinator/ });
    await expect(tile).toContainText(/longest \d+m/);
    await expect(page.locator(`[data-card-id="${held.visit}"]`)).toContainText(
      /With Care Coordinator · 7m/,
    );

    await tile.click();
    await expect(tile).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(`[data-card-id="${held.visit}"]`)).toBeVisible();
    await expect(page.locator(`[data-card-id="${free.visit}"]`)).toHaveCount(0);

    await tile.click();
    await expect(page.locator(`[data-card-id="${free.visit}"]`)).toBeVisible();
  });

  test("2. referred patients sit in their own With Care Coordinator column, before Prescription Explain", async ({
    page,
  }) => {
    await loginAs(page, "admin");
    await gotoReady(page, "/giniflow/manager", () =>
      page.locator(`[data-card-id="${held.visit}"]`),
    );
    const names = await page.locator(".col .col-name").allTextContents();
    expect(names.indexOf("With Care Coordinator")).toBe(names.indexOf("Prescription Explain") - 1);
    const coordinator = page.locator(".col").filter({
      has: page.locator(".col-name", { hasText: "With Care Coordinator" }),
    });
    const rx = page.locator(".col").filter({
      has: page.locator(".col-name", { hasText: "Prescription Explain" }),
    });
    await expect(coordinator.locator(`[data-card-id="${held.visit}"]`)).toBeVisible();
    await expect(rx.locator(`[data-card-id="${held.visit}"]`)).toHaveCount(0);
    await expect(rx.locator(`[data-card-id="${free.visit}"]`)).toBeVisible();
  });

  test("3. with nobody waiting for the coordinator, the column is not shown", async () => {
    await query(`DELETE FROM giniflow_coordinator_holds WHERE visit_id = $1`, [held.visit]);
    const { getDayBoard, getSlaConfig } = await import("../../server/services/giniflow/board.js");
    const { db } = await import("../billing/phase4b/p4b-refunds.mjs");
    const board = await getDayBoard(ids.day, await getSlaConfig(db), new Date(), db);
    const waiting = board.cards.filter((c) => c.coordinator?.waiting).length;
    const shown = board.columns.some((col) => col.key === "coordinator");
    expect(shown).toBe(waiting > 0);
    if (!waiting) expect(shown).toBe(false);
  });
});
