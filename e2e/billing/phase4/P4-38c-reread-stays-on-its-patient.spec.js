import { test, expect } from "@playwright/test";
import { getPool } from "../../helpers/db.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { loginAs } from "../../helpers/auth.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { newDayTag, seedDay, tearDownDay } from "./p438-floor-day.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");
const visitLines = await import("../../../server/services/billing/visitLines.js");
const db = getPool();
const tag = newDayTag();
const desk = { actorId: USERS.reception.id, ip: "10.9.38.3", role: "reception" };
let day;

test.describe("P4-38c the counter's re-read stays on its own patient", () => {
  test.beforeAll(async () => {
    day = await seedDay(tag);
  });
  test.afterAll(async () => {
    await tearDownDay(day);
  });

  test("a slow re-read of one patient's bill never lands on the next patient", async ({ page }) => {
    test.setTimeout(90000);
    const first = day.patients.gen;
    const second = day.patients.later;
    await visitLines.consultationForDesk(first.visit, desk, db);
    const draft = await bills.openDraft(first.visit, desk, db);
    await loginAs(page, "reception");
    await page.goto(`/giniflow/station/billing?visit=${first.visit}`);
    await expect(page.getByText(`Consultation Dr Rahul New ${tag}`).first()).toBeVisible({
      timeout: 20000,
    });
    let held = null;
    await page.route(`**/api/billing/bills/${draft.id}`, async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      held = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 5000));
      await route.continue();
    });
    await bills.addLine(draft.id, { item_id: day.items.dressing }, desk, db);
    await expect.poll(() => held, { timeout: 25000 }).not.toBeNull();
    await page
      .getByRole("button", { name: new RegExp(second.name) })
      .first()
      .click();
    await expect(page.getByText(`Consultation Dr Rahul Follow Up ${tag}`).first()).toBeVisible({
      timeout: 20000,
    });
    await page.waitForTimeout(6000);
    const lines = page.getByRole("table", { name: "Bill lines" });
    await expect(lines.getByText(`Consultation Dr Rahul Follow Up ${tag}`)).toBeVisible();
    await expect(lines.getByText(`Consultation Dr Rahul New ${tag}`)).toHaveCount(0);
  });
});
