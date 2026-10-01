import { test, expect } from "@playwright/test";
import { one, query } from "../../helpers/db.mjs";
import { apiAs, loginAs } from "../../helpers/auth.mjs";
import { closePdfViewer, expectPdfInViewer } from "../../helpers/pdfViewer.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { newTag, setUp, tearDown } from "../phase4/p4-bills-fixture.mjs";
import {
  admin,
  askRefund,
  db,
  dropShifts,
  finalBill,
  inCash,
  lineFor,
  openDeskShift,
  prepareCategory,
  refundApproved,
} from "./p4b-refunds.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const requests = await import("../../../server/services/billing/billingRequests.js");
const payments = await import("../../../server/services/billing/payments.js");

const tag = newTag();
const RECEPTION = "/giniflow/station/reception";
const otherDesk = {
  actorId: USERS.reception_admin.id,
  ip: "10.9.40.20",
  role: USERS.reception_admin.role,
};
let ids;
let payLaterBefore;
let today;
let longAgo;

const nameOf = (label) => `P4 ${label} ${tag}`;

async function get(url, params, role = "reception") {
  const api = await apiAs(role);
  const response = await api.get(url, params ? { params } : undefined);
  const body = await response.json().catch(() => null);
  await api.dispose();
  return { status: response.status(), body };
}

async function board(params = {}) {
  const { status, body } = await get("/api/billing/refunds", { q: tag, ...params });
  expect(status, JSON.stringify(body)).toBe(200);
  return body;
}

const names = (rows) => rows.map((row) => row.patient.name).sort();

const tab = (page, name) =>
  page
    .getByRole("tablist", { name: "Reception" })
    .getByRole("tab", { name: new RegExp(`^${name}`) });

const refundsBadge = (page) => tab(page, "Refunds").locator(".st-tab-n");

const section = (page, title) => page.getByRole("region", { name: new RegExp(`^${title}`) });

const toggle = (page, title) =>
  section(page, title).getByRole("button", { name: new RegExp(`^.?${title}`) });

async function openRefunds(page, extra = "") {
  await gotoReady(page, `${RECEPTION}?tab=refunds${extra}`, () =>
    page.getByRole("searchbox", { name: "Search refunds" }),
  );
}

async function openSection(page, title) {
  const button = toggle(page, title);
  await expect(async () => {
    if ((await button.getAttribute("aria-expanded")) !== "true") await button.click();
    await expect(button).toHaveAttribute("aria-expanded", "true", { timeout: 1000 });
  }).toPass();
}

const rowOf = (page, title, label) =>
  section(page, title)
    .getByRole("row")
    .filter({ hasText: nameOf(label) });

const counterRow = async (label) => {
  const { body } = await get("/api/billing/counter/patients", { q: tag });
  return [...body.toBill, ...body.billed, ...body.waiting].find(
    (row) => row.name === nameOf(label),
  );
};

const toPayCount = async () => (await get("/api/billing/refunds")).body.counts.to_pay;

async function rejectOld(bill) {
  const request = await askRefund(bill.id, "whole");
  await requests.rejectRequest(request.id, { note: `Old one ${tag}` }, admin, db);
  await query(
    `UPDATE billing_requests SET requested_at = requested_at - INTERVAL '3 days',
            decided_at = decided_at - INTERVAL '3 days' WHERE id = $1`,
    [request.id],
  );
  return request;
}

