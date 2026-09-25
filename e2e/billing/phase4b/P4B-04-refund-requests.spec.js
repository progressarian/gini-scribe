import { test, expect } from "@playwright/test";
import { one } from "../../helpers/db.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { newTag, refused, setUp, tearDown } from "../phase4/p4-bills-fixture.mjs";
import {
  admin,
  askRefund,
  auditActions,
  billRow,
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
const creditNotes = await import("../../../server/services/billing/creditNotes.js");

const tag = newTag();
let ids;

const seriesNext = () =>
  one(`SELECT next_no::int AS n FROM bill_series WHERE series = 'CN' AND fy = $1`, [ids.fy]);

test.describe.serial("P4B-04 refund requests: ask and approve", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    await prepareCategory(ids);
    await openDeskShift(0);
    const { bill } = await finalBill(
      ids,
      "Ask",
      [{ item: ids.dressing, quantity: 2 }, { item: ids.brace }],
      { pay: inCash },
    );
    ids.bill = bill;
  });

  test.afterAll(async () => {
    await tearDown(ids);
    await dropShifts();
  });

  test("1. the desk asks for a refund of chosen lines, as paid by default, and it is audited", async () => {
    const dressing = lineFor(ids.bill, ids.dressing);
    const preview = await creditNotes.previewCredit(
      ids.bill.id,
      { lines: [{ line_id: dressing.id, quantity: 1 }] },
      db,
    );
    expect(preview.refund.mode).toBe("as_paid");
    expect(preview.refund.due).toBe(preview.totals.payable);
    expect(preview.refund.legs).toEqual([{ mode: "cash", amount: preview.totals.payable }]);

    const request = await askRefund(ids.bill.id, [{ line_id: dressing.id, quantity: 1 }], {
      requested_by: USERS.admin.id,
    });
    expect(request).toMatchObject({ kind: "refund", status: "pending", bill_id: ids.bill.id });
    expect(request.requested_by.id).toBe(USERS.reception.id);
    expect(request.refund).toMatchObject({
      lines: [{ line_id: dressing.id, quantity: 1 }],
      requested_mode: "as_paid",
      approved_mode: null,
      credit_note: null,
    });
    expect(request.usable).toBe(false);
    expect(await auditActions("billing_requests", request.id)).toEqual(["create"]);
    const pending = await requests.listRequests({ status: "pending", kind: "refund" }, db);
    expect(pending.map((r) => r.id)).toContain(request.id);
    ids.request = request;
  });

  test("2. one refund waits per bill, a line is named once, and no price is sent", async () => {
    await refused(
      askRefund(ids.bill.id, "whole"),
      409,
      /already waiting for an admin's answer/,
      "a second pending refund",
    );
    const brace = lineFor(ids.bill, ids.brace);
    await refused(
      askRefund(ids.bill.id, [{ line_id: brace.id }, { line_id: brace.id.toUpperCase() }]),
      400,
      /only once/,
      "the same line twice",
    );
    await refused(
      askRefund(ids.bill.id, [{ line_id: brace.id }], { amount: 100 }),
      400,
      /can't carry a price/,
      "a refund with an amount",
    );
    await refused(
      askRefund(ids.bill.id, [{ line_id: brace.id }], { requested_mode: "cheque" }),
      400,
      /only as one of/,
      "an unknown mode",
    );
    await refused(
      askRefund(ids.bill.id, [{ line_id: brace.id }], { reason: " " }),
      400,
      null,
      "no reason",
    );
  });

  test("3. a mode different from the desk's needs the admin's reason; approving makes the credit note", async () => {
    const before = await seriesNext();
    await refused(
      requests.approveRequest(ids.request.id, { approved_mode: "upi" }, admin, db),
      400,
      /Say why the money goes back another way/,
      "a changed mode with no reason",
    );
    expect((await seriesNext()).n).toBe(before.n);
    const approved = await requests.approveRequest(
      ids.request.id,
      { approved_mode: "upi", mode_reason: "The cash drawer is empty", note: "Fine" },
      admin,
      db,
    );
    expect(approved.status).toBe("approved");
    expect(approved.decided_by.id).toBe(USERS.admin.id);
    expect(approved.refund).toMatchObject({
      requested_mode: "as_paid",
      approved_mode: "upi",
      mode_reason: "The cash drawer is empty",
    });
    expect(approved.refund.credit_note.id).toBe(approved.credit_note.id);
    expect(approved.credit_note.refund).toMatchObject({ approved_mode: "upi", admin_note: "Fine" });
    expect(approved.credit_note.refund.legs).toEqual([
      { mode: "upi", amount: approved.credit_note.refund.due },
    ]);
    expect((await seriesNext()).n).toBe(before.n + 1);
    expect(await auditActions("billing_requests", ids.request.id)).toEqual(["create", "approve"]);
    await refused(
      requests.approveRequest(ids.request.id, {}, admin, db),
      409,
      /already approved/,
      "approving twice",
    );
    const stored = await one(
      `SELECT status, approved_mode, credit_note_id FROM billing_requests WHERE id = $1`,
      [ids.request.id],
    );
    expect(stored).toMatchObject({ status: "approved", approved_mode: "upi" });
    expect((await billRow(stored.credit_note_id)).original_bill_id).toBe(ids.bill.id);
  });

  test("4. a rejected refund needs a note, makes nothing, and lets the desk ask again", async () => {
    const brace = lineFor(ids.bill, ids.brace);
    const request = await askRefund(ids.bill.id, [{ line_id: brace.id }]);
    await refused(requests.rejectRequest(request.id, {}, admin, db), 400, /note/, "no note");
    const rejected = await requests.rejectRequest(
      request.id,
      { note: "The brace was used" },
      admin,
      db,
    );
    expect(rejected.status).toBe("rejected");
    expect(rejected.refund.credit_note).toBeNull();
    const again = await askRefund(ids.bill.id, [{ line_id: brace.id }]);
    expect(again.status).toBe("pending");
    ids.again = again;
  });

  test("5. a failed approval leaves the request pending, with no credit note and no number taken", async () => {
    const before = await seriesNext();
    await one(
      `UPDATE bills SET status = 'cancelled', cancelled_at = NOW(), cancel_reason = 'probe'
        WHERE id = $1 RETURNING id`,
      [ids.bill.id],
    );
    await refused(
      requests.approveRequest(ids.again.id, {}, admin, db),
      409,
      /was cancelled/,
      "approving on a cancelled bill",
    );
    await one(
      `UPDATE bills SET status = 'final', cancelled_at = NULL, cancel_reason = NULL
        WHERE id = $1 RETURNING id`,
      [ids.bill.id],
    );
    const stored = await one(`SELECT status, credit_note_id FROM billing_requests WHERE id = $1`, [
      ids.again.id,
    ]);
    expect(stored).toMatchObject({ status: "pending", credit_note_id: null });
    expect((await seriesNext()).n).toBe(before.n);
    const approved = await requests.approveRequest(ids.again.id, {}, admin, db);
    expect(approved.refund.approved_mode).toBe("as_paid");
    expect(approved.refund.mode_reason).toBeNull();
    expect(approved.credit_note.refund.legs).toEqual([
      { mode: "cash", amount: approved.credit_note.refund.due },
    ]);
  });
});
