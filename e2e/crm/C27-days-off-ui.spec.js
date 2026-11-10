import { test, expect } from "@playwright/test";
import { seedCrmStaff, seedDoctors, crmApi, loginCrm, resetCrm } from "../helpers/crm.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { one } from "../helpers/db.mjs";
import { addDays, istDate } from "../../server/crm/istPeriods.js";
import { isSunday } from "../../server/crm/daysOff.js";

const today = istDate();
const weekday = (n) => {
  const d = addDays(today, n);
  return isSunday(d) ? addDays(d, 1) : d;
};

test.describe("CRM Holidays & leave tab and working-day average", () => {
  let users;
  let rajesh;
  let virender;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    const seeded = await seedCrmStaff();
    users = seeded.users;
    await seedDoctors(seeded.hospitalId, [
      { full_name: "Dr Leave One", owner: users.rajesh.crmId },
    ]);
    rajesh = await crmApi(users.rajesh);
    virender = await crmApi(users.virender);
  });

  test.afterAll(resetCrm);

  const openTab = async (page, api) => {
    await loginCrm(page, api);
    await gotoReady(page, "/crm/home?tab=leave", () =>
      page.getByRole("heading", { name: /^(My leave|Leave)$/ }),
    );
  };

  test("1. A rep requests leave with field checks, and sees it waiting", async ({ page }) => {
    await openTab(page, rajesh);
    await page.getByRole("button", { name: "Request leave" }).click();
    await page.getByRole("button", { name: "Send request" }).click();
    await expect(page.getByText("Choose the first day.")).toBeVisible();

    const day = weekday(5);
    await page.getByLabel("First day").fill(day);
    await expect(page.getByLabel("Last day")).toHaveValue(day);
    await page.getByLabel("Half day").check();
    await expect(page.getByRole("status").filter({ hasText: "Half day" })).toBeVisible();
    await page.getByLabel("Reason (optional)").fill("Bank work");
    await page.getByRole("button", { name: "Send request" }).click();
    await expect(
      page.getByText("Leave requested. It counts once your admin approves it."),
    ).toBeVisible();
    await expect(page.getByText("Waiting for approval")).toBeVisible();
    await expect(page.getByText(/Half day · Bank work/)).toBeVisible();
  });

  test("2. The admin sees the count, approves, and adds a holiday", async ({ page }) => {
    await openTab(page, virender);
    await expect(page.getByRole("button", { name: /Holidays & leave\s*1/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    await page.getByRole("button", { name: "Approve leave" }).click();
    await expect(page.getByText("Rajesh Sharma's leave approved.")).toBeVisible();

    await page.getByRole("button", { name: "+ Holiday" }).click();
    await page.getByRole("button", { name: "Add holiday" }).click();
    await expect(page.getByText("Enter the holiday name, like Diwali.")).toBeVisible();
    await page.getByLabel("Holiday name").fill("Test Gurpurab");
    await page.getByLabel("First day").fill(weekday(12));
    await page.getByRole("button", { name: "Add holiday" }).click();
    await expect(page.getByText("Holiday added.")).toBeVisible();
    await expect(page.getByText("Test Gurpurab")).toBeVisible();
    const row = await one(
      `SELECT count(*)::int AS n FROM crm.days_off WHERE kind = 'holiday' AND title = 'Test Gurpurab'`,
    );
    expect(row.n).toBe(1);
  });

  test("3. Progress shows visits per working day, and home shows it too", async ({ page }) => {
    await loginCrm(page, rajesh);
    await gotoReady(page, "/crm/progress", () => page.getByText("Visits per working day"));
    await expect(
      page.getByText(/working days · .* off|No working days in this period/),
    ).toBeVisible();
    await gotoReady(page, "/crm/home", () => page.getByText("Per working day"));
  });

  test("4. The tab works at phone width", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await openTab(page, rajesh);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
    await page.getByRole("button", { name: "Request leave" }).click();
    await expect(page.getByLabel("First day")).toBeVisible();
  });
});
