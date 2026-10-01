import { test, expect } from "@playwright/test";
import { one, query } from "../../helpers/db.mjs";
import { anonymousApi, apiAs, loginAs, tokensFor } from "../../helpers/auth.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import {
  desk,
  extraVisit,
  failure,
  newTag,
  payRule,
  refused,
  setUp,
  subCategory,
  tearDown,
} from "../phase4/p4-bills-fixture.mjs";
import {
  admin,
  askRefund,
  auditActions,
  billRow,
  closeOpenShifts,
  db,
  draftWith,
  dropShifts,
  finalBill,
  inCash,
  lineFor,
  openDeskShift,
  payOn,
  prepareCategory,
  refundApproved,
} from "./p4b-refunds.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");
const payments = await import("../../../server/services/billing/payments.js");
const requests = await import("../../../server/services/billing/billingRequests.js");
const visitLines = await import("../../../server/services/billing/visitLines.js");
const testCancel = await import("../../../server/services/giniflow/testCancel.js");
const counter = await import("../../../server/services/billing/counterPatients.js");
const testCancelText = await import("../../../src/lib/testCancelText.js");

const tag = newTag();
const RECEPTION = "/giniflow/station/reception";
let ids;

const card = (amount, reference = `REV-${tag}-${amount}`) => ({ mode: "card", amount, reference });
const cash = (amount) => ({ mode: "cash", amount });

const payOut = (note, pay, version = note.version) =>
  payments.payOut(note.id, { version, payments: pay }, desk, db);

const outOn = async (noteId) =>
  Number(
    (
      await one(
        `SELECT COALESCE(SUM(amount), 0)::numeric AS out FROM payments
          WHERE bill_id = $1 AND direction = 'out'`,
        [noteId],
      )
    ).out,
  );

async function orderOn(visit, tests, kind) {
  const order = await one(
    `INSERT INTO giniflow_lab_orders (visit_id, urgency, payment_status, amount_total,
                                      sample_status, kind)
     VALUES ($1, 'today', 'pending', $2, 'payment_pending', $3) RETURNING id`,
    [visit, tests.reduce((sum, t) => sum + t.price, 0), kind],
  );
  for (const t of tests) {
    await query(
      `INSERT INTO giniflow_lab_order_tests (lab_order_id, test_name, price) VALUES ($1, $2, $3)`,
      [order.id, t.name, t.price],
    );
  }
  const raised = await visitLines.linesForOrder(
    visit,
    { labOrderId: order.id, testNames: tests.map((t) => t.name) },
    desk,
    db,
  );
  return { order: order.id, billId: raised.bill_id };
}

async function payAndFinalise(billId) {
  const ready = await bills.setCategory(billId, { category: ids.pensioner }, desk, db);
  const taken = await payments.takePayments(
    ready.id,
    { version: ready.version, payments: [cash(ready.totals.payable / 100)] },
    desk,
    db,
  );
  return bills.finaliseBill(ready.id, { version: taken.version }, desk, db);
}

const hba1c = () => ({ name: ids.hba1cName, price: 250 });
const abi = () => ({ name: ids.abiName, price: 400 });

const cancelAt = (orderId, reason, actor = USERS.lab) =>
  testCancel.cancelTest(
    {
      target: { orderId },
      reason,
      source: "station",
      actorId: actor.id,
      actorRole: actor.role,
    },
    db,
  );

async function cancelledWhileWaiting(label) {
  const { visit } = await extraVisit(ids, label);
  const lab = await orderOn(visit, [hba1c()], "lab");
  await bills.addLine(lab.billId, { item_id: ids.brace }, desk, db);
  const bill = await payAndFinalise(lab.billId);
  const asked = await askRefund(bill.id, [{ line_id: lineFor(bill, ids.brace).id }]);
  const result = await cancelAt(lab.order, "patient_declined");
  expect(result.refunds[0].status).toBe("waiting");
  return { bill, asked, line: lineFor(bill, ids.hba1c) };
}

async function call(role, method, url, data) {
  const api = role ? await apiAs(role) : await anonymousApi();
  const response = await api[method](url, data === undefined ? undefined : { data });
  const status = response.status();
  await api.dispose();
  return status;
}

