import { test, expect } from "@playwright/test";
import { seedCrmStaff, seedDoctors, crmApi, loginCrm, resetCrm } from "../helpers/crm.mjs";
import { loginAs } from "../helpers/auth.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { query } from "../helpers/db.mjs";
import { addDays, istDate } from "../../server/crm/istPeriods.js";

const SHOTS = process.env.SHOT_DIR;
const field = (page, label) => page.getByRole("button", { name: label, exact: true });
const pick = async (page, label, option) => {
  await field(page, label).click();
  await page.getByRole("option", { name: option, exact: true }).click();
};

test.describe("CRM progress page", () => {
  let users;
  let mine;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    const seeded = await seedCrmStaff();
    users = seeded.users;
    const hospitalId = seeded.hospitalId;
    mine = await seedDoctors(hospitalId, [
      {
        full_name: "Dr Kiran Bedi Long Name Clinic Phase Seven",
        territory: "Mohali",
        owner: users.rajesh.crmId,
      },
      { full_name: "Dr Two", territory: "Mohali", owner: users.rajesh.crmId },
      { full_name: "Dr Three", territory: "Kharar", owner: users.rajesh.crmId },
    ]);
    const theirs = await seedDoctors(hospitalId, [
      { full_name: "Dr Sandeep's Doctor", territory: "Kharar", owner: users.sandeep.crmId },
    ]);
    const today = istDate();
    const visit = (doctor, rep, day, outcome = null) =>
      query(
        `INSERT INTO crm.visits (hospital_id, doctor_id, executive_id, occurred_at, outcome)
         VALUES ($1, $2, $3, LEAST(($4::date + time '10:00') AT TIME ZONE 'Asia/Kolkata', now()), $5)`,
        [hospitalId, doctor.id, rep, day, outcome],
      );
    await visit(mine[0], users.rajesh.crmId, today, "positive");
    await visit(mine[1], users.rajesh.crmId, today, "doctor_unavailable");
    await visit(mine[0], users.rajesh.crmId, addDays(today, -40));
    await visit(theirs[0], users.sandeep.crmId, today);
  });

  test.afterAll(resetCrm);

  test("1. A rep gets the Progress tab and only their own report", async ({ page }) => {
    await loginCrm(page, await crmApi(users.rajesh));
    await gotoReady(page, "/crm/home", () => page.locator(".tabs"));
    await page.locator(".tabs").getByRole("link", { name: "📈 Progress" }).click();
    await expect(page.getByRole("heading", { name: "Progress" })).toBeVisible();
    await expect(page.getByText(/^Rajesh Sharma · /)).toBeVisible();
    await expect(field(page, "Period")).toHaveText("This month");
    await expect(field(page, "Staff")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Staff comparison" })).toHaveCount(0);
    await expect(page.locator(".prg__card").filter({ hasText: /^2\s*Visits/ })).toBeVisible();
    await expect(page.getByText("Sandeep")).toHaveCount(0);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/progress-rep.png`, fullPage: true });
  });

  test("2. Head of growth: all staff, pick a rep from the table, filters live in the URL", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginCrm(page, await crmApi(users.virender));
    await gotoReady(page, "/crm/progress", () =>
      page.getByRole("heading", { name: "Staff comparison" }),
    );
    await expect(page.getByText(/^All staff · /)).toBeVisible();
    await expect(page.locator(".prg__table--staff tfoot")).toContainText("Team total");
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/progress-head.png`, fullPage: true });
    await page
      .locator(".prg__table--staff")
      .getByRole("button", { name: "Sandeep Sangroy" })
      .click();
    await expect(page).toHaveURL(new RegExp(`rep=${users.sandeep.crmId}`));
    await expect(page.getByText(/^Sandeep Sangroy · /)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Staff comparison" })).toHaveCount(0);
    await pick(page, "Period", "Last month");
    await pick(page, "Period", "This month");
    await expect(page).toHaveURL(/period=this_month/);
    await page.reload();
    await expect(field(page, "Period")).toHaveText("This month");
    await expect(field(page, "Staff")).toHaveText("Sandeep Sangroy");
    await page.getByRole("button", { name: "Reset filters" }).click();
    await expect(field(page, "Staff")).toHaveText("All staff");
  });

  test("3. Custom range, a bad range shows the reason, and an empty period says so", async ({
    page,
  }) => {
    await loginCrm(page, await crmApi(users.virender));
    await gotoReady(page, "/crm/progress?period=custom&from=2026-01-01&to=2026-01-31", () =>
      page.getByText("No visits logged in this period."),
    );
    await gotoReady(page, "/crm/progress?period=custom&from=2026-02-10&to=2026-02-01", () =>
      page.getByRole("alert"),
    );
    await expect(page.getByRole("alert")).toContainText(
      "The From date must be on or before the To date.",
    );
  });

  test("4. Not-visited list and the export download", async ({ page }) => {
    await loginCrm(page, await crmApi(users.rajesh));
    await gotoReady(page, "/crm/progress?period=today", () =>
      page.getByRole("heading", { name: "Doctors" }),
    );
    await expect(page.locator(".prg__doctor")).toHaveCount(1);
    await expect(page.locator(".prg__doctor")).toContainText("Dr Three");
    await page.getByRole("button", { name: "Visited in this period", exact: true }).click();
    await expect(page.locator(".prg__doctor")).toHaveCount(2);
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download report" }).click();
    expect((await download).suggestedFilename()).toMatch(/^crm-progress-\d{4}-\d{2}-\d{2}-to-/);
  });

  test("5. Roles without CRM access get no tab and are sent away", async ({ page }) => {
    await loginAs(page, "reception");
    await gotoReady(page, "/", () => page.locator(".tabs"));
    await expect(page.locator(".tabs").getByRole("link", { name: "📈 Progress" })).toHaveCount(0);
    await page.goto("/crm/progress");
    await expect(page.getByRole("heading", { name: "Progress" })).toHaveCount(0);
  });

  test("6. Phone width: no sideways scroll", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginCrm(page, await crmApi(users.virender));
    await gotoReady(page, "/crm/progress", () =>
      page.getByRole("heading", { name: "Staff comparison" }),
    );
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/progress-phone.png`, fullPage: true });
    await page.setViewportSize({ width: 820, height: 1100 });
    const tabletOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(tabletOverflow).toBeLessThanOrEqual(1);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/progress-tablet.png`, fullPage: true });
  });

  test("7. Custom range, split by staff, table view, territory, and recovering from an error", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await loginCrm(page, await crmApi(users.virender));
    await gotoReady(page, "/crm/progress", () =>
      page.getByRole("heading", { name: "Staff comparison" }),
    );
    const today = istDate();

    await page.getByLabel("Split by staff").check();
    await expect(page.locator(".recharts-legend-wrapper")).toContainText("Rajesh Sharma");
    await expect(page.locator(".recharts-legend-wrapper")).not.toContainText("Unique doctors");
    await page.getByText("Show as table").click();
    const table = page.locator(".prg__table-toggle table");
    await expect(table.locator("thead")).toContainText("Sandeep Sangroy");
    await expect(table.locator("tbody tr").last()).toContainText("3");

    await pick(page, "Territory", "Kharar");
    await expect(page).toHaveURL(/territory=/);
    await expect(page.locator(".prg__card").filter({ hasText: /^1\s*Visits/ })).toBeVisible();

    await pick(page, "Period", "Custom range");
    await page.getByLabel("From", { exact: true }).fill(addDays(today, -10));
    await page.getByLabel("To", { exact: true }).fill(today);
    await page.getByRole("button", { name: "Apply" }).click();
    await expect(page).toHaveURL(new RegExp(`from=${addDays(today, -10)}&to=${today}`));
    await expect(page.getByRole("heading", { name: "Visits by day" })).toBeVisible();

    await page.goto(`/crm/progress?period=custom&from=${today}&to=${addDays(today, -3)}`);
    await expect(page.getByRole("alert")).toContainText(
      "The From date must be on or before the To date.",
    );
    await expect(page.locator(".prg__card")).toHaveCount(0);
    await page.getByRole("button", { name: "Reset filters" }).click();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Staff comparison" })).toBeVisible();
  });

  test("8. Priority filter narrows the report, the doctor list and the download", async ({
    page,
  }) => {
    await query(`UPDATE crm.doctors SET priority = 'A' WHERE id = $1`, [mine[0].id]);
    const head = await crmApi(users.virender);
    const report = async (params) =>
      (await head.get(`/api/crm/progress?${new URLSearchParams(params)}`)).json();
    const all = await report({ period: "today" });
    const onlyA = await report({ period: "today", priority: "A" });
    expect(all.cards.visits.visits).toBe(3);
    expect(onlyA.cards.visits.visits).toBe(1);
    expect(onlyA.filters.priority).toBe("A");
    expect((await report({ period: "today", priority: "B" })).cards.visits.visits).toBe(0);
    const bad = await head.get("/api/crm/progress?priority=Z");
    expect(bad.status()).toBe(400);
    expect((await bad.json()).error).toBe("Choose a priority from the list.");
    const doctors = await (
      await head.get("/api/crm/progress/doctors?period=today&priority=A")
    ).json();
    expect(doctors.rows.map((d) => d.full_name)).toEqual([mine[0].full_name]);
    const xlsx = await head.get("/api/crm/progress/export.xlsx?period=today&priority=A");
    expect(xlsx.status()).toBe(200);

    await page.setViewportSize({ width: 1280, height: 900 });
    await loginCrm(page, head);
    await gotoReady(page, "/crm/progress?period=today", () =>
      page.getByRole("heading", { name: "Staff comparison" }),
    );
    await field(page, "Priority").click();
    await expect(page.getByRole("option", { name: /^C —/ })).toHaveCount(0);
    await page.getByRole("option", { name: "A — High value" }).click();
    await expect(page).toHaveURL(/priority=A/);
    await expect(page.locator(".prg__card").filter({ hasText: /^1\s*Visits/ })).toBeVisible();
    await page.getByRole("button", { name: "Reset filters" }).click();
    await expect(page).not.toHaveURL(/priority=/);
    await expect(field(page, "Priority")).toHaveText("All priorities");
  });
});
