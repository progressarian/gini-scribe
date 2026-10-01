import { test, expect } from "@playwright/test";
import { getPool, query } from "../../helpers/db.mjs";
import { loginAs } from "../../helpers/auth.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { desk, extraVisit, newTag, setUp, tearDown } from "./p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");

const db = getPool();
const tag = newTag();
const PATIENT = `P4 Patient ${tag}`;
const SENT = `P4C13 Sent ${tag}`;
const RESTORED = "Restored what you'd typed before the page reloaded.";
const RECEPTION = "/giniflow/station/reception";
const EVENTS = "/api/giniflow/events";
let ids;
let typed;
let payLaterBefore = false;

const setPayLater = (on) => query(`UPDATE billing_settings SET allow_pay_later = $1`, [on]);

const tab = (page, name) => page.getByRole("tab", { name, exact: true });
const arrivalsTab = (page) => page.getByRole("tab", { name: /^Arrivals/ });
const header = (page, name = PATIENT) => page.getByRole("heading", { name });
const pad = (page) => page.getByRole("region", { name: "Totals and payment" });
const searchbox = (page) => page.getByRole("searchbox", { name: "Search today's patients" });
const row = (page) => page.locator(".ar-row").filter({ hasText: PATIENT });
const settle = (page) => page.waitForTimeout(500);

const arrival = () => ({
  visitId: ids.visit,
  patientId: ids.patient,
  name: PATIENT,
  fileNo: `F4-${tag}`,
  age: 55,
  sex: "Male",
  phone: null,
  priority: "normal",
  slot: "10:30",
  minutesLate: null,
  checkedInAt: new Date().toISOString(),
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
  status: "checked_in",
  statusLabel: "Checked in",
});

async function mockArrivals(page) {
  await page.route("**/api/giniflow/stations/reception/arrivals**", (route) =>
    route.fulfill({
      json: {
        date: ids.day,
        expected: [],
        onFloor: [arrival()],
        notComing: [],
        counts: { expected: 0, onFloor: 1, notComing: 0, onFloorHere: 1 },
        query: "",
        serverTime: new Date().toISOString(),
      },
    }),
  );
}

const openReception = (page, search = "") =>
  gotoReady(page, `${RECEPTION}${search}`, () => arrivalsTab(page));

async function watchLive(page) {
  await page.addInitScript(() => {
    const Native = window.EventSource;
    window.__liveSources = [];
    window.EventSource = class extends Native {
      constructor(...args) {
        super(...args);
        window.__liveSources.push(this);
      }
    };
  });
  const requests = [];
  page.on("request", (request) => {
    if (request.url().includes(EVENTS)) requests.push(request.url());
  });
  return requests;
}

const openLive = (page, path) =>
  page.evaluate(
    (p) => window.__liveSources.filter((s) => s.readyState !== 2 && s.url.includes(p)).length,
    path,
  );

