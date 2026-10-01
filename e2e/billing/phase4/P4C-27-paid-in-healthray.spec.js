import { test, expect } from "@playwright/test";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { one, query } from "../../helpers/db.mjs";
import { apiAs, loginAs } from "../../helpers/auth.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { expectPdfInViewer } from "../../helpers/pdfViewer.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import {
  autoConsultation,
  desk,
  extraVisit,
  newTag,
  refused,
  setUp,
  tearDown,
} from "./p4-bills-fixture.mjs";
import {
  db,
  draftWith,
  dropShifts,
  finalBill,
  openDeskShift,
  prepareCategory,
  refundApproved,
} from "../phase4b/p4b-refunds.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");
const payments = await import("../../../server/services/billing/payments.js");
const shifts = await import("../../../server/services/billing/cashShifts.js");
const counter = await import("../../../server/services/billing/counterPatients.js");
const reception = await import("../../../server/services/giniflow/receptionStation.js");
const reports = await import("../../../server/services/billing/reports.js");
const receiptPdf = await import("../../../server/services/billing/receiptPdf.js");

const tag = newTag();
const RECEPTION = "/giniflow/station/reception";
const nameOf = (label) => `P4 ${label} ${tag}`;
const fileOf = (label) => `F4${label}-${tag}`;
let ids;
let autoBefore;
const main = {};

const pad = (page) => page.getByRole("region", { name: "Totals and payment" });
const actions = (page) => page.getByRole("region", { name: "Bill actions" });
const refunds = (page) => page.getByRole("region", { name: "Refunds" });
const dialog = (page) => page.getByRole("dialog");
const clearButton = (page) => pad(page).getByRole("button", { name: "Paid in HealthRay" });

const openBillTab = (page, visitId) =>
  gotoReady(page, `${RECEPTION}?tab=bill&visit=${visitId}`, () => pad(page));

const clear = async (billId) => {
  const bill = await bills.readBill(billId, db);
  return payments.clearInHealthray(billId, { version: bill.version }, desk, db);
};

const paymentsOf = (billId) =>
  query(
    `SELECT direction, mode, amount::float AS amount, reference, shift_id, receipt_no
       FROM payments WHERE bill_id = $1 ORDER BY received_at`,
    [billId],
  ).then((r) => r.rows);

const orderRow = (id) =>
  one(
    `SELECT payment_status, sample_status, amount_paid::float FROM giniflow_lab_orders
        WHERE id = $1`,
    [id],
  );

const groupOf = async (label) => {
  const listed = await counter.counterPatients(ids.day, nameOf(label), new Date(), db);
  for (const group of ["toBill", "billed", "waiting"]) {
    const row = listed[group].find((r) => r.name === nameOf(label));
    if (row) return { group, row };
  }
  return { group: null, row: null };
};

async function pdfText(page, href) {
  const response = await page.request.get(href);
  expect(response.status()).toBe(200);
  const document = await getDocument({ data: new Uint8Array(await response.body()) }).promise;
  const pages = [];
  for (let at = 1; at <= document.numPages; at += 1) {
    const content = await (await document.getPage(at)).getTextContent();
    pages.push(content.items.map((item) => item.str).join(" "));
  }
  return pages.join("\n").replace(/\s+/g, " ");
}

