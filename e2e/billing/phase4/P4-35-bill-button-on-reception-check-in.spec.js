import crypto from "node:crypto";
import { test, expect } from "@playwright/test";
import { loginAs } from "../../helpers/auth.mjs";
import { gotoReady } from "../../helpers/browser.mjs";

const tag = crypto.randomBytes(3).toString("hex");
const EXPECTED = { visitId: 930001, name: `P435 Expected ${tag}` };
const ON_FLOOR = { visitId: 930002, name: `P435 OnFloor ${tag}` };
const NOT_COMING = { visitId: 930003, name: `P435 NotComing ${tag}` };
const BILL_URL = (visitId) => `/giniflow/station/billing?visit=${visitId}`;

const arrival = (seed, extra) => ({
  visitId: seed.visitId,
  patientId: seed.visitId,
  name: seed.name,
  fileNo: `P435${seed.visitId}`,
  age: 52,
  sex: "Male",
  phone: "9876500000",
  priority: "normal",
  slot: "10:30",
  minutesLate: null,
  checkedInAt: null,
  statusSince: null,
  sinceMinutes: 0,
  schemeCode: null,
  bookingType: "New",
  walkIn: false,
  schemeOpdFee: null,
  paused: false,
  pausedAt: null,
  pausedReason: null,
  blockedReason: null,
  suggestedVisitTypeId: null,
  assignedSdId: null,
  assignedSdName: null,
  assignedDoctorId: null,
  assignedDoctorName: null,
  journey: null,
  alreadyOnFloorAs: null,
  ...extra,
});

const day = {
  expected: [arrival(EXPECTED, { status: "booked", statusLabel: "Booked" })],
  onFloor: [
    arrival(ON_FLOOR, {
      status: "checked_in",
      statusLabel: "Checked in",
      checkedInAt: new Date().toISOString(),
    }),
  ],
  notComing: [arrival(NOT_COMING, { status: "no_show", statusLabel: "No-show" })],
  counts: {
    expected: 1,
    onFloor: 1,
    notComing: 1,
    onFloorHere: 1,
    onFloorAway: 0,
    onFloorLeft: 0,
  },
  query: "",
};

async function openArrivals(page, role) {
  await page.route("**/api/giniflow/stations/reception/arrivals**", (route) =>
    route.fulfill({
      json: {
        date: new Date().toISOString().slice(0, 10),
        ...day,
        serverTime: new Date().toISOString(),
      },
    }),
  );
  await loginAs(page, role);
  await gotoReady(page, "/giniflow/station/reception", () =>
    page.getByRole("tab", { name: /Arrivals/ }),
  );
  await expect(row(page, ON_FLOOR)).toBeVisible();
}

const row = (page, seed) => page.locator(".ar-row").filter({ hasText: seed.name });
const bill = (page, seed) => row(page, seed).getByRole("link", { name: "Bill", exact: true });

test.describe.serial("P4-35 Bill button on reception check-in", () => {
  test("1. reception sees a Bill button on every live row, carrying that row's visit id", async ({
    page,
  }) => {
    await openArrivals(page, "reception");
    await expect(bill(page, ON_FLOOR)).toBeVisible();
    await expect(bill(page, ON_FLOOR)).toHaveAttribute("href", BILL_URL(ON_FLOOR.visitId));
    await expect(bill(page, EXPECTED)).toBeVisible();
    await expect(bill(page, EXPECTED)).toHaveAttribute("href", BILL_URL(EXPECTED.visitId));
    expect(BILL_URL(ON_FLOOR.visitId)).not.toBe(BILL_URL(EXPECTED.visitId));
  });

  test("2. reception_admin and admin see it too", async ({ page }) => {
    for (const role of ["reception_admin", "admin"]) {
      await openArrivals(page, role);
      await expect(bill(page, ON_FLOOR)).toHaveAttribute("href", BILL_URL(ON_FLOOR.visitId));
      await page.unrouteAll();
    }
  });

  test("3. a coordinator, who holds neither billing capability, sees no Bill button", async ({
    page,
  }) => {
    await openArrivals(page, "coordinator");
    await expect(row(page, ON_FLOOR)).toContainText(ON_FLOOR.name);
    await expect(row(page, EXPECTED)).toContainText(EXPECTED.name);
    await expect(page.getByRole("link", { name: "Bill", exact: true })).toHaveCount(0);
  });

  test("4. a cancelled or no-show row is not billed from here", async ({ page }) => {
    await openArrivals(page, "reception");
    await expect(row(page, NOT_COMING)).toContainText("No-show");
    await expect(bill(page, NOT_COMING)).toHaveCount(0);
  });

  test("5. a row with no visit id shows no Bill button rather than a dead one", async ({
    page,
  }) => {
    await page.route("**/api/giniflow/stations/reception/arrivals**", (route) =>
      route.fulfill({
        json: {
          date: new Date().toISOString().slice(0, 10),
          ...day,
          onFloor: [
            arrival(
              { ...ON_FLOOR, visitId: null },
              { status: "checked_in", statusLabel: "Checked in" },
            ),
          ],
          serverTime: new Date().toISOString(),
        },
      }),
    );
    await loginAs(page, "reception");
    await gotoReady(page, "/giniflow/station/reception", () =>
      page.getByRole("tab", { name: /Arrivals/ }),
    );
    await expect(row(page, ON_FLOOR)).toBeVisible();
    await expect(bill(page, ON_FLOOR)).toHaveCount(0);
    await expect(bill(page, EXPECTED)).toHaveAttribute("href", BILL_URL(EXPECTED.visitId));
  });

  test("6. pressing Bill opens the billing counter for that patient, in a second tab", async ({
    page,
  }) => {
    await openArrivals(page, "reception");
    const navigations = [];
    page.context().on("request", (request) => {
      if (request.isNavigationRequest()) navigations.push(request.url());
    });
    const [popup] = await Promise.all([page.waitForEvent("popup"), bill(page, ON_FLOOR).click()]);
    expect(navigations.some((url) => url.endsWith(BILL_URL(ON_FLOOR.visitId)))).toBe(true);
    expect(navigations.some((url) => url.endsWith(BILL_URL(EXPECTED.visitId)))).toBe(false);
    await popup.close();
    await expect(page).toHaveURL(/\/giniflow\/station\/reception/);
    await expect(row(page, ON_FLOOR)).toBeVisible();
  });
});
