import { test, expect } from "@playwright/test";
import { one, query } from "../../helpers/db.mjs";
import { apiAs, loginAs } from "../../helpers/auth.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { desk, extraVisit, newTag, setUp, tearDown } from "../phase4/p4-bills-fixture.mjs";
import {
  admin,
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
const labCtx = { actorId: USERS.lab.id, role: "lab", ip: "10.9.23.1" };
const name = (label) => `P4B23 ${label} ${tag}`;
let ids;

const indiaDay = (offset = 0) =>
  new Date(Date.now() + offset * 86_400_000).toLocaleDateString("en-CA", {
    timeZone: "Asia/Kolkata",
  });
const TODAY = indiaDay();
const EARLIER = indiaDay(-2);

const table = (page) => page.getByRole("table", { name: "Billing requests" });
const cancelTable = (page) => page.getByRole("table", { name: "Test cancellation requests" });
const rowOf = (page, text) => table(page).getByRole("row").filter({ hasText: text });
const dayHeaders = (page) => table(page).locator("tr.dri-day th");
const filterBar = (page) => page.getByRole("search", { name: "Filter requests" });
const heading = (page) => page.getByRole("heading", { name: "Billing requests" });
const testsHeading = (page) =>
  page.getByRole("heading", { name: "Test cancellations after collection" });

const dayLabel = (day) =>
  new Date(`${day}T00:00:00`).toLocaleDateString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });

const backdate = (id) =>
  query(
    `UPDATE billing_requests SET requested_at = requested_at - interval '2 days' WHERE id = $1`,
    [id],
  );

const newItem = (label) =>
  requests.createNewItemRequest(
    { proposed_name: name(label), proposed_group: "Consumables", reason: `Asked ${tag}` },
    desk,
    db,
  );

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
  return cancels.raiseCancelRequest(
    { target: { orderId: order.id }, reason_code: "duplicate" },
    labCtx,
    db,
  );
}

const dbDesk = (sql, params = []) =>
  one(
    `SELECT COUNT(*)::int AS n FROM billing_requests r
      WHERE r.kind <> 'test_cancel' AND ${sql}`,
    params,
  ).then((r) => r.n);

const ASKED_DAY = "(r.requested_at AT TIME ZONE 'Asia/Kolkata')::date";

const noSideScroll = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function openHome(page, suffix = "") {
  await loginAs(page, "admin");
  await gotoReady(page, `${HOME}${suffix}`, () => heading(page));
}