test.describe.serial("P4C-27 Paid in HealthRay clears the bill in one click", () => {
  test.describe.configure({ retries: 1 });

  test.beforeAll(async () => {
    ids = await setUp(tag);
    await prepareCategory(ids);
    autoBefore = await autoConsultation(false);
    await dropShifts();
    const made = await extraVisit(ids, "C26Main");
    main.visit = made.visit;
    main.order = (
      await one(
        `INSERT INTO giniflow_lab_orders (visit_id, urgency, payment_status, amount_total,
                                          sample_status, kind)
         VALUES ($1, 'today', 'pending', 650, 'payment_pending', 'lab') RETURNING id`,
        [main.visit],
      )
    ).id;
    for (const [name, price] of [
      [ids.hba1cName, 250],
      [ids.abiName, 400],
    ]) {
      await query(
        `INSERT INTO giniflow_lab_order_tests (lab_order_id, test_name, price) VALUES ($1, $2, $3)`,
        [main.order, name, price],
      );
    }
    const draft = await bills.openDraft(main.visit, desk, db);
    main.bill = draft.id;
    for (const item of [ids.consultNew, ids.hba1c, ids.abi]) {
      await bills.addLine(main.bill, { item_id: item }, desk, db);
    }
    await bills.setCategory(main.bill, { category: ids.pensioner }, desk, db);
  });

  test.afterAll(async () => {
    try {
      await tearDown(ids);
    } finally {
      await dropShifts();
      if (autoBefore !== undefined) await autoConsultation(autoBefore);
    }
  });

  test("1. the draft offers Paid in HealthRay; the dialog names the patient, the draft and the amount, and marking it clears the payment card", async ({
    page,
  }) => {
    const before = await bills.readBill(main.bill, db);
    expect(before.totals.payable).toBe(215000);
    expect((await groupOf("C26Main")).group).toBe("toBill");
    expect(
      (await reception.getPaymentQueue(ids.day, db)).pending.some((o) => o.orderId === main.order),
    ).toBe(true);

    await loginAs(page, "reception");
    await openBillTab(page, main.visit);
    await expect(pad(page).getByRole("button", { name: /^Take payment/ })).toBeVisible();
    await clearButton(page).click();
    const box = dialog(page);
    await expect(box).toContainText("Mark as paid in HealthRay?");
    await expect(box).toContainText(nameOf("C26Main"));
    await expect(box).toContainText(fileOf("C26Main"));
    await expect(box).toContainText("Draft");
    await expect(box).toContainText("₹2,150");
    await expect(box).toContainText(
      "This clears the bill in Scribe. No money is taken here and it is not added to the cash drawer.",
    );
    await box.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog(page)).toHaveCount(0);
    expect(await paymentsOf(main.bill)).toEqual([]);

    await clearButton(page).click();
    await dialog(page).getByRole("button", { name: "Mark ₹2,150 paid" }).click();
    await expect(dialog(page)).toHaveCount(0);
    const done = pad(page).getByRole("button", { name: "✓ Paid in HealthRay — ₹2,150" });
    await expect(done).toBeVisible();
    await expect(done).toBeDisabled();
    await expect(pad(page).getByRole("button", { name: /^Take payment/ })).toHaveCount(0);
    await expect(pad(page).getByLabel("Amount Received")).toHaveCount(0);
    await expect(actions(page).getByRole("button", { name: "Finalise & print" })).toBeEnabled();

    await page.reload();
    await expect(
      pad(page).getByRole("button", { name: "✓ Paid in HealthRay — ₹2,150" }),
    ).toBeDisabled();
  });

  test("2. one HealthRay payment covers the draft with no shift; its orders are paid and the patient is billed", async () => {
    const rows = await paymentsOf(main.bill);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      direction: "in",
      mode: "healthray",
      amount: 2150,
      reference: null,
      shift_id: null,
    });
    expect(rows[0].receipt_no).toBeTruthy();
    const bill = await bills.readBill(main.bill, db);
    expect(bill.status).toBe("draft");
    expect(bill.totals.paid).toBe(215000);
    expect(await orderRow(main.order)).toMatchObject({ payment_status: "paid", amount_paid: 650 });
    expect(
      (await reception.getPaymentQueue(ids.day, db)).pending.some((o) => o.orderId === main.order),
    ).toBe(false);
    const { group, row } = await groupOf("C26Main");
    expect(group).toBe("billed");
    expect(row.bill.state).toBe("paid");
    expect(row.hints).toMatchObject({ tests: 0, due: 0 });
    const audit = await one(
      `SELECT COUNT(*)::int AS n FROM billing_audit
        WHERE entity = 'payments' AND action = 'create' AND after ->> 'mode' = 'healthray'
          AND after ->> 'bill_id' = $1`,
      [main.bill],
    );
    expect(audit.n).toBe(1);
  });

  test("3. Finalise & print still works; the bill and the receipt say Paid in HealthRay", async ({
    page,
  }) => {
    await loginAs(page, "reception");
    await openBillTab(page, main.visit);
    await actions(page).getByRole("button", { name: "Finalise & print" }).click();
    await expect.poll(async () => (await bills.readBill(main.bill, db)).status).toBe("final");
    const final = await bills.readBill(main.bill, db);
    const href = await expectPdfInViewer(
      page,
      `/api/billing/bills/${main.bill}/bill.pdf`,
      `Bill ${final.bill_no}`,
    );
    const text = await pdfText(page, href);
    expect(text).toContain(final.bill_no);
    expect(text).toMatch(/PAID IN HEALTHRAY \( ₹ \) 2,150\.00/i);
    const receipt = receiptPdf.buildReceiptsHtml(
      await receiptPdf.receiptViews(main.bill, null, db),
    );
    expect(receipt).toContain("Paid in HealthRay");
    expect((await groupOf("C26Main")).group).toBe("billed");
  });

  test("4. no shift is needed, and an open shift's drawer and totals do not change", async () => {
    await dropShifts();
    const noShift = await draftWith(ids, "C26NoShift", [{ item: ids.dressing }]);
    const cleared = await clear(noShift.bill.id);
    expect(cleared.totals.outstanding).toBe(0);
    expect(cleared.payments[0]).toMatchObject({ mode: "healthray", shift_id: null });

    const shift = await openDeskShift(500);
    const inShift = await draftWith(ids, "C26InShift", [{ item: ids.brace }]);
    await clear(inShift.bill.id);
    const now = await shifts.currentShift(desk, db);
    expect(now.id).toBe(shift.id);
    expect(now.collected).toEqual({ cash: 0, card: 0, upi: 0, total: 0 });
    expect(now.payment_count).toBe(0);
    expect(now.bill_count).toBe(0);
    expect(now.expected_cash).toBe(500);
    expect(now.healthray.collected).toBe(800);
    const closed = await shifts.closeCurrentShift({ counted_cash: 500 }, desk, db);
    expect(closed.difference).toBe(0);
    await dropShifts();
  });

  test("5. a final pay-later bill with a balance is cleared and leaves the dues", async () => {
    const later = (await finalBill(ids, "C26Later", [{ item: ids.brace }], { payLater: true }))
      .bill;
    const duesBefore = await payments.listDues({ patientId: later.patient_id }, db);
    expect(duesBefore.map((due) => due.bill_id)).toContain(later.id);

    const api = await apiAs("reception");
    const response = await api.post(`/api/billing/bills/${later.id}/clear-healthray`, {
      data: { version: later.version },
    });
    const body = await response.json();
    await api.dispose();
    expect(response.status(), JSON.stringify(body)).toBe(201);
    expect(body).toMatchObject({ status: "final", totals: { outstanding: 0 } });
    expect(body.payments).toHaveLength(1);
    expect(body.payments[0]).toMatchObject({ mode: "healthray", amount: 80000 });
    const duesAfter = await payments.listDues({ patientId: later.patient_id }, db);
    expect(duesAfter.map((due) => due.bill_id)).not.toContain(later.id);
    expect((await groupOf("C26Later")).row.bill.state).toBe("paid");
  });

  test("6. refused on nothing due, a stale version and a cancelled bill", async () => {
    const final = await bills.readBill(main.bill, db);
    await refused(
      payments.clearInHealthray(main.bill, { version: final.version }, desk, db),
      409,
      /Nothing is left to collect/,
      "nothing due",
    );

    const stale = await draftWith(ids, "C26Stale", [{ item: ids.dressing }]);
    await refused(
      payments.clearInHealthray(stale.bill.id, { version: stale.bill.version - 1 }, desk, db),
      409,
      /changed while you were working on it/,
      "stale version",
    );
    expect(await paymentsOf(stale.bill.id)).toEqual([]);

    const gone = (await finalBill(ids, "C26Gone", [{ item: ids.brace }], { payLater: true })).bill;
    const cancelled = await bills.cancelBill(
      gone.id,
      { version: gone.version, reason: "Wrong patient" },
      desk,
      db,
    );
    expect(cancelled.status).toBe("cancelled");
    await refused(
      payments.clearInHealthray(gone.id, { version: cancelled.version }, desk, db),
      409,
      /cancelled/,
      "cancelled bill",
    );

    const api = await apiAs("reception");
    const missing = await api.post(`/api/billing/bills/${stale.bill.id}/clear-healthray`, {
      data: {},
    });
    expect(missing.status()).toBe(400);
    await api.dispose();
  });

  test("7. the collections report shows Paid in HealthRay as its own mode", async () => {
    const result = await reports.runReport("collections", {
      from: ids.day,
      to: ids.day,
      sub_category: ids.pensioner,
    });
    const modes = result.sections.find((part) => part.key === "modes");
    const row = modes.rows.find((r) => r.label === "Paid in HealthRay");
    const { total } = await one(
      `SELECT COALESCE(SUM(p.amount), 0)::float AS total
         FROM payments p JOIN bills b ON b.id = p.bill_id
        WHERE p.mode = 'healthray' AND p.direction = 'in' AND b.scheme_code = $1`,
      [ids.pensioner],
    );
    expect(total).toBe(2150 + 500 + 800 + 800);
    expect(row).toMatchObject({ received: 425000, net: 425000 });
    expect(modes.rows.find((r) => r.label === "Cash")?.received ?? 0).toBe(0);
  });

  test("8. a refund on a HealthRay-paid bill goes back as refunded in HealthRay, with no shift", async ({
    page,
  }) => {
    await dropShifts();
    const paid = await draftWith(ids, "C26Refund", [{ item: ids.brace }]);
    const cleared = await clear(paid.bill.id);
    const final = await bills.finaliseBill(paid.bill.id, { version: cleared.version }, desk, db);
    const approved = await refundApproved(final.id, "whole");
    const note = approved.credit_note;
    expect(note.refund.legs).toEqual([{ mode: "healthray", amount: 80000 }]);

    await loginAs(page, "reception");
    await gotoReady(page, `${RECEPTION}?tab=bill&visit=${paid.visit}&bill=${final.id}`, () =>
      actions(page),
    );
    const payOut = refunds(page).getByRole("group", { name: `Pay out on ${note.bill_no}` });
    await expect(payOut).toContainText("₹800 in HealthRay");
    await expect(payOut).toContainText("Refunded in HealthRay");
    await expect(payOut.getByLabel("Reference")).toHaveCount(0);
    await expect(payOut).not.toContainText("No shift is open");
    await payOut.getByRole("button", { name: "Pay out ₹800" }).click();
    await expect(payOut).toHaveCount(0);
    const out = await paymentsOf(note.id);
    expect(out).toEqual([
      expect.objectContaining({ direction: "out", mode: "healthray", amount: 800, shift_id: null }),
    ]);
    const refundHtml = receiptPdf.buildReceiptsHtml(
      await receiptPdf.receiptViews(note.id, null, db),
    );
    expect(refundHtml).toContain("Refunded in HealthRay");
    const noteRow = await bills.readBill(note.id, db);
    await refused(
      payments.clearInHealthray(note.id, { version: noteRow.version }, desk, db),
      409,
      /never on a credit note/,
      "credit note",
    );

    const other = await draftWith(ids, "C26Override", [{ item: ids.dressing }]);
    const otherCleared = await clear(other.bill.id);
    const otherFinal = await bills.finaliseBill(
      other.bill.id,
      { version: otherCleared.version },
      desk,
      db,
    );
    const overridden = await refundApproved(otherFinal.id, "whole", {
      decide: { approved_mode: "cash", mode_reason: "Patient wants cash back" },
    });
    expect(overridden.credit_note.refund.legs).toEqual([{ mode: "cash", amount: 50000 }]);
  });

  test("9. only the billing desk can mark a bill paid in HealthRay", async () => {
    const draft = await draftWith(ids, "C26Role", [{ item: ids.dressing }]);
    const api = await apiAs("lab");
    const response = await api.post(`/api/billing/bills/${draft.bill.id}/clear-healthray`, {
      data: { version: draft.bill.version },
    });
    await api.dispose();
    expect(response.status()).toBe(403);
    expect(await paymentsOf(draft.bill.id)).toEqual([]);
  });

  test("10. at phone width the button and the dialog fit, and marking still works", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const phone = await draftWith(ids, "C26Phone", [{ item: ids.dressing }]);
    await loginAs(page, "reception");
    await openBillTab(page, phone.visit);
    await clearButton(page).scrollIntoViewIfNeeded();
    const button = await clearButton(page).boundingBox();
    expect(button.x).toBeGreaterThanOrEqual(0);
    expect(button.x + button.width).toBeLessThanOrEqual(390);
    await clearButton(page).click();
    const confirm = dialog(page).getByRole("button", { name: "Mark ₹500 paid" });
    await expect(confirm).toBeVisible();
    const box = await confirm.boundingBox();
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    await confirm.click();
    await expect(
      pad(page).getByRole("button", { name: "✓ Paid in HealthRay — ₹500" }),
    ).toBeDisabled();
  });
});