test.describe.serial("P4B-20 reception Refunds tab", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    await prepareCategory(ids);
    ({ allow_pay_later: payLaterBefore } = await one(
      `SELECT allow_pay_later FROM billing_settings`,
    ));
    await query(`UPDATE billing_settings SET allow_pay_later = TRUE`);
    ({ today, longAgo } = await one(
      `SELECT (NOW() AT TIME ZONE 'Asia/Kolkata')::date::text AS today,
              ((NOW() AT TIME ZONE 'Asia/Kolkata')::date - 3)::text AS "longAgo"`,
    ));
    await openDeskShift(5000);
    const paid = async (label, lines = [{ item: ids.brace }]) =>
      (await finalBill(ids, label, lines, { pay: inCash })).bill;

    ids.pay = await paid("RfPay", [{ item: ids.brace }, { item: ids.dressing }]);
    ids.wait = await paid("RfWait");
    ids.other = await paid("RfOther");
    ids.rej = await paid("RfRej");
    ids.done = await paid("RfDone");
    ids.oldRej = await paid("RfOldRej");
    ids.oldDone = await paid("RfOldDone");
    ids.later = (
      await finalBill(ids, "RfLater", [{ item: ids.brace }, { item: ids.dressing }], {
        pay: [{ mode: "cash", amount: 300 }],
        payLater: true,
      })
    ).bill;

    ids.payReq = await refundApproved(ids.pay.id, [{ line_id: lineFor(ids.pay, ids.brace).id }], {
      ask: { requested_mode: "cash" },
    });
    ids.waitReq = await askRefund(ids.wait.id, "whole", { reason_code: "long_wait", note: "" });
    ids.otherReq = await requests.createRefundRequest(
      {
        bill_id: ids.other.id,
        whole_bill: true,
        reason_code: "doctor_cancelled",
        note: `Asked at the other desk ${tag}`,
        requested_mode: "upi",
      },
      otherDesk,
      db,
    );
    const rejected = await askRefund(ids.rej.id, "whole");
    await requests.rejectRequest(rejected.id, { note: `Seen already ${tag}` }, admin, db);
    ids.rejReq = rejected;

    ids.doneReq = await refundApproved(ids.done.id, "whole");
    const note = ids.doneReq.credit_note;
    await payments.payOut(
      note.id,
      { version: note.version, payments: [{ mode: "cash", amount: 800 }] },
      { actorId: USERS.reception.id, ip: "10.9.40.21", role: "reception" },
      db,
    );

    ids.oldRejReq = await rejectOld(ids.oldRej);
    ids.oldDoneReq = await refundApproved(ids.oldDone.id, "whole");
    const oldNote = ids.oldDoneReq.credit_note;
    await payments.payOut(
      oldNote.id,
      { version: oldNote.version, payments: [{ mode: "cash", amount: 800 }] },
      { actorId: USERS.reception.id, ip: "10.9.40.21", role: "reception" },
      db,
    );
    await query(
      `UPDATE payments SET received_at = received_at - INTERVAL '3 days' WHERE bill_id = $1`,
      [oldNote.id],
    );

    ids.laterReq = await refundApproved(ids.later.id, [
      { line_id: lineFor(ids.later, ids.brace).id },
    ]);
  });

  test.afterAll(async () => {
    try {
      if (payLaterBefore !== undefined) {
        await query(`UPDATE billing_settings SET allow_pay_later = $1`, [payLaterBefore]);
      }
    } finally {
      await tearDown(ids);
      await dropShifts();
    }
  });

  test("1. the four groups hold the right requests, with patient, bill, CN, amounts, reason, modes and people", async () => {
    const body = await board();
    expect(body).toMatchObject({ from: today, to: today, q: tag });
    expect(body.counts).toEqual({ to_pay: 1, waiting: 2, rejected: 1, paid: 2 });
    expect(body.to_pay_total).toBe(80000);

    const [pay] = body.groups.to_pay;
    expect(pay).toMatchObject({
      request_id: ids.payReq.id,
      status: "approved",
      patient: { name: nameOf("RfPay"), file_no: `F4RfPay-${tag}` },
      visit_id: ids.pay.visit_id,
      bill_id: ids.pay.id,
      bill_no: ids.pay.bill_no,
      requested_mode: "cash",
      approved_mode: "cash",
      requested_by: { id: USERS.reception.id, name: USERS.reception.name },
      decided_by: { id: USERS.admin.id, name: USERS.admin.name },
      credit_note: { id: ids.payReq.credit_note.id, bill_no: ids.payReq.credit_note.bill_no },
      amounts: { credited: 80000, paid_back: 0, to_pay: 80000, against_balance: 0 },
      reason: {
        code: "patient_declined",
        label: "Patient declined",
        note: "The patient asked for the money back",
      },
    });
    expect(pay.visit_date).toBe(today);

    expect(names(body.groups.waiting)).toEqual([nameOf("RfOther"), nameOf("RfWait")].sort());
    const other = body.groups.waiting.find((row) => row.request_id === ids.otherReq.id);
    expect(other).toMatchObject({
      requested_by: { id: USERS.reception_admin.id, name: USERS.reception_admin.name },
      requested_mode: "upi",
      approved_mode: null,
      credit_note: null,
      reason: { code: "doctor_cancelled", note: `Asked at the other desk ${tag}` },
      amounts: { credited: 80000, to_pay: 80000, paid_back: 0, against_balance: 0 },
    });
    expect(other.preview.refund.legs).toEqual([{ mode: "upi", amount: 80000 }]);
    const wait = body.groups.waiting.find((row) => row.request_id === ids.waitReq.id);
    expect(wait.reason).toMatchObject({
      code: "long_wait",
      label: "Long waiting time",
      note: null,
    });

    const [rej] = body.groups.rejected;
    expect(rej).toMatchObject({
      request_id: ids.rejReq.id,
      status: "rejected",
      decision_note: `Seen already ${tag}`,
      decided_by: { name: USERS.admin.name },
      credit_note: null,
    });

    const done = body.groups.paid.find((row) => row.request_id === ids.doneReq.id);
    expect(done).toMatchObject({
      credit_note: { id: ids.doneReq.credit_note.id },
      amounts: { credited: 80000, paid_back: 80000, to_pay: 0, against_balance: 0 },
      paid_by: USERS.reception.name,
    });
    expect(done.paid_at).toBeTruthy();
    const later = body.groups.paid.find((row) => row.request_id === ids.laterReq.id);
    expect(later.amounts).toEqual({
      credited: 80000,
      paid_back: 0,
      to_pay: 0,
      against_balance: 80000,
    });
  });

  test("2. the search finds by name, file number, bill number and CN number, on the server", async () => {
    expect(names((await board({ q: nameOf("RfWait") })).groups.waiting)).toEqual([
      nameOf("RfWait"),
    ]);
    const byFile = await board({ q: `F4RfPay-${tag}` });
    expect(byFile.counts).toEqual({ to_pay: 1, waiting: 0, rejected: 0, paid: 0 });
    const byBill = await board({ q: ids.other.bill_no });
    expect(byBill.groups.waiting.map((row) => row.request_id)).toEqual([ids.otherReq.id]);
    const byNote = await board({ q: ids.doneReq.credit_note.bill_no });
    expect(byNote.counts).toEqual({ to_pay: 0, waiting: 0, rejected: 0, paid: 1 });
    expect(byNote.groups.paid[0].request_id).toBe(ids.doneReq.id);
  });

  test("3. the dates pick rejected and paid-back refunds only; bad dates are refused", async () => {
    const wide = await board({ from: longAgo, to: today });
    expect(wide.counts).toEqual({ to_pay: 1, waiting: 2, rejected: 2, paid: 3 });
    const old = await board({ from: longAgo, to: longAgo });
    expect(old.counts).toEqual({ to_pay: 1, waiting: 2, rejected: 1, paid: 1 });
    expect(old.groups.rejected[0].request_id).toBe(ids.oldRejReq.id);
    expect(old.groups.paid[0].request_id).toBe(ids.oldDoneReq.id);

    const backwards = await get("/api/billing/refunds", { from: today, to: longAgo });
    expect(backwards.status).toBe(400);
    const junk = await get("/api/billing/refunds", { from: "2026-02-31" });
    expect(junk.status).toBe(400);
    const extra = await get("/api/billing/refunds", { status: "pending" });
    expect(extra.status).toBe(400);
  });

  test("4. the tab sits after Shift with the to-pay count; sections, rows, search and dates work on screen", async ({
    page,
  }) => {
    const toPay = await toPayCount();
    await loginAs(page, "reception");
    await openRefunds(page);
    await expect(page.getByRole("tablist", { name: "Reception" }).getByRole("tab")).toHaveText([
      /^Arrivals/,
      "Bill",
      "Dues",
      "Shift",
      /^Refunds/,
      /^Payments/,
    ]);
    await expect(tab(page, "Refunds")).toHaveAttribute("aria-selected", "true");
    await expect(refundsBadge(page)).toHaveText(String(toPay));

    await page.getByRole("searchbox", { name: "Search refunds" }).fill(tag);
    const heads = page.locator(".bc-refunds h3");
    await expect(heads).toHaveText([
      "Refunds",
      /Approved — pay out now\s*1$/,
      /Waiting for admin\s*2$/,
      /Rejected\s*1$/,
      /Paid back\s*2$/,
    ]);
    await expect(toggle(page, "Approved — pay out now")).toHaveAttribute("aria-expanded", "true");

    const pay = rowOf(page, "Approved — pay out now", "RfPay");
    await expect(pay).toContainText(`F4RfPay-${tag}`);
    await expect(pay).toContainText(ids.pay.bill_no);
    await expect(pay).toContainText(ids.payReq.credit_note.bill_no);
    await expect(pay).toContainText("₹800 to pay back");
    await expect(pay).toContainText("Cash");
    await expect(pay).toContainText("Patient declined");
    await expect(pay).toContainText(`by ${USERS.reception.name}`);
    await expect(pay).toContainText(`Approved`);

    const other = rowOf(page, "Waiting for admin", "RfOther");
    await expect(other).toContainText(`by ${USERS.reception_admin.name}`);
    await expect(other).toContainText("₹800 to go back");
    await expect(other).toContainText("Asked: UPI");
    await expect(other).toContainText(`Asked at the other desk ${tag}`);

    await openSection(page, "Rejected");
    await expect(rowOf(page, "Rejected", "RfRej")).toContainText(
      `Rejected by ${USERS.admin.name}: Seen already ${tag}`,
    );
    await expect(rowOf(page, "Rejected", "RfOldRej")).toHaveCount(0);

    await page.getByRole("searchbox", { name: "Search refunds" }).fill(ids.pay.bill_no);
    await expect(section(page, "Waiting for admin").getByRole("row")).toHaveCount(0);
    await expect(pay).toBeVisible();

    await page.getByRole("searchbox", { name: "Search refunds" }).fill(tag);
    await page.getByLabel("Rejected / paid back from").fill(longAgo);
    await page.getByLabel("to", { exact: true }).fill(longAgo);
    await openSection(page, "Paid back");
    await expect(rowOf(page, "Rejected", "RfOldRej")).toBeVisible();
    await expect(rowOf(page, "Rejected", "RfRej")).toHaveCount(0);
    await expect(rowOf(page, "Paid back", "RfOldDone")).toBeVisible();
    await expect(rowOf(page, "Paid back", "RfDone")).toHaveCount(0);
    await expect(rowOf(page, "Approved — pay out now", "RfPay")).toBeVisible();
  });

  test("5. a paid-back row links the refund receipt PDF with a token", async ({ page }) => {
    await loginAs(page, "reception");
    await openRefunds(page);
    await page.getByRole("searchbox", { name: "Search refunds" }).fill(tag);
    await openSection(page, "Paid back");
    const done = rowOf(page, "Paid back", "RfDone");
    await expect(done).toContainText("₹800 paid back");
    await expect(done).toContainText(`Paid back`);
    await done.getByRole("button", { name: "Print refund receipt" }).click();
    const href = await expectPdfInViewer(page, "/refund-receipt.pdf?token=");
    await closePdfViewer(page);
    expect(href).toContain(
      `/api/billing/credit-notes/${ids.doneReq.credit_note.id}/refund-receipt.pdf?token=`,
    );
    const response = await page.request.get(href);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("application/pdf");
    await expect(
      rowOf(page, "Paid back", "RfLater").getByRole("button", { name: "Print refund receipt" }),
    ).toHaveCount(0);
    await expect(rowOf(page, "Paid back", "RfLater")).toContainText("₹800 off what is owed");
  });

  test("6. the Bill tab list badges a pending refund, money to pay back and a refund paid out", async ({
    page,
  }) => {
    expect(await counterRow("RfOther")).toMatchObject({ refundPending: true, refunded: 0 });
    expect(await counterRow("RfPay")).toMatchObject({
      refundPending: false,
      payBack: 80000,
      refunded: 0,
    });
    expect(await counterRow("RfDone")).toMatchObject({ refundPending: false, refunded: 80000 });
    expect(await counterRow("RfLater")).toMatchObject({ refundPending: false, refunded: 0 });

    await loginAs(page, "reception");
    await gotoReady(page, `${RECEPTION}?tab=bill`, () =>
      page.getByRole("searchbox", { name: "Search today's patients" }),
    );
    await page.getByRole("searchbox", { name: "Search today's patients" }).fill(tag);
    const listRow = (label) => page.getByRole("button", { name: new RegExp(nameOf(label)) });
    await expect(
      listRow("RfOther").locator(".bc-badge", { hasText: "Refund pending" }),
    ).toBeVisible();
    await expect(
      listRow("RfPay").locator(".bc-badge", { hasText: "₹800 to pay back" }),
    ).toBeVisible();
    await expect(listRow("RfDone").locator(".bc-badge", { hasText: "Refunded" })).toBeVisible();
    await expect(listRow("RfDone").locator(".bc-badge", { hasText: "Refund pending" })).toHaveCount(
      0,
    );
    await expect(listRow("RfLater").locator(".bc-badge", { hasText: "Refunded" })).toHaveCount(0);
  });

  test("7. Open lands on the Bill tab with the Pay out form; paying out moves the row to Paid back and drops the badge", async ({
    page,
  }) => {
    const before = await toPayCount();
    await loginAs(page, "reception");
    await openRefunds(page);
    await expect(refundsBadge(page)).toHaveText(String(before));
    await page.getByRole("searchbox", { name: "Search refunds" }).fill(tag);
    await rowOf(page, "Approved — pay out now", "RfPay")
      .getByRole("button", { name: `Open bill ${ids.pay.bill_no}` })
      .click();

    await expect(tab(page, "Bill")).toHaveAttribute("aria-selected", "true");
    const url = new URL(page.url());
    expect(url.searchParams.get("tab")).toBe("bill");
    expect(url.searchParams.get("visit")).toBe(ids.pay.visit_id);
    expect(url.searchParams.get("bill")).toBe(ids.pay.id);
    const card = page.getByRole("region", { name: "Refunds" });
    const payOut = card.getByRole("group", {
      name: `Pay out on ${ids.payReq.credit_note.bill_no}`,
    });
    await payOut.getByRole("button", { name: "Pay out ₹800" }).click();
    await expect(card).toContainText(`Paid back ₹800 on ${ids.payReq.credit_note.bill_no}`);

    await tab(page, "Refunds").click();
    await expect(refundsBadge(page)).toHaveText(String(before - 1));
    await page.getByRole("searchbox", { name: "Search refunds" }).fill(tag);
    await expect(rowOf(page, "Approved — pay out now", "RfPay")).toHaveCount(0);
    await openSection(page, "Paid back");
    await expect(rowOf(page, "Paid back", "RfPay")).toContainText("₹800 paid back");
  });

  test("8. an approval while the tab is open shows a notice and raises the badge without a reload", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const before = await toPayCount();
    await loginAs(page, "reception");
    await openRefunds(page);
    await expect(refundsBadge(page)).toHaveText(String(before));
    let reloaded = false;
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) reloaded = true;
    });

    await requests.approveRequest(ids.waitReq.id, {}, admin, db);
    await expect(page.locator(".toast")).toHaveText(
      `Refund approved for ${nameOf("RfWait")} — ₹800 to pay back`,
      { timeout: 40_000 },
    );
    await expect(refundsBadge(page)).toHaveText(String(before + 1));
    await page.getByRole("searchbox", { name: "Search refunds" }).fill(tag);
    await expect(rowOf(page, "Approved — pay out now", "RfWait")).toContainText("₹800 to pay back");
    expect(reloaded).toBe(false);
  });

  test("9. a role without the billing desk gets 403 and no Refunds tab", async ({ page }) => {
    for (const role of ["lab", "coordinator"]) {
      expect((await get("/api/billing/refunds", {}, role)).status).toBe(403);
    }
    expect((await get("/api/billing/refunds", {}, "reception_admin")).status).toBe(200);

    await loginAs(page, "coordinator");
    await gotoReady(page, `${RECEPTION}?tab=refunds`, () =>
      page.getByRole("tablist", { name: "Reception" }),
    );
    await expect(page.getByRole("tablist", { name: "Reception" }).getByRole("tab")).toHaveText([
      /^Arrivals/,
      /^Payments/,
    ]);
    await expect(tab(page, "Arrivals")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("searchbox", { name: "Search refunds" })).toHaveCount(0);
  });

  test("10. at phone width the Refunds tab fits with no sideways scroll", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginAs(page, "reception");
    await openRefunds(page);
    await page.getByRole("searchbox", { name: "Search refunds" }).fill(tag);
    for (const title of ["Waiting for admin", "Rejected", "Paid back"]) {
      await openSection(page, title);
    }
    const open = rowOf(page, "Approved — pay out now", "RfWait").getByRole("button", {
      name: `Open bill ${ids.wait.bill_no}`,
    });
    await expect(open).toBeVisible();
    await open.scrollIntoViewIfNeeded();
    await expect(open).toBeInViewport();
    const sideways = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(sideways).toBeLessThanOrEqual(1);
    const receipt = rowOf(page, "Paid back", "RfDone").getByRole("button", {
      name: "Print refund receipt",
    });
    await receipt.scrollIntoViewIfNeeded();
    await expect(receipt).toBeInViewport();
  });
});
