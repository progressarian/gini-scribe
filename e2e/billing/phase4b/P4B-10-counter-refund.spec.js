import { test, expect } from "@playwright/test";
import { one } from "../../helpers/db.mjs";
import { loginAs } from "../../helpers/auth.mjs";
import { closePdfViewer, expectPdfInViewer } from "../../helpers/pdfViewer.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { newTag, setUp, tearDown } from "../phase4/p4-bills-fixture.mjs";
import {
  admin,
  db,
  dropShifts,
  finalBill,
  inCash,
  lineFor,
  openDeskShift,
  prepareCategory,
} from "./p4b-refunds.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const requests = await import("../../../server/services/billing/billingRequests.js");

const tag = newTag();
const RECEPTION = "/giniflow/station/reception";
let ids;

const actions = (page) => page.getByRole("region", { name: "Bill actions" });
const refunds = (page) => page.getByRole("region", { name: "Refunds" });
const dialog = (page) => page.getByRole("dialog");
const pad = (page) => page.getByRole("region", { name: "Totals and payment" });

async function openBill(page, bill) {
  await gotoReady(page, `${RECEPTION}?tab=bill&visit=${bill.visit_id}&bill=${bill.id}`, () =>
    actions(page),
  );
}

const pendingOf = (billId) =>
  one(
    `SELECT id, reason, reason_code, refund_lines FROM billing_requests
      WHERE bill_id = $1 AND kind = 'refund' AND status = 'pending'`,
    [billId],
  );

const paidBill = (label, lines) => finalBill(ids, label, lines, { pay: inCash });

