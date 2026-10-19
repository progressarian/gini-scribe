import { test, expect } from "@playwright/test";
import { one, query } from "../../helpers/db.mjs";
import { apiAs, loginAs } from "../../helpers/auth.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { desk, extraVisit, newTag, setUp, tearDown } from "../phase4/p4-bills-fixture.mjs";
import {
  askRefund,
  db,
  dropShifts,
  finalBill,
  inCash,
  openDeskShift,
  prepareCategory,
} from "./p4b-refunds.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
await import("../../../server/services/giniflow/board.js");
const bills = await import("../../../server/services/billing/bills.js");
const payments = await import("../../../server/services/billing/payments.js");
const visitLines = await import("../../../server/services/billing/visitLines.js");
const cancels = await import("../../../server/services/giniflow/cancelRequests.js");
const requests = await import("../../../server/services/billing/billingRequests.js");

const tag = newTag();
const HOME = "/desk-requests";
const RECEPTION = "/giniflow/station/reception";
const WANTED = `P4B22 Knee brace ${tag}`;
const labCtx = { actorId: USERS.lab.id, role: "lab", ip: "10.9.22.1" };
let ids;

const pendingInDb = () =>
  one(
    `SELECT COUNT(*) FILTER (WHERE kind <> 'test_cancel')::int AS desk,
            COUNT(*) FILTER (WHERE kind = 'test_cancel')::int AS tests
       FROM billing_requests WHERE status = 'pending'`,
  );

const menuItem = (page) => page.locator(".tabs").getByRole("link", { name: /Desk requests/ });
const subTab = (page, name) =>
  page.getByRole("tablist", { name: "Desk requests" }).getByRole("tab", { name });
const requestsTab = (page) =>
  page.getByRole("tablist", { name: "Reception" }).getByRole("tab", { name: /^Requests/ });
const waitingTable = (page) => page.getByRole("table", { name: "Billing requests" });
const cancelTable = (page) => page.getByRole("table", { name: "Test cancellation requests" });

const deskHeading = (page) => page.getByRole("heading", { name: "Billing requests" });
const testsHeading = (page) =>
  page.getByRole("heading", { name: "Test cancellations after collection" });

async function paidLabTest(label) {
  const { visit } = await extraVisit(ids, label);
  const order = await one(
    `INSERT INTO giniflow_lab_orders (visit_id, urgency, payment_status, amount_total,
                                      sample_status, kind)
     VALUES ($1, 'today', 'pending', 250, 'payment_pending', 'lab') RETURNING id`,
    [visit],
  );
  await query(
    `INSERT INTO giniflow_lab_order_tests (lab_order_id, test_name, price) VALUES ($1, $2, 250)`,
    [order.id, ids.hba1cName],
  );
  const raised = await visitLines.linesForOrder(
    visit,
    { labOrderId: order.id, testNames: [ids.hba1cName] },
    desk,
    db,
  );
  const ready = await bills.setCategory(raised.bill_id, { category: ids.pensioner }, desk, db);
  await payments.takePayments(
    ready.id,
    { version: ready.version, payments: [{ mode: "cash", amount: ready.totals.payable / 100 }] },
    desk,
    db,
  );
  const fresh = await bills.readBill(ready.id, db);
  await bills.finaliseBill(ready.id, { version: fresh.version }, desk, db);
  await query(`UPDATE giniflow_lab_orders SET sample_status = 'sample_collected' WHERE id = $1`, [
    order.id,
  ]);
  await query(`UPDATE giniflow_visits SET current_status = 'checked_in' WHERE id = $1`, [visit]);
  return { visit, order: order.id };
}

const newItemRequest = (name) =>
  requests.createNewItemRequest(
    { proposed_name: name, proposed_group: "Consumables", reason: `Fitted at the desk ${tag}` },
    desk,
    db,
  );

const tokenAsks = (page) => {
  const asked = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/giniflow/realtime-token")) asked.push(r.url());
  });
  return asked;
};

