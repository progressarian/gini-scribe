import { test, expect } from "@playwright/test";
import { one } from "../../helpers/db.mjs";
import { loginAs } from "../../helpers/auth.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { newTag, setUp, tearDown } from "../phase4/p4-bills-fixture.mjs";
import {
  askRefund,
  dropShifts,
  finalBill,
  inCash,
  lineFor,
  openDeskShift,
  prepareCategory,
} from "./p4b-refunds.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);

const tag = newTag();
const INBOX = "/settings/desk-requests";
let ids;

const waitingTable = (page) => page.getByRole("table", { name: "Requests waiting" });
const waitingRow = (page, billNo) =>
  waitingTable(page)
    .getByRole("row")
    .filter({ hasText: `Bill ${billNo}` });
const dialog = (page) => page.getByRole("dialog");

async function openInbox(page, role = "reception_admin") {
  await loginAs(page, role);
  await gotoReady(page, INBOX, () => page.getByRole("heading", { name: "Waiting for an answer" }));
}

const requestRow = (id) =>
  one(
    `SELECT status, approved_mode, mode_reason, decision_note, credit_note_id
       FROM billing_requests WHERE id = $1`,
    [id],
  );

test.describe.serial("P4B-11 desk requests inbox: refunds", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    await prepareCategory(ids);
    await openDeskShift(0);
    const make = async (label, lines, reason) => {
      const { bill } = await finalBill(ids, label, lines, { pay: inCash });
      const request = await askRefund(
        bill.id,
        lines.length > 1 ? [{ line_id: lineFor(bill, ids.dressing).id, quantity: 1 }] : "whole",
        reason,
      );
      return { bill, request };
    };
    ids.mode = await make("InboxMode", [{ item: ids.dressing, quantity: 2 }, { item: ids.brace }], {
      reason_code: "long_wait",
      reason: "Waited three hours",
    });
    ids.reject = await make("InboxReject", [{ item: ids.brace }], {
      reason_code: "billed_by_mistake",
      reason: "",
    });
    ids.phone = await make("InboxPhone", [{ item: ids.brace }], {
      reason_code: "doctor_cancelled",
      reason: "",
    });
    await dropShifts();
  });

  test.afterAll(async () => {
    await tearDown(ids);
    await dropShifts();
  });

  test("1. a refund is listed with its patient, bill, lines, amounts, reason and mode, and counts in the badge", async ({
    page,
  }) => {
    await openInbox(page);
    const row = waitingRow(page, ids.mode.bill.bill_no);
    await expect(row).toContainText(`P4 InboxMode ${tag}`);
    await expect(row).toContainText("Refund");
    await expect(row).toContainText(`Dressing ${tag} × 1 — ₹500`);
    await expect(row).toContainText("₹500 goes back — ₹500 by cash");
    await expect(row).toContainText("Long waiting time — Waited three hours");
    await expect(row).toContainText("Asked for: Back the way it was paid");
    await expect(waitingRow(page, ids.reject.bill.bill_no)).toContainText(
      "Billed by mistake / duplicate",
    );
    const waiting = (await waitingTable(page).getByRole("row").count()) - 1;
    await expect(page.getByRole("link", { name: /Desk requests/ })).toContainText(String(waiting));
  });

  test("2. approving with another mode needs the admin's reason, then shows the credit note", async ({
    page,
  }) => {
    await openInbox(page);
    await waitingRow(page, ids.mode.bill.bill_no)
      .getByRole("button", { name: `Approve refund on bill ${ids.mode.bill.bill_no}` })
      .click();
    await expect(dialog(page)).toContainText(`Approve refund on bill ${ids.mode.bill.bill_no}?`);
    await expect(dialog(page)).toContainText("₹500 goes back to the patient.");
    const approve = dialog(page).getByRole("button", { name: "Approve refund" });
    await dialog(page).getByLabel("Money goes back as").selectOption("upi");
    await expect(approve).toBeDisabled();
    await dialog(page).getByLabel("Why another way than the desk asked").fill("Cash drawer empty");
    await expect(approve).toBeEnabled();
    await approve.click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(waitingRow(page, ids.mode.bill.bill_no)).toHaveCount(0);
    const stored = await requestRow(ids.mode.request.id);
    expect(stored).toMatchObject({
      status: "approved",
      approved_mode: "upi",
      mode_reason: "Cash drawer empty",
    });
    const note = await one(`SELECT bill_no FROM bills WHERE id = $1`, [stored.credit_note_id]);
    const decided = page.getByRole("table", { name: "Decided requests" });
    await expect(decided).toContainText(`Credit note ${note.bill_no} · credited ₹500`);
    await expect(decided).toContainText("UPI — Cash drawer empty");
  });

  test("3. rejecting a refund needs a note", async ({ page }) => {
    await openInbox(page);
    await waitingRow(page, ids.reject.bill.bill_no)
      .getByRole("button", { name: `Reject request for refund on bill ${ids.reject.bill.bill_no}` })
      .click();
    await dialog(page).getByRole("button", { name: "Reject request" }).click();
    await expect(dialog(page)).toContainText("Note");
    await expect(dialog(page).getByRole("alert")).toBeVisible();
    expect((await requestRow(ids.reject.request.id)).status).toBe("pending");
    await dialog(page).getByLabel("Note", { exact: true }).fill("Bill is correct");
    await dialog(page).getByRole("button", { name: "Reject request" }).click();
    await expect(dialog(page)).toHaveCount(0);
    expect(await requestRow(ids.reject.request.id)).toMatchObject({
      status: "rejected",
      decision_note: "Bill is correct",
    });
  });

  test("4. at phone width the refund row and the approve dialog fit, and approving as asked needs no reason", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openInbox(page, "admin");
    const row = waitingRow(page, ids.phone.bill.bill_no);
    await expect(row).toContainText("Doctor cancelled the test");
    await row
      .getByRole("button", { name: `Approve refund on bill ${ids.phone.bill.bill_no}` })
      .click();
    const approve = dialog(page).getByRole("button", { name: "Approve refund" });
    await expect(approve).toBeEnabled();
    await expect(approve).toBeInViewport();
    await approve.click();
    await expect(dialog(page)).toHaveCount(0);
    expect(await requestRow(ids.phone.request.id)).toMatchObject({
      status: "approved",
      approved_mode: "as_paid",
      mode_reason: null,
    });
    const sideways = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(sideways).toBeLessThanOrEqual(1);
  });

  test("5. reception can't open the inbox", async ({ page }) => {
    await loginAs(page, "reception");
    await page.goto(INBOX);
    await expect(page.getByRole("heading", { name: "Waiting for an answer" })).toHaveCount(0);
  });
});