test.describe.serial("P4B-10 counter: Refund… and pay out", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    await prepareCategory(ids);
    await openDeskShift(0);
    ids.whole = (await paidBill("UiWhole", [{ item: ids.brace }, { item: ids.dressing }])).bill;
    ids.part = (
      await paidBill("UiPart", [{ item: ids.dressing, quantity: 2 }, { item: ids.brace }])
    ).bill;
    ids.card = (await paidBill("UiCard", [{ item: ids.brace }])).bill;
    ids.cash = (await paidBill("UiCash", [{ item: ids.brace }])).bill;
    ids.rejected = (await paidBill("UiReject", [{ item: ids.brace }])).bill;
    ids.phone = (await paidBill("UiPhone", [{ item: ids.brace }])).bill;
    ids.later = (
      await finalBill(ids, "UiLater", [{ item: ids.brace }, { item: ids.dressing }], {
        pay: [{ mode: "cash", amount: 300 }],
        payLater: true,
      })
    ).bill;
    await dropShifts();
  });

  test.afterAll(async () => {
    await tearDown(ids);
    await dropShifts();
  });

  test("1. a paid final bill offers Refund… not Cancel; the whole bill goes back the way it came; Other needs a note", async ({
    page,
  }) => {
    await loginAs(page, "reception");
    await openBill(page, ids.whole);
    await expect(actions(page).getByRole("button", { name: "Cancel unpaid bill" })).toHaveCount(0);
    await actions(page).getByRole("button", { name: "Refund…" }).click();
    await expect(dialog(page)).toContainText(`Refund on bill ${ids.whole.bill_no}`);
    const send = dialog(page).getByRole("button", { name: "Send request" });
    await expect(send).toBeDisabled();
    await expect(dialog(page).getByLabel("What the patient gets back")).toContainText(
      "Patient gets back ₹1,300 — ₹1,300 by cash",
    );
    await dialog(page)
      .getByRole("combobox", { name: /^Reason/ })
      .selectOption("other");
    await expect(send).toBeDisabled();
    await dialog(page).getByLabel("Reason in your words").fill("Moved to another city");
    await expect(send).toBeEnabled();
    await send.click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(refunds(page)).toContainText("Refund requested — waiting for admin.");
    await expect(refunds(page)).toContainText("Moved to another city");
    await expect(actions(page).getByRole("button", { name: "Refund…" })).toHaveCount(0);
    const pending = await pendingOf(ids.whole.id);
    expect(pending).toMatchObject({ reason_code: "other", reason: "Moved to another city" });
    expect(pending.refund_lines).toHaveLength(2);
  });

  test("2. chosen lines with part of a quantity preview their own amount and send that", async ({
    page,
  }) => {
    await loginAs(page, "reception");
    await openBill(page, ids.part);
    await actions(page).getByRole("button", { name: "Refund…" }).click();
    await dialog(page).getByLabel("Chosen lines").check();
    await dialog(page)
      .getByRole("checkbox", { name: new RegExp(`Dressing ${tag}`) })
      .check();
    const quantity = dialog(page).getByLabel("Quantity (up to 2)");
    await expect(quantity).toHaveValue("2");
    await quantity.fill("3");
    await expect(dialog(page)).toContainText("A quantity is more than is left to refund.");
    await quantity.fill("1");
    await expect(dialog(page).getByLabel("What the patient gets back")).toContainText(
      "Patient gets back ₹500 — ₹500 by cash",
    );
    await dialog(page)
      .getByRole("combobox", { name: /^Reason/ })
      .selectOption("doctor_cancelled");
    await dialog(page).getByRole("button", { name: "Send request" }).click();
    await expect(refunds(page)).toContainText("Doctor cancelled the test");
    const pending = await pendingOf(ids.part.id);
    expect(pending.refund_lines).toEqual([
      { line_id: lineFor(ids.part, ids.dressing).id, quantity: 1 },
    ]);
  });

  test("3. once approved by card, the bill shows its credit note and pays out only with the reversal reference", async ({
    page,
  }) => {
    const asked = await requests.createRefundRequest(
      { bill_id: ids.card.id, whole_bill: true, reason_code: "long_wait" },
      { actorId: 9003, role: "reception" },
      db,
    );
    const approved = await requests.approveRequest(
      asked.id,
      { approved_mode: "card", mode_reason: "Patient wants it on the card" },
      admin,
      db,
    );
    const cn = approved.credit_note.bill_no;
    await loginAs(page, "reception");
    await openBill(page, ids.card);
    await expect(refunds(page)).toContainText(`Credit note ${cn}`);
    await expect(refunds(page)).toContainText("Approved: Card — Patient wants it on the card");
    const payOut = refunds(page).getByRole("group", { name: `Pay out on ${cn}` });
    await expect(payOut.getByLabel("Amount to pay back")).toHaveValue("800");
    const go = payOut.getByRole("button", { name: "Pay out ₹800" });
    await expect(go).toBeDisabled();
    await payOut.getByLabel("Reference").fill(`REV-${tag}`);
    await expect(go).toBeEnabled();
    await go.click();
    await expect(refunds(page)).toContainText(`Paid back ₹800 on ${cn}.`);
    await expect(refunds(page)).toContainText("refunded ₹800");
    await expect(payOut).toHaveCount(0);
    await refunds(page).getByRole("button", { name: "Print refund receipt" }).click();
    expect(await expectPdfInViewer(page, "/refund-receipt.pdf?token=")).toMatch(
      /\/credit-notes\/.+\/refund-receipt\.pdf\?token=/,
    );
    await closePdfViewer(page);
    await refunds(page).getByRole("button", { name: "Print credit note" }).click();
    await expectPdfInViewer(page, "/credit-note.pdf?token=");
    await closePdfViewer(page);
    await expect(pad(page)).toContainText("Credited");
    const out = await one(
      `SELECT p.mode, p.amount, p.reference, p.direction FROM payments p
        WHERE p.bill_id = $1`,
      [approved.credit_note.id],
    );
    expect(out).toEqual({
      mode: "card",
      amount: "800.00",
      reference: `REV-${tag}`,
      direction: "out",
    });
  });

  test("4. cash goes back only from an open shift, the same as taking a payment", async ({
    page,
  }) => {
    const asked = await requests.createRefundRequest(
      { bill_id: ids.cash.id, whole_bill: true, reason_code: "patient_declined" },
      { actorId: 9003, role: "reception" },
      db,
    );
    const approved = await requests.approveRequest(asked.id, {}, admin, db);
    const cn = approved.credit_note.bill_no;
    await dropShifts();
    await loginAs(page, "reception");
    await openBill(page, ids.cash);
    const payOut = refunds(page).getByRole("group", { name: `Pay out on ${cn}` });
    await expect(payOut).toContainText("No shift is open, so cash can't be paid back yet");
    await payOut.getByRole("button", { name: "Pay out ₹800" }).click();
    await expect(payOut).toContainText("Open your shift first");
    try {
      await openDeskShift(1000);
      await payOut.getByRole("button", { name: "Pay out ₹800" }).click();
      await expect(refunds(page)).toContainText(`Paid back ₹800 on ${cn}.`);
    } finally {
      await dropShifts();
    }
  });

  test("5. a rejected refund shows the admin's note, and the desk may ask again", async ({
    page,
  }) => {
    const asked = await requests.createRefundRequest(
      { bill_id: ids.rejected.id, whole_bill: true, reason_code: "long_wait" },
      { actorId: 9003, role: "reception" },
      db,
    );
    await requests.rejectRequest(asked.id, { note: "The brace was already fitted" }, admin, db);
    await loginAs(page, "reception");
    await openBill(page, ids.rejected);
    await expect(refunds(page)).toContainText(
      "Refund rejected by E2E Admin: The brace was already fitted",
    );
    await expect(actions(page).getByRole("button", { name: "Refund…" })).toBeVisible();
  });

  test("6. on a pay-later bill the preview says the balance is reduced first, and Cancel stays for unpaid bills only", async ({
    page,
  }) => {
    await loginAs(page, "reception");
    await openBill(page, ids.later);
    await expect(actions(page).getByRole("button", { name: "Cancel unpaid bill" })).toHaveCount(0);
    await actions(page).getByRole("button", { name: "Refund…" }).click();
    const said = dialog(page).getByLabel("What the patient gets back");
    await expect(said).toContainText("Patient gets back ₹300 — ₹300 by cash");
    await expect(said).toContainText("₹1,000 reduces the balance still owed on this bill first.");
    await dialog(page).getByRole("button", { name: "Cancel" }).click();
    await expect(dialog(page)).toHaveCount(0);
  });

  test("7. at phone width the dialog and the pay-out fit the screen", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginAs(page, "reception");
    await openBill(page, ids.phone);
    await actions(page).getByRole("button", { name: "Refund…" }).click();
    await dialog(page)
      .getByRole("combobox", { name: /^Reason/ })
      .selectOption("station_unavailable");
    const send = dialog(page).getByRole("button", { name: "Send request" });
    await expect(send).toBeEnabled();
    await expect(send).toBeInViewport();
    await send.click();
    await expect(refunds(page)).toContainText("Refund requested — waiting for admin.");
    const pending = await pendingOf(ids.phone.id);
    await requests.approveRequest(
      pending.id,
      { approved_mode: "upi", mode_reason: "No cash" },
      admin,
      db,
    );
    await page.reload();
    const payOut = refunds(page).getByRole("group", { name: /^Pay out on / });
    await payOut.getByLabel("Reference").fill(`UPI-${tag}`);
    await payOut.getByRole("button", { name: "Pay out ₹800" }).click();
    await expect(refunds(page)).toContainText("Paid back ₹800");
    const sideways = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(sideways).toBeLessThanOrEqual(1);
  });
});