test.describe.serial("P4B-18 refund hardening", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    await prepareCategory(ids);
    ids.claimed = await subCategory(ids, "Claimed", { allow_pay_later: true });
    await payRule(ids, ids.claimed, {
      name: "claimed pays a part",
      patient_pays: "amount",
      patient_value: 100,
    });
    await openDeskShift(5000);
  });

  test.afterAll(async () => {
    await tearDown(ids);
    await dropShifts();
  });

  test("1. a split-mode bill pays back each mode's share even when the desk pays the older mode first", async () => {
    const { bill: draft } = await draftWith(ids, "Split", [
      { item: ids.dressing },
      { item: ids.brace },
    ]);
    await payOn(draft.id, [card(800)]);
    const taken = await payOn(draft.id, [cash(500)]);
    const bill = await bills.finaliseBill(draft.id, { version: taken.version }, desk, db);
    const note = (await refundApproved(bill.id, "whole")).credit_note;
    expect(note.refund.legs).toEqual([
      { mode: "cash", amount: 50000 },
      { mode: "card", amount: 80000 },
    ]);
    const first = await payOut(note, [card(800)]);
    expect(first.totals).toMatchObject({ refunded: 80000, due: 50000 });
    const plan = await payments.refundPlan(note.id, db);
    expect(plan.legs).toEqual([{ mode: "cash", amount: 50000 }]);
    const done = await payOut(note, [cash(500)], first.version);
    expect(done.totals.due).toBe(0);
    expect(await outOn(note.id)).toBe(1300);
  });

  test("2. a CGHS bill: the refund reduces the pending claim and only the patient's part goes back; a cleared claim is refused at approval", async () => {
    const { bill: draft } = await draftWith(ids, "Cghs", [{ item: ids.brace }], {
      category: ids.claimed,
    });
    const taken = await payOn(draft.id, [cash(100)]);
    const bill = await bills.finaliseBill(draft.id, { version: taken.version }, desk, db);
    expect(bill.claim_status).toBe("pending");
    expect(bill.totals).toMatchObject({ payable: 10000, claim: 70000 });
    const note = (await refundApproved(bill.id, "whole")).credit_note;
    expect(note.totals).toMatchObject({ payable: 10000, claim: 70000 });
    expect(note.refund.due).toBe(10000);
    expect((await billRow(bill.id)).claim_status).toBe("none");
    await refused(payOut(note, [cash(101)]), 409, /₹100.00 is due back/, "the claim paid out");
    expect((await payOut(note, [cash(100)])).totals.due).toBe(0);

    const { bill: draft2 } = await draftWith(ids, "Cleared", [{ item: ids.brace }], {
      category: ids.claimed,
    });
    const taken2 = await payOn(draft2.id, [cash(100)]);
    const later = await bills.finaliseBill(draft2.id, { version: taken2.version }, desk, db);
    const asked = await askRefund(later.id, "whole");
    await query(
      `WITH s AS (
         INSERT INTO claim_settlements (payer_name, received_on, reference, amount)
         SELECT payer_name, bill_date, 'UTR-' || bill_no, claim_amount FROM bills WHERE id = $1
         RETURNING id)
       UPDATE bills SET claim_status = 'cleared', claim_settlement_id = (SELECT id FROM s)
        WHERE id = $1`,
      [later.id],
    );
    try {
      const error = await refused(
        requests.approveRequest(asked.id, {}, admin, db),
        409,
        /already been paid by .* went to the payer/,
        "approving after the claim was cleared",
      );
      expect(error.code).toBe("claim_cleared");
      expect(
        (await one(`SELECT status FROM billing_requests WHERE id = $1`, [asked.id])).status,
      ).toBe("pending");
    } finally {
      await requests.rejectRequest(asked.id, { note: "Claim already paid" }, admin, db);
      await query(
        `UPDATE bills SET claim_status = 'pending', claim_settlement_id = NULL WHERE id = $1`,
        [later.id],
      );
    }
  });

  test("3. part of a line, then the rest of it, then nothing is left", async () => {
    const { bill } = await finalBill(ids, "Parts", [{ item: ids.dressing, quantity: 3 }], {
      pay: inCash,
    });
    const line = lineFor(bill, ids.dressing);
    const one1 = (await refundApproved(bill.id, [{ line_id: line.id, quantity: 1 }])).credit_note;
    const rest = (await refundApproved(bill.id, [{ line_id: line.id }])).credit_note;
    expect(rest.lines[0].quantity).toBe(2);
    expect(one1.totals.payable + rest.totals.payable).toBe(bill.totals.payable);
    expect(Number(one1.bill_no.slice(ids.creditPrefix.length)) + 1).toBe(
      Number(rest.bill_no.slice(ids.creditPrefix.length)),
    );
    await refused(
      askRefund(bill.id, [{ line_id: line.id }]),
      409,
      /already been credited in full/,
      "a third refund",
    );
  });

  test("4. with no CN series for the year, approval says so in plain words and nothing changes", async () => {
    const { bill } = await finalBill(ids, "NoSeries", [{ item: ids.brace }], { pay: inCash });
    const asked = await askRefund(bill.id, "whole");
    const saved = await one(`SELECT * FROM bill_series WHERE series = 'CN' AND fy = $1`, [ids.fy]);
    await query(`DELETE FROM bill_series WHERE series = 'CN' AND fy = $1`, [ids.fy]);
    try {
      const error = await refused(
        requests.approveRequest(asked.id, {}, admin, db),
        409,
        new RegExp(
          `^The credit note number series \\(CN\\) for ${ids.fy} isn't set up yet — an admin adds it in Billing settings`,
        ),
        "no CN series",
      );
      expect(error).toMatchObject({ series: "CN", fy: ids.fy });
      expect(
        (await one(`SELECT status FROM billing_requests WHERE id = $1`, [asked.id])).status,
      ).toBe("pending");
    } finally {
      await query(
        `INSERT INTO bill_series (series, fy, prefix, number_width, next_no)
         VALUES ('CN', $1, $2, $3, $4)`,
        [ids.fy, saved.prefix, saved.number_width, saved.next_no],
      );
    }
    const approved = await requests.approveRequest(asked.id, {}, admin, db);
    expect(approved.credit_note.bill_no.startsWith(ids.creditPrefix)).toBe(true);
  });

  test("5. pay-out: a shift closed mid-way refuses cash, two clicks pay once, card needs its reference", async () => {
    const { bill } = await finalBill(ids, "Twice", [{ item: ids.brace }], { pay: inCash });
    const note = (await refundApproved(bill.id, "whole")).credit_note;
    await closeOpenShifts();
    await refused(payOut(note, [cash(800)]), 409, /Open your shift first/, "a closed shift");
    await openDeskShift(1000);
    const both = await Promise.all([
      failure(payOut(note, [cash(800)])),
      failure(payOut(note, [cash(800)])),
    ]);
    const errors = both.filter(Boolean);
    expect(errors).toHaveLength(1);
    expect(errors[0].status).toBe(409);
    expect(errors[0].message).toMatch(/changed while you were working on it|paid back in full/);
    expect(await outOn(note.id)).toBe(800);

    const { bill: byCard } = await finalBill(ids, "NoRef", [{ item: ids.brace }], {
      pay: () => [card(800)],
    });
    const cardNote = (await refundApproved(byCard.id, "whole")).credit_note;
    await refused(
      payOut(cardNote, [{ mode: "card", amount: 800 }]),
      400,
      /A card refund needs the reversal's reference number/,
      "no reference",
    );
  });

  test("6. after a full refund the bill is no longer owed on the dues list or the counter", async () => {
    const { bill: paid } = await finalBill(ids, "FullPaid", [{ item: ids.brace }], {
      pay: inCash,
    });
    const note = (await refundApproved(paid.id, "whole")).credit_note;
    await payOut(note, [cash(800)]);
    const { bill: later } = await finalBill(
      ids,
      "FullLater",
      [{ item: ids.brace }, { item: ids.dressing }],
      { pay: [cash(300)], payLater: true },
    );
    const laterNote = (await refundApproved(later.id, "whole")).credit_note;
    await payOut(laterNote, [cash(300)]);

    for (const bill of [paid, later]) {
      const dues = await payments.listDues({ patientId: bill.patient_id }, db);
      expect(dues.find((due) => due.id === bill.id)).toBeUndefined();
    }
    const listed = await counter.counterPatients(ids.day, tag, new Date(), db);
    const rows = [...listed.toBill, ...listed.billed, ...listed.waiting];
    for (const bill of [paid, later]) {
      const row = rows.find((r) => r.visitId === bill.visit_id);
      expect(row, bill.bill_no).toBeTruthy();
      expect(row.hints.due).toBe(0);
      expect(row.payBack).toBe(0);
      expect(row.bill.due).toBe(0);
    }
  });

  test("7. request, approval, rejection, credit note and pay-out each leave an audit row", async () => {
    const { bill } = await finalBill(ids, "Audit", [{ item: ids.brace }], { pay: inCash });
    const approved = await refundApproved(bill.id, "whole");
    expect(await auditActions("billing_requests", approved.id)).toEqual(["create", "approve"]);
    expect(await auditActions("bills", approved.credit_note.id)).toEqual(["create"]);
    expect(await auditActions("bills", bill.id)).toContain("update");
    const paid = await payOut(approved.credit_note, [cash(800)]);
    expect(await auditActions("payments", paid.payments[0].id)).toEqual(["create"]);

    const { bill: other } = await finalBill(ids, "AuditNo", [{ item: ids.brace }], { pay: inCash });
    const asked = await askRefund(other.id, "whole");
    await requests.rejectRequest(asked.id, { note: "Used" }, admin, db);
    expect(await auditActions("billing_requests", asked.id)).toEqual(["create", "reject"]);
  });

  test("8. a non-desk role is refused on every refund route; reception can't decide; the PDFs need a sign-in", async () => {
    const { bill } = await finalBill(ids, "Roles", [{ item: ids.brace }], { pay: inCash });
    const approved = await refundApproved(bill.id, "whole");
    const note = approved.credit_note;
    await payOut(note, [cash(800)]);
    const { bill: other } = await finalBill(ids, "Roles2", [{ item: ids.brace }], { pay: inCash });
    const asked = await askRefund(other.id, "whole");
    const routes = [
      ["get", `/api/billing/bills/${bill.id}/creditable`],
      ["get", `/api/billing/bills/${bill.id}/refunds`],
      ["post", "/api/billing/refunds/preview", { bill_id: other.id, whole_bill: true }],
      [
        "post",
        "/api/billing/requests/refund",
        { bill_id: other.id, whole_bill: true, reason_code: "long_wait" },
      ],
      ["get", `/api/billing/refund-requests/${asked.id}`],
      ["get", `/api/billing/credit-notes/${note.id}`],
      ["post", `/api/billing/credit-notes/${note.id}/pay-out`, { version: 1, ...cash(1) }],
      ["get", `/api/billing/credit-notes/${note.id}/credit-note.pdf`],
      ["get", `/api/billing/credit-notes/${note.id}/refund-receipt.pdf`],
      ["post", `/api/billing/master/requests/${asked.id}/approve`, {}],
      ["post", `/api/billing/master/requests/${asked.id}/reject`, { note: "no" }],
    ];
    for (const [method, url, data] of routes) {
      expect(await call("lab", method, url, data), `lab ${method} ${url}`).toBe(403);
      expect([401, 403], `anonymous ${method} ${url}`).toContain(
        await call(null, method, url, data),
      );
    }
    expect(await call("reception", "post", routes[9][1], {})).toBe(403);
    expect(await call("reception", "post", routes[10][1], { note: "no" })).toBe(403);
    expect(await call("reception", "get", routes[1][1])).toBe(200);

    const api = await anonymousApi();
    const { access } = await tokensFor("reception");
    for (const pdf of ["credit-note.pdf", "refund-receipt.pdf"]) {
      const url = `/api/billing/credit-notes/${note.id}/${pdf}`;
      expect([401, 403]).toContain((await api.get(url)).status());
      const ok = await api.get(`${url}?token=${encodeURIComponent(access)}`);
      expect(ok.status(), pdf).toBe(200);
      expect(ok.headers()["content-type"]).toContain("application/pdf");
    }
    await api.dispose();
    await requests.rejectRequest(asked.id, { note: "Done testing" }, admin, db);
  });

  test("9. a floor cancel while a refund waits: the bill lists the test as not refunded until a request covers it", async () => {
    const { bill, asked, line } = await cancelledWhileWaiting("Forgotten");
    const read = await bills.readBill(bill.id, db);
    expect(read.credits.cancelled_not_refunded).toEqual([
      {
        line_id: line.id,
        bill_name: line.bill_name,
        quantity: 1,
        patient_payable: 25000,
        reason_code: "patient_declined",
        note: `Cancelled at the lab station by ${USERS.lab.name}`,
      },
    ]);
    const listed = await bills.listVisitBills(bill.visit_id, db);
    expect(listed.find((b) => b.id === bill.id).credits.cancelled_not_refunded).toHaveLength(1);

    await requests.approveRequest(asked.id, {}, admin, db);
    expect((await bills.readBill(bill.id, db)).credits.cancelled_not_refunded).toHaveLength(1);
    await askRefund(bill.id, [{ line_id: line.id }]);
    expect((await bills.readBill(bill.id, db)).credits.cancelled_not_refunded).toEqual([]);
  });

  test("10. the counter shows the forgotten test and, once the waiting refund is answered, refunds it in one click", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const { bill, asked, line } = await cancelledWhileWaiting("Counter");
    await loginAs(page, "reception");
    const refunds = page.getByRole("region", { name: "Refunds" });
    const forgotten = refunds.getByLabel("Cancelled on the floor — not refunded yet");
    const openBill = () =>
      gotoReady(page, `${RECEPTION}?tab=bill&visit=${bill.visit_id}&bill=${bill.id}`, () =>
        forgotten.getByText("Cancelled on the floor — not refunded yet:"),
      );
    await openBill();
    await expect(forgotten).toContainText(
      `Cancelled on the floor — not refunded yet: ${line.bill_name} ₹250`,
    );
    await expect(forgotten).toContainText("Once the admin answers the waiting refund");
    await expect(forgotten.getByRole("button")).toHaveCount(0);

    await requests.rejectRequest(asked.id, { note: "Brace was used" }, admin, db);
    await openBill();
    await forgotten.getByRole("button", { name: "Refund this…" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("radio", { name: "Chosen lines" })).toBeChecked();
    await expect(dialog.getByRole("checkbox", { name: new RegExp(line.bill_name) })).toBeChecked();
    await expect(dialog.getByRole("checkbox", { name: /Ankle brace/ })).not.toBeChecked();
    await expect(dialog.getByRole("combobox", { name: /^Reason/ })).toHaveValue("patient_declined");
    await expect(dialog.getByLabel("What the patient gets back")).toContainText(
      "Patient gets back ₹250",
    );
    const send = dialog.getByRole("button", { name: "Send request" });
    await expect(send).toBeInViewport();
    await send.click();
    await expect(dialog).toHaveCount(0);
    await expect(refunds).toContainText("Refund requested — waiting for admin.");
    await expect(forgotten).toHaveCount(0);
    const pending = await one(
      `SELECT reason_code, refund_lines FROM billing_requests
        WHERE bill_id = $1 AND kind = 'refund' AND status = 'pending'`,
      [bill.id],
    );
    expect(pending).toEqual({
      reason_code: "patient_declined",
      refund_lines: [{ line_id: line.id, quantity: 1 }],
    });
    const sideways = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(sideways).toBeLessThanOrEqual(1);
  });

  test("11. a station toast carrying a refund stays 8 seconds; other toasts keep 3.5", async ({
    page,
  }) => {
    expect(testCancelText.cancelledToastMs({ refunds: [{ message: "x" }] })).toBe(8000);
    expect(testCancelText.cancelledToastMs({ refunds: [] })).toBe(3500);
    expect(testCancelText.cancelledToastMs(undefined)).toBe(3500);

    const { visit } = await extraVisit(ids, "Toast");
    const machine = await orderOn(visit, [abi()], "machine");
    await payAndFinalise(machine.billId);
    await query(`UPDATE giniflow_visits SET current_status = 'checked_in' WHERE id = $1`, [visit]);
    await loginAs(page, "admin");
    await page.goto("/giniflow/station/machine");
    await page.getByText(`P4 Toast ${tag}`).first().click();
    await page.getByRole("button", { name: `✕ Cancel ${ids.abiName}` }).click();
    const form = page.getByRole("form", { name: `Cancel ${ids.abiName}` });
    await form.getByLabel("Reason").selectOption("station_unavailable");
    await form.getByRole("button", { name: `Cancel ${ids.abiName}` }).click();
    const toast = page.locator(".toast");
    await expect(toast).toContainText("Refund request raised for ₹400");
    await page.waitForTimeout(5500);
    await expect(toast).toContainText("Refund request raised for ₹400");
    await expect(toast).toHaveCount(0, { timeout: 5000 });
  });
});
