import { test, expect } from "@playwright/test";
import { one, query } from "../../helpers/db.mjs";
import { apiAs, loginAs } from "../../helpers/auth.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { extraVisit, newTag, setUp, tearDown } from "./p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);

const tag = newTag();
let ids;
let before;

const setBillAtCheckIn = (on) => query(`UPDATE billing_settings SET bill_at_check_in = $1`, [on]);

async function mockArrival(page, made, name) {
  await page.route("**/api/giniflow/stations/reception/arrivals**", (route) =>
    route.fulfill({
      json: {
        date: ids.day,
        expected: [
          {
            visitId: made.visit,
            patientId: made.patient,
            name,
            fileNo: `F4NoArrivalBill-${tag}`,
            age: 55,
            sex: "Male",
            phone: null,
            priority: "normal",
            slot: "10:30",
            minutesLate: null,
            bookingType: "New",
            walkIn: false,
            status: "booked",
            statusLabel: "Booked",
            assignedDoctorId: null,
            suggestedVisitTypeId: "991581",
          },
        ],
        onFloor: [],
        notComing: [],
        counts: { expected: 1, onFloor: 0, notComing: 0, onFloorHere: 0 },
        query: "",
        serverTime: new Date().toISOString(),
      },
    }),
  );
  await page.route("**/api/flow/visit-types**", (route) =>
    route.fulfill({ json: [{ id: "991581", name: `P4C58 Visit ${tag}`, for_online: false }] }),
  );
  await page.route("**/api/giniflow/journey/plan/991581", (route) =>
    route.fulfill({
      json: [
        {
          catalogId: "991582",
          name: "Vitals",
          role: "vitals",
          minutes: 5,
          included: true,
          source: "template",
        },
      ],
    }),
  );
}

test.describe.serial("P4C-58 bill at check-in can be switched off", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    before = (await one(`SELECT bill_at_check_in FROM billing_settings`)).bill_at_check_in;
  });

  test.afterAll(async () => {
    await setBillAtCheckIn(before);
    await tearDown(ids);
  });

  test("1. the admin switches it off on the billing settings page", async ({ page }) => {
    await setBillAtCheckIn(true);
    await loginAs(page, "admin");
    await gotoReady(page, "/settings/billing", () =>
      page.getByLabel('Show "Bill at arrival" when checking a patient in'),
    );
    const box = page.getByLabel('Show "Bill at arrival" when checking a patient in');
    await expect(box).toBeChecked();
    await box.uncheck();
    await page.getByRole("form", { name: "Bills" }).getByRole("button", { name: "Save" }).click();
    await expect
      .poll(
        async () => (await one(`SELECT bill_at_check_in FROM billing_settings`)).bill_at_check_in,
      )
      .toBe(false);
  });

  test("2. when off, the stations API refuses the arrival bill", async () => {
    await setBillAtCheckIn(false);
    const made = await extraVisit(ids, "NoArriveApi", { healthray: false });
    await query(`UPDATE giniflow_visits SET current_status = 'checked_in' WHERE id = $1`, [
      made.visit,
    ]);
    const url = `/api/giniflow/stations/reception/${made.visit}/arrival-bill`;
    const reception = await apiAs("reception");
    const preview = await reception.get(url);
    expect(preview.status()).toBe(409);
    const paid = await reception.post(url, { data: { expectedTotal: 0 } });
    expect(paid.status()).toBe(409);
    await reception.dispose();
    const billed = await one(`SELECT COUNT(*)::int AS n FROM bills WHERE visit_id = $1`, [
      made.visit,
    ]);
    expect(billed.n).toBe(0);
  });

  test("3. when off, check-in shows no bill and closes once the patient is in", async ({
    page,
  }) => {
    await setBillAtCheckIn(false);
    const made = await extraVisit(ids, "NoArriveScreen", { healthray: false });
    const name = `P4 NoArriveScreen ${tag}`;
    await mockArrival(page, made, name);
    let checkedIn = 0;
    await page.route(`**/api/giniflow/stations/reception/${made.visit}/checkin`, (route) => {
      checkedIn++;
      return route.fulfill({ json: { totalCount: 1, plannedTotalMin: 5, raised: null } });
    });
    let quoted = 0;
    await page.route("**/arrival-bill**", (route) => {
      quoted++;
      return route.continue();
    });

    await loginAs(page, "reception");
    await gotoReady(page, "/giniflow/station/reception", () =>
      page.getByRole("tab", { name: /^Arrivals/ }),
    );
    await page
      .locator(".ar-row")
      .filter({ hasText: name })
      .getByRole("button", { name: "✓ Arrived" })
      .click();
    const panel = page.getByRole("dialog", { name: "Check in" });
    await expect(panel.getByText("Vitals").first()).toBeVisible();
    await expect(panel.getByRole("region", { name: "Bill at arrival" })).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "Check in only — bill later" })).toHaveCount(0);
    const press = panel.getByRole("button", { name: "✓ Check in", exact: true });
    await expect(press).toBeEnabled();
    await press.click();
    await expect.poll(() => checkedIn).toBe(1);
    await expect(panel).toBeHidden();
    expect(quoted).toBe(0);
  });

  test("4. when on, the bill is back on the check-in panel", async ({ page }) => {
    await setBillAtCheckIn(true);
    const made = await extraVisit(ids, "ArriveAgain", { healthray: false });
    const name = `P4 ArriveAgain ${tag}`;
    await mockArrival(page, made, name);
    await loginAs(page, "reception");
    await gotoReady(page, "/giniflow/station/reception", () =>
      page.getByRole("tab", { name: /^Arrivals/ }),
    );
    await page
      .locator(".ar-row")
      .filter({ hasText: name })
      .getByRole("button", { name: "✓ Arrived" })
      .click();
    const panel = page.getByRole("dialog", { name: "Check in" });
    await expect(panel.getByRole("region", { name: "Bill at arrival" })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Check in only — bill later" })).toBeVisible();
  });
});
