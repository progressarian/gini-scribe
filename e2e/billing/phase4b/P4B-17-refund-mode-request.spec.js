import { test, expect } from "@playwright/test";
import { one } from "../../helpers/db.mjs";
import { loginAs } from "../../helpers/auth.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { desk, newTag, refused, setUp, tearDown } from "../phase4/p4-bills-fixture.mjs";
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
const creditNotes = await import("../../../server/services/billing/creditNotes.js");
const requests = await import("../../../server/services/billing/billingRequests.js");
const payments = await import("../../../server/services/billing/payments.js");

const tag = newTag();
const RECEPTION = "/giniflow/station/reception";
const INBOX = "/settings/desk-requests";
let ids;

const actions = (page) => page.getByRole("region", { name: "Bill actions" });
const dialog = (page) => page.getByRole("dialog");
const preview = (page) => dialog(page).getByLabel("What the patient gets back");
const waitingRow = (page, billNo) =>
  page
    .getByRole("table", { name: "Requests waiting" })
    .getByRole("row")
    .filter({ hasText: `Bill ${billNo}` });

const requestOf = (billId) =>
  one(
    `SELECT id, status, requested_mode, approved_mode, mode_reason FROM billing_requests
      WHERE bill_id = $1 AND kind = 'refund' ORDER BY requested_at DESC LIMIT 1`,
    [billId],
  );

test.describe.serial("P4B-17 reception asks for a refund mode", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    await prepareCategory(ids);
    await openDeskShift(0);
    ids.card = (await finalBill(ids, "ModeCard", [{ item: ids.brace }], { pay: inCash })).bill;
    ids.upi = (await finalBill(ids, "ModeUpi", [{ item: ids.brace }], { pay: inCash })).bill;
    ids.svc = (await finalBill(ids, "ModeSvc", [{ item: ids.brace }], { pay: inCash })).bill;
  });

  test.afterAll(async () => {
    await tearDown(ids);
    await dropShifts();
  });

  test("1. Refund by defaults to As paid; choosing Card changes the preview and is sent", async ({
    page,
  }) => {
    await loginAs(page, "reception");
    await gotoReady(
      page,
      `${RECEPTION}?tab=bill&visit=${ids.card.visit_id}&bill=${ids.card.id}`,
      () => actions(page),
    );
    await actions(page).getByRole("button", { name: "Refund…" }).click();
    const by = dialog(page).getByLabel("Refund by");
    await expect(by).toHaveValue("as_paid");
    await expect(by.locator("option")).toHaveText(["As paid", "Cash", "Card", "UPI"]);
    await expect(preview(page)).toContainText("Patient gets back ₹800 — ₹800 by cash");
    await by.selectOption("card");
    await expect(preview(page)).toContainText("Patient gets back ₹800 — ₹800 by card");
    await dialog(page)
      .getByRole("combobox", { name: /^Reason/ })
      .selectOption("long_wait");
    await dialog(page).getByRole("button", { name: "Send request" }).click();
    await expect(dialog(page)).toHaveCount(0);
    expect(await requestOf(ids.card.id)).toMatchObject({
      status: "pending",
      requested_mode: "card",
    });
  });

  test("2. the inbox shows the asked mode and approving as asked needs no reason", async ({
    page,
  }) => {
    await loginAs(page, "reception_admin");
    await gotoReady(page, INBOX, () =>
      page.getByRole("heading", { name: "Waiting for an answer" }),
    );
    const row = waitingRow(page, ids.card.bill_no);
    await expect(row).toContainText("Asked for: Card");
    await expect(row).toContainText("₹800 goes back — ₹800 by card");
    await row.getByRole("button", { name: `Approve refund on bill ${ids.card.bill_no}` }).click();
    const mode = dialog(page).getByLabel("Money goes back as");
    await expect(mode).toHaveValue("card");
    const approve = dialog(page).getByRole("button", { name: "Approve refund" });
    await expect(approve).toBeEnabled();
    await approve.click();
    await expect(dialog(page)).toHaveCount(0);
    expect(await requestOf(ids.card.id)).toMatchObject({
      status: "approved",
      approved_mode: "card",
      mode_reason: null,
    });
  });

  test("3. the admin can still change the asked mode, with a reason", async ({ page }) => {
    await askRefund(ids.upi.id, "whole", { reason_code: "long_wait", requested_mode: "upi" });
    await loginAs(page, "admin");
    await gotoReady(page, INBOX, () =>
      page.getByRole("heading", { name: "Waiting for an answer" }),
    );
    const row = waitingRow(page, ids.upi.bill_no);
    await expect(row).toContainText("Asked for: UPI");
    await row.getByRole("button", { name: `Approve refund on bill ${ids.upi.bill_no}` }).click();
    await dialog(page).getByLabel("Money goes back as").selectOption("cash");
    const approve = dialog(page).getByRole("button", { name: "Approve refund" });
    await expect(approve).toBeDisabled();
    await dialog(page)
      .getByLabel("Why another way than the desk asked")
      .fill("UPI server is down today");
    await approve.click();
    await expect(dialog(page)).toHaveCount(0);
    expect(await requestOf(ids.upi.id)).toMatchObject({
      status: "approved",
      approved_mode: "cash",
      mode_reason: "UPI server is down today",
    });
  });

  test("4. the service: preview and request carry the asked mode; pay-out follows the approved one", async () => {
    const asked = await creditNotes.previewCredit(
      ids.svc.id,
      { whole_bill: true, mode: "upi" },
      db,
    );
    expect(asked.refund).toMatchObject({ mode: "upi", due: 80000 });
    expect(asked.refund.legs).toEqual([{ mode: "upi", amount: 80000 }]);
    await refused(
      creditNotes.previewCredit(ids.svc.id, { whole_bill: true, mode: "cheque" }, db),
      400,
      /Money can go back only as one of/,
      "an unknown mode",
    );
    await refused(
      askRefund(ids.svc.id, "whole", { requested_mode: "cheque" }),
      400,
      /Money can go back only as one of/,
      "asking an unknown mode",
    );
    const request = await askRefund(ids.svc.id, "whole", { requested_mode: "upi" });
    expect(request.refund.requested_mode).toBe("upi");
    const [listed] = await requests.listRequests({ billId: ids.svc.id, status: "pending" }, db);
    expect(listed.refund.preview.refund).toMatchObject({ mode: "upi", due: 80000 });
    const approved = await requests.approveRequest(request.id, {}, admin, db);
    expect(approved.refund.approved_mode).toBe("upi");
    const note = approved.credit_note;
    await refused(
      payments.payOut(
        note.id,
        { version: note.version, payments: [{ mode: "cash", amount: 800 }] },
        desk,
        db,
      ),
      409,
      /approved paying this back by UPI/,
      "cash when UPI was approved",
    );
    await payments.payOut(
      note.id,
      {
        version: note.version,
        payments: [{ mode: "upi", amount: 800, reference: `UPI-${tag}` }],
      },
      desk,
      db,
    );
    const paid = await one(`SELECT paid_amount FROM bills WHERE id = $1`, [note.id]);
    expect(Number(paid.paid_amount)).toBe(800);
  });
});
