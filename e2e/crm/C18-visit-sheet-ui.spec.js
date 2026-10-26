import { test, expect } from "@playwright/test";
import {
  seedCrmStaff,
  seedDoctors,
  crmApi,
  loginCrm,
  resetCrm,
  xlsxBuffer,
} from "../helpers/crm.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { one, query } from "../helpers/db.mjs";
import { addDays, ddmmyyyy, istDate } from "../../server/crm/istPeriods.js";

const today = ddmmyyyy(istDate());

test.describe("CRM visit sheet: the upload page", () => {
  let users;
  let hospitalId;
  let mine;

  test.beforeEach(async () => {
    test.setTimeout(120_000);
    const seeded = await seedCrmStaff();
    users = seeded.users;
    hospitalId = seeded.hospitalId;
    mine = await seedDoctors(hospitalId, [
      {
        full_name: "Dr Asha Kapoor",
        mobile: "9811100001",
        area: "Phase 7",
        owner: users.rajesh.crmId,
      },
      {
        full_name: "Dr Balraj Singh",
        mobile: "9811100002",
        area: "Kharar",
        owner: users.rajesh.crmId,
      },
      { full_name: "Dr Same Name", area: "Phase 3", owner: users.rajesh.crmId },
      { full_name: "Dr Same Name", area: "Phase 5", owner: users.rajesh.crmId },
    ]);
  });

  test.afterAll(resetCrm);

  test("1. A rep sees the sheet buttons on CRM home but not Import list", async ({ page }) => {
    await loginCrm(page, await crmApi(users.rajesh));
    await gotoReady(page, "/crm/home", () =>
      page.getByRole("button", { name: "Download my sheet" }),
    );
    await expect(page.getByRole("link", { name: "Upload visits" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Import list" })).toHaveCount(0);
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download my sheet" }).click();
    expect((await download).suggestedFilename()).toBe("my-visits.xlsx");
    await page.getByRole("link", { name: "Upload visits" }).click();
    await expect(page.getByRole("heading", { name: "Upload visits" })).toBeVisible();
  });

  test("2. Upload, preview, confirm, fix a failed row, then undo", async ({ page }) => {
    await loginCrm(page, await crmApi(users.rajesh));
    await gotoReady(page, "/crm/visits/import", () =>
      page.getByRole("heading", { name: "Upload visits" }),
    );
    const file = await xlsxBuffer([
      {
        "Doctor ID": mine[0].id,
        Doctor: "Dr Asha Kapoor",
        "Visit date": today,
        Status: "Completed",
      },
      {
        "Doctor ID": mine[1].id,
        Doctor: "Dr Balraj Singh",
        "Visit date": today,
        Status: "Not visited",
      },
      { Doctor: "Dr Same Name", "Visit date": today, Status: "Completed" },
    ]);
    await page.locator('input[type="file"]').setInputFiles({
      name: "rajesh-visits.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: file,
    });
    await expect(page.locator(".dimp__count").filter({ hasText: "Ready to import" })).toContainText(
      "1",
    );
    await expect(page.locator(".dimp__count").filter({ hasText: "Failed" })).toContainText("1");
    await expect(
      page.getByText("More than one of your doctors is called Dr Same Name"),
    ).toBeVisible();

    await page.getByRole("button", { name: "Import 1 visit" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("Import 1 visit for Rajesh Sharma?");
    await expect(dialog).toContainText("1 row failed");
    await dialog.getByRole("button", { name: "Import 1 visit" }).click();
    await expect(page.locator(".dimp__count").filter({ hasText: "Visits imported" })).toContainText(
      "1",
    );

    const fix = page.locator(".vsh__fix").first();
    await fix.getByLabel("Doctor for row 4").selectOption({ label: "Dr Same Name · Phase 5" });
    await fix.getByRole("button", { name: "Retry" }).click();
    await expect(page.locator(".dimp__count").filter({ hasText: "Visits imported" })).toContainText(
      "2",
    );
    await expect(page.locator(".vsh__fix")).toHaveCount(0);
    expect(
      (
        await one(
          `SELECT count(*)::int AS n FROM crm.visits WHERE deleted_at IS NULL AND source = 'sheet'`,
        )
      ).n,
    ).toBe(2);

    await page.getByRole("button", { name: "Undo this upload" }).click();
    await expect(page.getByRole("dialog")).toContainText("remove 2 visits");
    await page.getByRole("dialog").getByRole("button", { name: "Undo upload" }).click();
    await expect(page.getByText("Upload undone — 2 visits removed.")).toBeVisible();
    expect(
      (await one(`SELECT count(*)::int AS n FROM crm.visits WHERE deleted_at IS NULL`)).n,
    ).toBe(0);
  });

  test("3. A bad file shows a clear error and stays on Upload", async ({ page }) => {
    await loginCrm(page, await crmApi(users.rajesh));
    await gotoReady(page, "/crm/visits/import", () =>
      page.getByRole("heading", { name: "Upload visits" }),
    );
    await page.locator('input[type="file"]').setInputFiles({
      name: "wrong.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: await xlsxBuffer([{ Doctor: "Dr Asha Kapoor" }]),
    });
    await expect(page.getByRole("alert")).toContainText(
      "needs a “Visit date” and a “Status” column",
    );
    await expect(page.getByRole("button", { name: "Download my sheet" })).toBeVisible();
  });

  test("4. The visit form warns when this doctor is already logged today", async ({ page }) => {
    await query(
      `INSERT INTO crm.visits (hospital_id, doctor_id, executive_id, occurred_at, source)
       VALUES ($1, $2, $3, now(), 'sheet')`,
      [hospitalId, mine[0].id, users.rajesh.crmId],
    );
    await loginCrm(page, await crmApi(users.rajesh));
    await gotoReady(page, `/crm/visit/${mine[0].id}`, () =>
      page.getByText(/Already logged today for Dr Asha Kapoor/),
    );
    await expect(page.getByRole("button", { name: "Save visit" })).toBeDisabled();
    await expect(page.getByRole("link", { name: "Open today’s visit" })).toBeVisible();
  });

  test("5. Phone width: no sideways scroll on the upload page or CRM home", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginCrm(page, await crmApi(users.rajesh));
    for (const [url, ready] of [
      ["/crm/home", () => page.getByRole("button", { name: "Download my sheet" })],
      ["/crm/visits/import", () => page.getByRole("heading", { name: "Upload visits" })],
    ]) {
      await gotoReady(page, url, ready);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, url).toBeLessThanOrEqual(1);
    }
  });

  test("6. Phone width: the preview rows become cards without sideways scroll", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginCrm(page, await crmApi(users.rajesh));
    await gotoReady(page, "/crm/visits/import", () =>
      page.getByRole("heading", { name: "Upload visits" }),
    );
    await page.locator('input[type="file"]').setInputFiles({
      name: "a-very-long-file-name-from-whatsapp-forwarded-rajesh-october-visits-final-v2.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: await xlsxBuffer([
        {
          "Doctor ID": mine[0].id,
          "Visit date": today,
          Status: "Completed",
          Notes: "x".repeat(300),
        },
        { Doctor: "Dr Same Name", "Visit date": today, Status: "Completed" },
        {
          Doctor: "Dr Someone With An Extremely Long Name Nobody Has",
          "Visit date": "soon",
          Status: "Completed",
        },
      ]),
    });
    await expect(page.getByRole("button", { name: "Import 1 visit" })).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
    await page.screenshot({
      path: process.env.SHOT_DIR ? `${process.env.SHOT_DIR}/phone-preview.png` : undefined,
      fullPage: true,
    });
  });

  test("7. A typed name that matches nobody still offers the rep's doctors to pick", async ({
    page,
  }) => {
    await loginCrm(page, await crmApi(users.rajesh));
    await gotoReady(page, "/crm/visits/import", () =>
      page.getByRole("heading", { name: "Upload visits" }),
    );
    await page.locator('input[type="file"]').setInputFiles({
      name: "visits.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: await xlsxBuffer([
        { "Doctor ID": mine[0].id, "Visit date": today, Status: "Completed" },
        { Doctor: "Dr Nobody", "Visit date": "soon", Status: "Completed" },
      ]),
    });
    await page.getByRole("button", { name: "Import 1 visit" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Import 1 visit" }).click();
    const fix = page.locator(".vsh__fix");
    await expect(fix).toContainText(
      "No doctor of yours is called Dr Nobody. Pick the doctor. Visit date must be a date",
    );
    await expect(fix.getByText(/No doctor of yours matches “Dr Nobody”/)).toBeVisible();
    await fix
      .getByLabel("Doctor for row 3")
      .selectOption({ label: "Dr Balraj Singh · Kharar · 9811100002" });
    await fix.getByLabel("Visit date").fill(istDate());
    await fix.getByRole("button", { name: "Retry" }).click();
    await expect(page.locator(".dimp__count").filter({ hasText: "Visits imported" })).toContainText(
      "2",
    );
    await expect(page.locator("a.dimp__btn", { hasText: "Back to CRM home" })).toHaveCSS(
      "text-decoration-line",
      "none",
    );
  });

  test("8. Follow-up shows in the preview and a bad next visit date can be fixed", async ({
    page,
  }) => {
    await loginCrm(page, await crmApi(users.rajesh));
    await gotoReady(page, "/crm/visits/import", () =>
      page.getByRole("heading", { name: "Upload visits" }),
    );
    await page.locator('input[type="file"]').setInputFiles({
      name: "visits.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: await xlsxBuffer([
        {
          "Doctor ID": mine[0].id,
          "Visit date": today,
          Status: "Completed",
          "Next visit date": ddmmyyyy(addDays(istDate(), 7)),
        },
        {
          "Doctor ID": mine[1].id,
          "Visit date": today,
          Status: "Completed",
          "Next visit date": today,
        },
      ]),
    });
    await expect(page.getByText(`Follow-up by ${ddmmyyyy(addDays(istDate(), 7))}`)).toBeVisible();
    await page.getByRole("button", { name: "Import 1 visit" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Import 1 visit" }).click();
    const fix = page.locator(".vsh__fix");
    await expect(fix).toContainText("Next visit date must be after the visit date.");
    const next = new Date(Date.now() + 10 * 86400000 + 330 * 60000).toISOString().slice(0, 10);
    await fix.getByLabel("Next visit date").fill(next);
    await fix.getByRole("button", { name: "Retry" }).click();
    await expect(page.locator(".dimp__count").filter({ hasText: "Visits imported" })).toContainText(
      "2",
    );
    const stored = await one(
      `SELECT follow_up_required, next_visit_date::text AS n FROM crm.visits WHERE doctor_id = $1`,
      [mine[1].id],
    );
    expect(stored).toEqual({ follow_up_required: true, n: next });
  });
});