test.describe.serial("P4B-23 desk requests by date, with filters", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    await prepareCategory(ids);
    await openDeskShift(0);
    const { bill } = await finalBill(ids, "P4B23Refund", [{ item: ids.brace }], { pay: inCash });
    ids.refundBill = bill;
    ids.refundPatient = await one(`SELECT name, file_no FROM patients WHERE id = $1`, [
      bill.patient_id,
    ]);
    ids.refund = await askRefund(bill.id, "whole", { reason_code: "long_wait", reason: "Waited" });
    ids.todayWaiting = await newItem("TodayWaiting");
    ids.todayRejected = await newItem("TodayRejected");
    await requests.rejectRequest(ids.todayRejected.id, { note: "Not stocked" }, admin, db);
    ids.oldWaiting = await newItem("OldWaiting");
    await backdate(ids.oldWaiting.id);
    ids.oldRejected = await newItem("OldRejected");
    await requests.rejectRequest(ids.oldRejected.id, { note: "Not stocked" }, admin, db);
    await backdate(ids.oldRejected.id);
    ids.cancelToday = await paidLabTest("P4B23CancelToday");
    ids.cancelOld = await paidLabTest("P4B23CancelOld");
    await backdate(ids.cancelOld.id);
  });

  test.afterAll(async () => {
    await query(
      `DELETE FROM billing_requests
        WHERE proposed_name LIKE $1 OR (kind = 'test_cancel' AND id = ANY($2::uuid[]))`,
      [`%${tag}`, [ids?.cancelToday?.id, ids?.cancelOld?.id].filter(Boolean)],
    );
    await tearDown(ids);
    await dropShifts();
  });

  test("1. both tabs open on All and today, every status, under today's header", async ({
    page,
  }) => {
    await openHome(page);
    await expect(filterBar(page).getByLabel("Status")).toHaveValue("all");
    await expect(filterBar(page).getByLabel("From")).toHaveValue(TODAY);
    await expect(filterBar(page).getByLabel("To")).toHaveValue(TODAY);
    await expect(filterBar(page).getByRole("button", { name: "Clear filters" })).toHaveCount(0);
    for (const label of ["TodayWaiting", "TodayRejected"])
      await expect(rowOf(page, name(label))).toBeVisible();
    await expect(rowOf(page, `Bill ${ids.refundBill.bill_no}`)).toBeVisible();
    await expect(rowOf(page, name("TodayRejected"))).toContainText("Rejected");
    for (const label of ["OldWaiting", "OldRejected"])
      await expect(rowOf(page, name(label))).toHaveCount(0);

    const total = await dbDesk(`${ASKED_DAY} = $1::date`, [TODAY]);
    const waiting = await dbDesk(`${ASKED_DAY} = $1::date AND r.status = 'pending'`, [TODAY]);
    await expect(dayHeaders(page)).toHaveText([
      `${dayLabel(TODAY)} · ${total} request${total === 1 ? "" : "s"} · ${waiting} waiting`,
    ]);

    await page.getByRole("tab", { name: /^Test cancellations/ }).click();
    await expect(testsHeading(page)).toBeVisible();
    await expect(filterBar(page).getByLabel("Status")).toHaveValue("all");
    await expect(filterBar(page).getByLabel("From")).toHaveValue(TODAY);
    await expect(
      cancelTable(page).getByRole("row").filter({ hasText: "P4B23CancelToday" }),
    ).toBeVisible();
    await expect(
      cancelTable(page).getByRole("row").filter({ hasText: "P4B23CancelOld" }),
    ).toHaveCount(0);
  });

  test("2. the status filter narrows the list", async ({ page }) => {
    await openHome(page);
    await filterBar(page).getByLabel("Status").selectOption("pending");
    await expect(rowOf(page, name("TodayRejected"))).toHaveCount(0);
    await expect(rowOf(page, name("TodayWaiting"))).toBeVisible();
    await filterBar(page).getByLabel("Status").selectOption("rejected");
    await expect(rowOf(page, name("TodayRejected"))).toBeVisible();
    await expect(rowOf(page, name("TodayWaiting"))).toHaveCount(0);
    const rejected = await dbDesk(`${ASKED_DAY} = $1::date AND r.status = 'rejected'`, [TODAY]);
    await expect(dayHeaders(page).first()).toContainText(
      `${rejected} request${rejected === 1 ? "" : "s"}`,
    );
    await expect(dayHeaders(page).first()).not.toContainText("waiting");
  });

  test("3. the kind filter shows only refunds", async ({ page }) => {
    await openHome(page);
    await filterBar(page).getByLabel("Kind").selectOption("refund");
    await expect(rowOf(page, `Bill ${ids.refundBill.bill_no}`)).toBeVisible();
    await expect(rowOf(page, name("TodayWaiting"))).toHaveCount(0);
    await page.getByRole("tab", { name: /^Test cancellations/ }).click();
    await expect(filterBar(page).getByLabel("Kind")).toHaveCount(0);
  });

  test("4. a two-day range groups by day, newest first, waiting before answered", async ({
    page,
  }) => {
    await openHome(page);
    await filterBar(page).getByLabel("Search").fill(tag);
    await filterBar(page).getByLabel("From").fill(EARLIER);
    await expect(rowOf(page, name("OldWaiting"))).toBeVisible();
    const headers = await dayHeaders(page).allTextContents();
    expect(headers.map((h) => h.split(" · ")[0])).toEqual([dayLabel(TODAY), dayLabel(EARLIER)]);
    const order = await table(page).locator("tbody tr").allTextContents();
    const at = (label) => order.findIndex((text) => text.includes(name(label)));
    expect(at("TodayWaiting")).toBeLessThan(at("TodayRejected"));
    expect(at("TodayRejected")).toBeLessThan(at("OldWaiting"));
    expect(at("OldWaiting")).toBeLessThan(at("OldRejected"));
  });

  test("5. waiting requests from earlier days are flagged and one click away", async ({ page }) => {
    await openHome(page);
    const older = await dbDesk(`r.status = 'pending' AND ${ASKED_DAY} <> $1::date`, [TODAY]);
    expect(older).toBeGreaterThanOrEqual(1);
    const notice = page.getByRole("status").filter({ hasText: "from earlier days" });
    await expect(notice).toContainText(
      `${older} request${older === 1 ? "" : "s"} from earlier days ${older === 1 ? "is" : "are"} still waiting.`,
    );
    await notice.getByRole("button", { name: "Show them" }).click();
    await expect(filterBar(page).getByLabel("Status")).toHaveValue("pending");
    await expect(filterBar(page).getByLabel("From")).toHaveValue("");
    await expect(rowOf(page, name("OldWaiting"))).toBeVisible();
    await expect(notice).toHaveCount(0);

    await gotoReady(page, `${HOME}?tab=tests`, () => testsHeading(page));
    const tests = page.getByRole("status").filter({ hasText: "from earlier days" });
    await expect(tests).toBeVisible();
    await tests.getByRole("button", { name: "Show them" }).click();
    await expect(
      cancelTable(page).getByRole("row").filter({ hasText: "P4B23CancelOld" }),
    ).toBeVisible();
  });

  test("6. search finds a request by patient name, UHID and bill number", async ({ page }) => {
    await openHome(page);
    const search = filterBar(page).getByLabel("Search");
    for (const text of [
      ids.refundPatient.name,
      ids.refundPatient.file_no,
      ids.refundBill.bill_no,
    ]) {
      await search.fill(text);
      await expect(rowOf(page, name("TodayWaiting"))).toHaveCount(0);
      await expect(rowOf(page, `Bill ${ids.refundBill.bill_no}`)).toBeVisible();
    }
  });

  test("7. Today and Clear filters put the defaults back", async ({ page }) => {
    await openHome(page);
    const bar = filterBar(page);
    await bar.getByLabel("From").fill(EARLIER);
    await bar.getByRole("button", { name: "Today" }).click();
    await expect(bar.getByLabel("From")).toHaveValue(TODAY);
    await expect(bar.getByRole("button", { name: "Today" })).toHaveCount(0);
    await bar.getByLabel("Status").selectOption("rejected");
    await bar.getByLabel("Search").fill("zz");
    await bar.getByRole("button", { name: "Clear filters" }).click();
    await expect(bar.getByLabel("Status")).toHaveValue("all");
    await expect(bar.getByLabel("Search")).toHaveValue("");
    await expect(bar.getByRole("button", { name: "Clear filters" })).toHaveCount(0);
  });

  test("8. the search API matches the database and refuses the wrong people and bad input", async () => {
    const api = await apiAs("admin");
    const found = await (
      await api.get("/api/billing/master/requests/search", {
        params: { from: TODAY, to: TODAY, limit: "100" },
      })
    ).json();
    expect(found.total).toBe(await dbDesk(`${ASKED_DAY} = $1::date`, [TODAY]));
    expect(found.olderWaiting).toBe(
      await dbDesk(`r.status = 'pending' AND ${ASKED_DAY} <> $1::date`, [TODAY]),
    );
    expect(found.rows.every((r) => r.day === TODAY && r.kind !== "test_cancel")).toBe(true);
    for (const params of [{ from: "2026-02-30" }, { from: TODAY, to: EARLIER }]) {
      const bad = await api.get("/api/billing/master/requests/search", { params });
      expect(bad.status(), JSON.stringify(params)).toBe(400);
    }
    expect(
      (
        await api.get("/api/billing/master/requests/search", { params: { kind: "test_cancel" } })
      ).status(),
    ).toBe(400);
    await api.dispose();
    for (const role of ["reception", "lab"]) {
      const other = await apiAs(role);
      expect((await other.get("/api/billing/master/requests/search")).status(), role).toBe(403);
      await other.dispose();
    }
  });

  test("9. a busy day pages at 20 and repeats its header on the next page", async ({ page }) => {
    for (let n = 0; n < 21; n++) await newItem(`Busy${String(n).padStart(2, "0")}`);
    await openHome(page);
    await filterBar(page).getByLabel("Search").fill(`Busy`);
    await expect(table(page).locator("tbody tr:not(.dri-day)")).toHaveCount(20);
    await expect(page.getByText("Page 1 of 2")).toBeVisible();
    await page.getByRole("button", { name: "Next ›" }).click();
    await expect(page.getByText("Page 2 of 2")).toBeVisible();
    await expect(dayHeaders(page)).toHaveCount(1);
    await expect(dayHeaders(page).first()).toContainText(dayLabel(TODAY));
    await expect(table(page).locator("tbody tr:not(.dri-day)")).toHaveCount(1);
  });

  for (const width of [1366, 768, 390]) {
    test(`10. at ${width}px the filters are reachable and nothing scrolls sideways`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 800 });
      await openHome(page);
      for (const label of ["Search", "Status", "Kind", "From", "To"])
        await expect(filterBar(page).getByLabel(label)).toBeVisible();
      await expect(dayHeaders(page).first()).toBeVisible();
      expect(await noSideScroll(page), `billing requests at ${width}px`).toBe(0);
      await page.getByRole("tab", { name: /^Test cancellations/ }).click();
      await expect(testsHeading(page)).toBeVisible();
      expect(await noSideScroll(page), `test cancellations at ${width}px`).toBe(0);
    });
  }
});