test.describe.serial("P4C-13 the billing counter inside the reception station", () => {
  test.describe.configure({ retries: 1 });

  test.beforeAll(async () => {
    payLaterBefore =
      (await query(`SELECT allow_pay_later FROM billing_settings`)).rows[0]?.allow_pay_later ??
      false;
    ids = await setUp(tag);
    const draft = await bills.openDraft(ids.visit, desk, db);
    await bills.addLine(draft.id, { item_id: ids.consultNew }, desk, db);
    ids.bill = draft.id;
    typed = await extraVisit(ids, "Typed");
    typed.bill = (await bills.openDraft(typed.visit, desk, db)).id;
    await bills.addLine(typed.bill, { item_id: ids.brace }, desk, db);
    await bills.setCategory(typed.bill, { category: ids.paid }, desk, db);
    await setPayLater(true);
  });

  test.afterAll(async () => {
    await setPayLater(payLaterBefore).catch(() => {});
    await tearDown(ids);
  });

  test("1. reception and reception_admin get Bill, Dues and Shift; a coordinator does not", async ({
    page,
  }) => {
    for (const role of ["reception", "reception_admin"]) {
      await loginAs(page, role);
      await openReception(page);
      const names = await page.getByRole("tablist", { name: "Reception" }).getByRole("tab");
      await expect(names).toHaveText([
        /^Arrivals/,
        "Bill",
        "Dues",
        "Shift",
        /^Refunds/,
        /^Payments/,
      ]);
      await expect(arrivalsTab(page)).toHaveAttribute("aria-selected", "true");
    }

    const coordinator = await page.context().newPage();
    await loginAs(coordinator, "coordinator");
    await openReception(coordinator, `?tab=bill&visit=${ids.visit}`);
    await expect(
      coordinator.getByRole("tablist", { name: "Reception" }).getByRole("tab"),
    ).toHaveText([/^Arrivals/, /^Payments/]);
    await expect(arrivalsTab(coordinator)).toHaveAttribute("aria-selected", "true");
    await expect(searchbox(coordinator)).toHaveCount(0);
    await expect(header(coordinator)).toHaveCount(0);
    await coordinator.close();
  });

  test("2. Dues is offered only while pay later is allowed", async ({ page }) => {
    await setPayLater(false);
    try {
      await loginAs(page, "reception");
      await openReception(page, "?tab=dues");
      await expect(tab(page, "Bill")).toHaveAttribute("aria-selected", "true");
      await expect(tab(page, "Dues")).toHaveCount(0);
    } finally {
      await setPayLater(true);
    }
  });

  test("3. ?tab=bill&visit= opens that patient's bill", async ({ page }) => {
    await loginAs(page, "reception");
    await gotoReady(page, `${RECEPTION}?tab=bill&visit=${ids.visit}`, () => header(page));
    await expect(tab(page, "Bill")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("table", { name: "Bill lines" })).toBeVisible();
    await expect(page.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "bc-tab-bill");
  });

  test("4. an Arrivals row shows the bill badge, and Bill switches tabs in the same window", async ({
    page,
  }) => {
    await mockArrivals(page);
    await loginAs(page, "reception");
    await openReception(page);
    await expect(row(page)).toBeVisible();
    await expect(row(page).locator(".bc-badge")).toHaveText("Draft");

    let pages = 0;
    page.context().on("page", () => pages++);
    await row(page).getByRole("link", { name: "Bill", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${RECEPTION}\\?tab=bill&visit=${ids.visit}$`));
    await expect(header(page)).toBeVisible();
    await expect(tab(page, "Bill")).toHaveAttribute("aria-selected", "true");
    expect(pages).toBe(0);
  });

  test("4b. after a check-in, Open bill takes reception straight to that patient's bill", async ({
    page,
  }) => {
    const booked = {
      ...arrival(),
      status: "booked",
      statusLabel: "Booked",
      checkedInAt: null,
      suggestedVisitTypeId: 991301,
    };
    await page.route("**/api/giniflow/stations/reception/arrivals**", (route) =>
      route.fulfill({
        json: {
          date: ids.day,
          expected: [booked],
          onFloor: [],
          notComing: [],
          counts: { expected: 1, onFloor: 0, notComing: 0 },
          query: "",
          serverTime: new Date().toISOString(),
        },
      }),
    );
    await page.route("**/api/flow/visit-types**", (route) =>
      route.fulfill({ json: [{ id: 991301, name: `P4C13 Visit ${tag}`, for_online: false }] }),
    );
    await page.route("**/api/giniflow/journey/plan/991301", (route) =>
      route.fulfill({
        json: [
          {
            catalogId: 991302,
            name: "Vitals",
            role: "vitals",
            minutes: 5,
            included: true,
            source: "template",
          },
        ],
      }),
    );
    let checkedIn = 0;
    await page.route(`**/api/giniflow/stations/reception/${ids.visit}/checkin`, (route) => {
      checkedIn++;
      return route.fulfill({ json: { totalCount: 1, plannedTotalMin: 5, raised: null } });
    });

    await loginAs(page, "reception");
    await openReception(page);
    await page.getByRole("button", { name: "✓ Arrived" }).click();
    const panel = page.getByRole("dialog", { name: "Check in" });
    await panel
      .getByRole("button", { name: /Check in/ })
      .first()
      .click();
    await expect.poll(() => checkedIn).toBe(1);
    await expect(panel.getByRole("status")).toContainText("is checked in");
    await panel.getByRole("link", { name: "Open bill →" }).click();
    await expect(page).toHaveURL(new RegExp(`${RECEPTION}\\?tab=bill&visit=${ids.visit}$`));
    await expect(header(page)).toBeVisible();
  });

  test("5. a coordinator's Arrivals rows carry no badge and fetch no bills", async ({ page }) => {
    const counterCalls = [];
    page.on("request", (r) => {
      if (r.url().includes("/api/billing/counter/patients")) counterCalls.push(r.url());
    });
    await mockArrivals(page);
    await loginAs(page, "coordinator");
    await openReception(page);
    await expect(row(page)).toBeVisible();
    await settle(page);
    await expect(row(page).locator(".bc-badge")).toHaveCount(0);
    await expect(row(page).getByRole("link", { name: "Bill", exact: true })).toHaveCount(0);
    expect(counterCalls).toEqual([]);
  });

  test("6. the old counter address redirects with its visit, bill and patient", async ({
    page,
  }) => {
    await loginAs(page, "reception");
    await gotoReady(page, `/giniflow/station/billing?visit=${ids.visit}&bill=${ids.bill}`, () =>
      header(page),
    );
    await expect(page).toHaveURL(
      new RegExp(`${RECEPTION}\\?tab=bill&visit=${ids.visit}&bill=${ids.bill}$`),
    );
    await expect(tab(page, "Bill")).toHaveAttribute("aria-selected", "true");

    await gotoReady(page, `/giniflow/station/billing?patient=${ids.patient}`, () => header(page));
    await expect(page).toHaveURL(new RegExp(`${RECEPTION}\\?tab=bill&visit=${ids.visit}$`));
  });

  test("7. the patient sent from the dues register survives the redirect", async ({ page }) => {
    await loginAs(page, "reception");
    await openReception(page);
    await page.evaluate(
      ({ bill, name }) => {
        window.history.pushState(
          { usr: { duePatient: { name, fileNo: "F-SENT" } }, key: "sent", idx: 1 },
          "",
          `/giniflow/station/billing?bill=${bill}`,
        );
        window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
      },
      { bill: ids.bill, name: SENT },
    );
    await expect(page).toHaveURL(new RegExp(`${RECEPTION}\\?tab=bill&bill=${ids.bill}$`));
    await expect(header(page, SENT)).toBeVisible();
  });

  test("8. a reload keeps the tab, the patient and the typed payment", async ({ page }) => {
    await loginAs(page, "reception");
    await gotoReady(page, `${RECEPTION}?tab=bill&visit=${typed.visit}`, () => pad(page));
    await expect(pad(page).getByText(RESTORED)).toHaveCount(0);
    await pad(page).getByLabel("Amount").fill("300");
    await pad(page).getByLabel("Pay later").check();
    await settle(page);

    await page.reload();
    await pad(page).waitFor({ state: "visible" });
    await expect(tab(page, "Bill")).toHaveAttribute("aria-selected", "true");
    await expect(header(page, `P4 Typed ${tag}`)).toBeVisible();
    await expect(pad(page).getByLabel("Amount")).toHaveValue("300");
    await expect(pad(page).getByLabel("Pay later")).toBeChecked();
    await expect(pad(page).getByText(RESTORED)).toBeVisible();

    await tab(page, "Shift").click();
    await expect(page).toHaveURL(/tab=shift/);
    await page.reload();
    await expect(page.getByRole("region", { name: "Shift" })).toBeVisible();
    await expect(tab(page, "Shift")).toHaveAttribute("aria-selected", "true");
  });

  test("9. at 900px and below the patient list folds away and nothing scrolls sideways", async ({
    page,
  }) => {
    await loginAs(page, "reception");
    for (const width of [880, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await gotoReady(page, `${RECEPTION}?tab=bill&visit=${ids.visit}`, () => header(page));
      const toggle = page.getByRole("button", { name: /^Patients · \d+/ });
      await expect(toggle).toBeVisible();
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(page.locator("#bc-list-panel")).toBeHidden();
      await expect(searchbox(page)).toBeVisible();

      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await expect(page.locator("#bc-list-panel")).toBeVisible();

      const sideways = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(sideways, `page at ${width}px`).toBeLessThanOrEqual(1);
    }

    await page.setViewportSize({ width: 1280, height: 800 });
    await gotoReady(page, `${RECEPTION}?tab=bill&visit=${ids.visit}`, () => header(page));
    await expect(page.getByRole("button", { name: /^Patients · \d+/ })).toBeHidden();
    await expect(page.locator("#bc-list-panel")).toBeVisible();
  });

  test("10. the whole page holds exactly one live connection, whichever tab is open", async ({
    page,
  }) => {
    const requests = await watchLive(page);
    await loginAs(page, "reception");
    await gotoReady(page, `${RECEPTION}?tab=bill&visit=${ids.visit}`, () => header(page));
    await expect.poll(() => requests.some((url) => url.includes("date="))).toBe(true);
    await expect.poll(() => openLive(page, EVENTS)).toBe(1);
    const settled = requests.length;

    await tab(page, "Shift").click();
    await arrivalsTab(page).click();
    await tab(page, "Bill").click();
    await expect(header(page)).toBeVisible();
    await settle(page);

    expect(await openLive(page, EVENTS)).toBe(1);
    expect(requests.length).toBe(settled);
  });
});