const noSideScroll = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test.describe.serial("P4B-22 desk requests move out of Settings", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    await prepareCategory(ids);
    await openDeskShift(0);
    const { bill } = await finalBill(ids, "P4B22Refund", [{ item: ids.brace }], { pay: inCash });
    ids.refundBill = bill;
    ids.refund = await askRefund(bill.id, "whole", { reason_code: "long_wait", reason: "Waited" });
    ids.newItem = await newItemRequest(WANTED);
    ids.cancelTest = await paidLabTest("P4B22Cancel");
    ids.cancel = await cancels.raiseCancelRequest(
      { target: { orderId: ids.cancelTest.order }, reason_code: "duplicate" },
      labCtx,
      db,
    );
  });

  test.afterAll(async () => {
    await query(
      `DELETE FROM billing_requests
        WHERE proposed_name LIKE $1
           OR (kind = 'test_cancel' AND visit_id = $2)`,
      [`%${tag}`, ids?.cancelTest?.visit ?? null],
    );
    await tearDown(ids);
    await dropShifts();
  });

  test("1. the counts endpoint matches the lists and answers only the people who decide", async () => {
    const inDb = await pendingInDb();
    expect(inDb.desk).toBeGreaterThanOrEqual(2);
    expect(inDb.tests).toBeGreaterThanOrEqual(1);

    const admin = await apiAs("admin");
    const counts = await (await admin.get("/api/approvals/waiting")).json();
    expect(counts).toEqual({ deskRequests: inDb.desk, testCancellations: inDb.tests });
    const inbox = await (
      await admin.get("/api/billing/master/requests", { params: { status: "pending" } })
    ).json();
    expect(inbox.length).toBe(counts.deskRequests);
    const cancelList = await (
      await admin.get("/api/giniflow/tests/cancel-requests", {
        params: { status: "pending", limit: "1" },
      })
    ).json();
    expect(cancelList.waiting).toBe(counts.testCancellations);
    await admin.dispose();

    const recAdmin = await apiAs("reception_admin");
    expect(await (await recAdmin.get("/api/approvals/waiting")).json()).toEqual({
      deskRequests: inDb.desk,
      testCancellations: null,
    });
    await recAdmin.dispose();

    for (const role of ["reception", "lab"]) {
      const api = await apiAs(role);
      expect((await api.get("/api/approvals/waiting")).status(), role).toBe(403);
      await api.dispose();
    }
  });

  test("2. the top menu shows the item with the number waiting, only to approvers", async ({
    page,
  }) => {
    const inDb = await pendingInDb();
    await loginAs(page, "admin");
    await gotoReady(page, "/settings/billing", () => menuItem(page));
    await expect(menuItem(page)).toHaveText(`📥 Desk requests${inDb.desk + inDb.tests}`);
    await expect(menuItem(page)).toHaveAccessibleName(
      `📥 Desk requests ${inDb.desk + inDb.tests} waiting for you`,
    );
    const items = await page.locator(".tabs a").allTextContents();
    const at = items.findIndex((t) => t.startsWith("📥 Desk requests"));
    expect(items[at + 1]).toMatch(/^🕐 Gini Flow/);

    await loginAs(page, "reception_admin");
    await gotoReady(page, "/settings/services", () => menuItem(page));
    await expect(menuItem(page)).toHaveText(`📥 Desk requests${inDb.desk}`);

    await loginAs(page, "reception");
    await gotoReady(page, RECEPTION, () => page.locator(".tabs"));
    await expect(menuItem(page)).toHaveCount(0);
  });

  test("3. as admin the page has both tabs with counts, opens on billing requests and holds one live connection", async ({
    page,
  }) => {
    const inDb = await pendingInDb();
    const asked = tokenAsks(page);
    await loginAs(page, "admin");
    await gotoReady(page, HOME, () => deskHeading(page));
    await expect(page.getByRole("heading", { level: 1, name: "Desk requests" })).toBeVisible();
    await expect(subTab(page, /^Billing requests/)).toHaveAttribute("aria-selected", "true");
    await expect(subTab(page, /^Billing requests/)).toContainText(String(inDb.desk));
    await expect(subTab(page, /^Test cancellations/)).toContainText(String(inDb.tests));
    await expect(waitingTable(page).getByRole("row").filter({ hasText: WANTED })).toBeVisible();

    await subTab(page, /^Billing requests/).focus();
    await page.keyboard.press("ArrowRight");
    await expect(testsHeading(page)).toBeVisible();
    await expect(subTab(page, /^Test cancellations/)).toBeFocused();
    await expect(page).toHaveURL(/tab=tests/);
    await page.keyboard.press("ArrowLeft");
    await expect(deskHeading(page)).toBeVisible();
    await page.waitForTimeout(500);
    expect(asked.length).toBe(1);
    asked.length = 0;

    await gotoReady(page, `${HOME}?tab=tests`, () => testsHeading(page));
    await expect(subTab(page, /^Test cancellations/)).toHaveAttribute("aria-selected", "true");
    await page.waitForTimeout(500);
    expect(asked.length).toBe(1);
  });

  test("4. reception admin sees billing requests directly, with no tab row", async ({ page }) => {
    await loginAs(page, "reception_admin");
    await gotoReady(page, `${HOME}?tab=tests`, () => deskHeading(page));
    await expect(page.getByRole("tablist", { name: "Desk requests" })).toHaveCount(0);
    await expect(testsHeading(page)).toHaveCount(0);
  });

  test("5. the old Settings addresses forward to the new page and Settings no longer lists them", async ({
    page,
  }) => {
    await loginAs(page, "admin");
    await gotoReady(page, "/settings/desk-requests", () => deskHeading(page));
    await expect(page).toHaveURL(new RegExp(`${HOME}$`));
    await gotoReady(page, "/settings/test-cancellations", () => testsHeading(page));
    await expect(page).toHaveURL(new RegExp(`${HOME}\\?tab=tests$`));
    const settings = page.getByRole("navigation", { name: "Settings sections" });
    await gotoReady(page, "/settings/billing", () => settings);
    await expect(settings.getByRole("link", { name: /Desk requests/ })).toHaveCount(0);
    await expect(settings.getByRole("link", { name: /Test cancellations/ })).toHaveCount(0);
  });

  test("6. the reception screen has a Requests tab for approvers only", async ({ page }) => {
    const inDb = await pendingInDb();
    await loginAs(page, "admin");
    await gotoReady(page, `${RECEPTION}?tab=refunds`, () => requestsTab(page));
    const names = await page
      .getByRole("tablist", { name: "Reception" })
      .getByRole("tab")
      .allTextContents();
    const at = names.findIndex((t) => t.startsWith("Requests"));
    expect(names[at - 1]).toMatch(/^Refunds/);
    await expect(requestsTab(page)).toContainText(String(inDb.desk + inDb.tests));
    await expect(requestsTab(page)).toHaveAccessibleName(
      `Requests ${inDb.desk + inDb.tests} requests waiting for you`,
    );
    await requestsTab(page).click();
    await expect(deskHeading(page)).toBeVisible();
    await expect(page).toHaveURL(/tab=requests/);

    await gotoReady(page, `${RECEPTION}?tab=requests&kind=tests`, () => testsHeading(page));
    await expect(subTab(page, /^Test cancellations/)).toHaveAttribute("aria-selected", "true");

    await loginAs(page, "reception");
    await gotoReady(page, `${RECEPTION}?tab=requests`, () =>
      page.getByRole("tab", { name: /^Arrivals/ }),
    );
    await expect(page.getByRole("tab", { name: /^Arrivals/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(requestsTab(page)).toHaveCount(0);
    await expect(deskHeading(page)).toHaveCount(0);
  });

  test("7. answering from the reception tab lowers every count without a reload", async ({
    page,
  }) => {
    await loginAs(page, "admin");
    const asked = tokenAsks(page);
    await gotoReady(page, `${RECEPTION}?tab=refunds`, () => requestsTab(page));
    await page.waitForTimeout(500);
    const baseline = asked.length;
    asked.length = 0;
    await gotoReady(page, `${RECEPTION}?tab=requests`, () => deskHeading(page));
    await page.waitForTimeout(500);
    expect(asked.length, "the Requests tab opens no live connection of its own").toBe(baseline);
    asked.length = 0;
    const before = await pendingInDb();
    await expect(requestsTab(page)).toContainText(String(before.desk + before.tests));
    let loads = 0;
    page.on("load", () => loads++);

    await waitingTable(page)
      .getByRole("row")
      .filter({ hasText: WANTED })
      .getByRole("button", { name: `Reject request for ${WANTED}` })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Note", { exact: true }).fill("Not stocked");
    await dialog.getByRole("button", { name: "Reject request" }).click();
    await expect(dialog).toHaveCount(0);

    expect((await requests.getRequest(ids.newItem.id, db)).status).toBe("rejected");
    const after = before.desk + before.tests - 1;
    await expect(requestsTab(page)).toContainText(String(after));
    await expect(subTab(page, /^Billing requests/)).toContainText(String(before.desk - 1));
    await expect(menuItem(page)).toContainText(String(after));
    const answered = waitingTable(page).getByRole("row").filter({ hasText: WANTED });
    await expect(answered).toContainText("Rejected");
    await expect(answered.getByRole("button", { name: /^Reject request for/ })).toHaveCount(0);
    expect(loads).toBe(0);
    expect(asked.length).toBe(0);
  });

  test("8. a request raised by someone else appears on the open reception tab without a reload", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await loginAs(page, "admin");
    await gotoReady(page, `${RECEPTION}?tab=requests`, () => deskHeading(page));
    const later = `P4B22 Walking stick ${tag}`;
    await newItemRequest(later);
    await expect(waitingTable(page).getByRole("row").filter({ hasText: later })).toBeVisible({
      timeout: 45_000,
    });
    const now = await pendingInDb();
    await expect(requestsTab(page)).toContainText(String(now.desk + now.tests), {
      timeout: 45_000,
    });
  });

  for (const width of [1366, 768, 390]) {
    test(`9. at ${width}px neither place scrolls sideways and the dialog fits`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 800 });
      await loginAs(page, "admin");
      for (const url of [HOME, `${RECEPTION}?tab=requests`]) {
        await gotoReady(page, url, () => deskHeading(page));
        await expect(subTab(page, /^Billing requests/)).toBeInViewport();
        await expect(subTab(page, /^Test cancellations/)).toBeVisible();
        expect(await noSideScroll(page), `${url} at ${width}px`).toBe(0);
        await waitingTable(page)
          .getByRole("row")
          .filter({ hasText: ids.refundBill.bill_no })
          .getByRole("button", { name: /^Reject request for/ })
          .click();
        const box = await page.getByRole("dialog").boundingBox();
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
        await page.keyboard.press("Escape");
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await subTab(page, /^Test cancellations/).click();
        await expect(testsHeading(page)).toBeVisible();
        expect(await noSideScroll(page), `${url} tests at ${width}px`).toBe(0);
      }
    });
  }

  test("10. with nothing waiting the menu shows no number and the tabs show a grey 0", async ({
    page,
  }) => {
    await page.route("**/api/approvals/waiting", (route) =>
      route.fulfill({ json: { deskRequests: 0, testCancellations: 0 } }),
    );
    await loginAs(page, "admin");
    await gotoReady(page, `${RECEPTION}?tab=requests`, () => deskHeading(page));
    await expect(menuItem(page)).toHaveText("📥 Desk requests");
    await expect(requestsTab(page).locator(".st-tab-n")).toHaveText("0");
    await expect(requestsTab(page).locator(".st-tab-n")).not.toHaveClass(/st-tab-n--alert/);
    await expect(subTab(page, /^Billing requests/).locator(".dri__zero")).toHaveText("0");
  });
});
