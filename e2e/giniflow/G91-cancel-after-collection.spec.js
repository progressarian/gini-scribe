import { test, expect } from "@playwright/test";
import { one, query } from "../helpers/db.mjs";
import { apiAs } from "../helpers/auth.mjs";
import { USERS } from "../fixtures/data.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { desk, extraVisit, newTag, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";
import { db, dropShifts, openDeskShift, prepareCategory } from "../billing/phase4b/p4b-refunds.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
await import("../../server/services/giniflow/board.js");
const bills = await import("../../server/services/billing/bills.js");
const payments = await import("../../server/services/billing/payments.js");
const visitLines = await import("../../server/services/billing/visitLines.js");
const refundBoard = await import("../../server/services/billing/refundBoard.js");
const settings = await import("../../server/services/billing/billingSettings.js");
const testCancel = await import("../../server/services/giniflow/testCancel.js");
const lab = await import("../../server/services/giniflow/labStation.js");
const machine = await import("../../server/services/giniflow/machineStation.js");
const requests = await import("../../server/services/giniflow/cancelRequests.js");

const tag = newTag();
let ids;

const labCtx = { actorId: USERS.lab.id, role: "lab", ip: "10.9.91.1" };
const admin = { actorId: USERS.admin.id, role: "admin", ip: "10.9.91.2", canDecide: true };
const reception = { actorId: USERS.reception.id, role: "reception", ip: "10.9.91.3" };

async function orderOn(visit, kind) {
  const test =
    kind === "lab" ? { name: ids.hba1cName, price: 250 } : { name: ids.abiName, price: 400 };
  const order = await one(
    `INSERT INTO giniflow_lab_orders (visit_id, urgency, payment_status, amount_total,
                                      sample_status, kind)
     VALUES ($1, 'today', 'pending', $2, 'payment_pending', $3) RETURNING id`,
    [visit, test.price, kind],
  );
  await query(
    `INSERT INTO giniflow_lab_order_tests (lab_order_id, test_name, price) VALUES ($1, $2, $3)`,
    [order.id, test.name, test.price],
  );
  const raised = await visitLines.linesForOrder(
    visit,
    { labOrderId: order.id, testNames: [test.name] },
    desk,
    db,
  );
  return { order: order.id, billId: raised.bill_id };
}

async function paidTest(label, { kind = "lab", status = "sample_collected", final = true } = {}) {
  const { visit } = await extraVisit(ids, label);
  const { order, billId } = await orderOn(visit, kind);
  const ready = await bills.setCategory(billId, { category: ids.pensioner }, desk, db);
  await payments.takePayments(
    ready.id,
    { version: ready.version, payments: [{ mode: "cash", amount: ready.totals.payable / 100 }] },
    desk,
    db,
  );
  if (final) {
    const fresh = await bills.readBill(ready.id, db);
    await bills.finaliseBill(ready.id, { version: fresh.version }, desk, db);
  }
  await query(`UPDATE giniflow_lab_orders SET sample_status = $2 WHERE id = $1`, [order, status]);
  return { visit, order, billId: ready.id };
}

const target = (order) => ({ orderId: order });
const raise = (order, extra = {}, ctx = labCtx) =>
  requests.raiseCancelRequest(
    { target: target(order), reason_code: "patient_left", ...extra },
    ctx,
    db,
  );
const refusal = (promise) => promise.then(() => null).catch((error) => error);
const orderRow = (id) => one(`SELECT sample_status FROM giniflow_lab_orders WHERE id = $1`, [id]);
const requestRow = (id) =>
  one(
    `SELECT status, charge_amount, paid_amount, credit_note_id, decision_note
       FROM billing_requests WHERE id = $1`,
    [id],
  );

test.describe.serial("G91 urgent cancellation of a test after collection", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    await prepareCategory(ids);
    await openDeskShift(0);
  });

  test.afterAll(async () => {
    await query(
      `DELETE FROM billing_requests WHERE kind = 'test_cancel'
          AND visit_id IN (SELECT v.id FROM giniflow_visits v JOIN patients p ON p.id = v.patient_id
                            WHERE p.name LIKE $1)`,
      [`%${tag}`],
    );
    await tearDown(ids);
    await dropShifts();
  });

  test("1. the stage decides what the floor may do", async () => {
    const lab1 = await paidTest("StageLab", { status: "paid" });
    expect((await requests.cancelStage(target(lab1.order), db)).stage).toBe("direct");
    for (const [status, stage] of [
      ["drawing", "cancel_start_first"],
      ["sample_collected", "request"],
      ["sample_sent", "request"],
      ["sample_received", "request"],
      ["processing", "request"],
      ["results_ready", "locked"],
    ]) {
      await query(`UPDATE giniflow_lab_orders SET sample_status = $2 WHERE id = $1`, [
        lab1.order,
        status,
      ]);
      expect((await requests.cancelStage(target(lab1.order), db)).stage, status).toBe(stage);
    }
    const mac = await paidTest("StageMachine", { kind: "machine", status: "in_progress" });
    expect((await requests.cancelStage(target(mac.order), db)).stage).toBe("request");
    await query(`UPDATE giniflow_lab_orders SET sample_status = 'done' WHERE id = $1`, [mac.order]);
    const stage = await requests.cancelStage(target(mac.order), db);
    expect(stage).toMatchObject({ stage: "request", paid: 40000 });
    expect(stage.defaults).toEqual({ type: "percent", percent: 10, fixed: 50 });
  });

  test("2. a collected test can't be cancelled directly, and a report locks it", async () => {
    const t = await paidTest("Direct");
    const direct = await refusal(
      testCancel.cancelTest(
        {
          target: target(t.order),
          reason: "patient_declined",
          source: "station",
          actorId: USERS.lab.id,
          actorRole: "lab",
        },
        db,
      ),
    );
    expect(direct?.status).toBe(409);
    await query(`UPDATE giniflow_lab_orders SET report_file_url = 'x.pdf' WHERE id = $1`, [
      t.order,
    ]);
    const locked = await refusal(raise(t.order));
    expect(locked).toMatchObject({
      status: 409,
      message: "A report is already on this test — it can't be cancelled",
    });
  });

  test("3. raising puts the test on hold; other tests on the visit carry on", async () => {
    const t = await paidTest("Hold");
    const other = await orderOn(t.visit, "machine");
    await query(
      `UPDATE giniflow_lab_orders SET sample_status = 'paid', payment_status = 'paid', amount_paid = 400 WHERE id = $1`,
      [other.order],
    );
    const asked = await raise(t.order, { reason_code: "other", note: "Family emergency" });
    expect(asked).toMatchObject({ kind: "test_cancel", status: "pending" });
    const held = await refusal(
      lab.advanceSample(t.order, { to: "sample_sent", actorId: USERS.lab.id }, db),
    );
    expect(held).toMatchObject({ status: 409, code: "cancel_pending" });
    expect(held.message).toBe("Cancellation requested — waiting for admin");
    expect((await orderRow(t.order)).sample_status).toBe("sample_collected");
    const second = await refusal(raise(t.order));
    expect(second).toMatchObject({
      status: 409,
      message: "A cancellation is already waiting for admin for this test",
    });
    await machine
      .advanceMachineTest(other.order, { to: "in_progress", actorId: USERS.admin.id }, db)
      .catch((e) => {
        expect(e.code).not.toBe("cancel_pending");
      });
  });

  test("4. the request form is validated", async () => {
    const t = await paidTest("Validate");
    expect(
      await refusal(requests.raiseCancelRequest({ target: target(t.order) }, labCtx, db)),
    ).toMatchObject({
      status: 400,
      message: "Pick why this test must be cancelled",
    });
    expect(
      await refusal(
        requests.raiseCancelRequest(
          { target: target(t.order), reason_code: "other", note: "x" },
          labCtx,
          db,
        ),
      ),
    ).toMatchObject({ status: 400, message: "Say why — at least 3 characters" });
    expect(
      await refusal(
        requests.raiseCancelRequest(
          { target: { orderId: "nope" }, reason_code: "duplicate" },
          labCtx,
          db,
        ),
      ),
    ).toMatchObject({ status: 404 });
  });

  test("5. only the requester or an admin can withdraw; withdrawing lifts the hold", async () => {
    const t = await paidTest("Withdraw");
    const asked = await raise(t.order);
    expect(await refusal(requests.withdrawCancelRequest(asked.id, reception, db))).toMatchObject({
      status: 403,
    });
    await requests.withdrawCancelRequest(asked.id, labCtx, db);
    expect((await requestRow(asked.id)).status).toBe("withdrawn");
    await lab.advanceSample(t.order, { to: "sample_sent", actorId: USERS.lab.id }, db);
    expect((await orderRow(t.order)).sample_status).toBe("sample_sent");
  });

  test("6. approve with the 10% default: test cancelled, ₹25 kept, ₹225 to pay back", async () => {
    const t = await paidTest("Approve");
    const asked = await raise(t.order);
    const approved = await requests.approveCancelRequest(
      asked.id,
      { charge_type: "percent", charge_value: 10, note: "Emergency, approved" },
      admin,
      db,
    );
    expect(approved).toMatchObject({
      status: "approved",
      paid: 25000,
      charge: 2500,
      refund: 22500,
    });
    expect(
      await one(`SELECT 1 AS here FROM giniflow_lab_orders WHERE id = $1`, [t.order]),
    ).toBeFalsy();
    const row = await requestRow(asked.id);
    expect(row).toMatchObject({
      status: "approved",
      charge_amount: "25.00",
      paid_amount: "250.00",
    });
    const note = await one(`SELECT credit_kind, patient_payable FROM bills WHERE id = $1`, [
      row.credit_note_id,
    ]);
    expect(note).toEqual({ credit_kind: "cancel_charge", patient_payable: "225.00" });
    const board = await refundBoard.refundBoard({ q: tag }, db);
    const entry = JSON.stringify(board).includes(asked.id)
      ? Object.values(board)
          .flatMap((v) => (Array.isArray(v) ? v : Object.values(v || {}).flat()))
          .find((r) => r?.request_id === asked.id)
      : null;
    expect(entry, JSON.stringify(Object.keys(board))).toMatchObject({
      kind: "test_cancel",
      group: "to_pay",
    });
    expect(entry.amounts.to_pay).toBe(22500);
    const events = await query(
      `SELECT status, meta FROM giniflow_visit_events WHERE visit_id = $1 AND status IN ('cancel_requested', 'test_cancelled') ORDER BY occurred_at`,
      [t.visit],
    );
    expect(events.rows.map((e) => e.status)).toEqual(["cancel_requested", "test_cancelled"]);
    expect(events.rows[1].meta).toMatchObject({ reason: "urgent_after_collection", charge: 2500 });
  });

  test("7. a fixed charge above what was paid is refused; the full amount means no refund", async () => {
    const t = await paidTest("Fixed");
    const asked = await raise(t.order);
    const tooMuch = await refusal(
      requests.approveCancelRequest(
        asked.id,
        { charge_type: "fixed", charge_value: 300, note: "Keep it all" },
        admin,
        db,
      ),
    );
    expect(tooMuch).toMatchObject({
      status: 400,
      message: "The charge can't be more than ₹250.00",
    });
    expect((await requestRow(asked.id)).status).toBe("pending");
    const all = await requests.approveCancelRequest(
      asked.id,
      { charge_type: "fixed", charge_value: 250, note: "Keep it all" },
      admin,
      db,
    );
    expect(all).toMatchObject({ refund: 0, charge: 25000 });
    expect((await requestRow(asked.id)).credit_note_id).toBeNull();
  });

  test("8. charge and note are validated", async () => {
    const t = await paidTest("ChargeRules");
    const asked = await raise(t.order);
    for (const [input, message] of [
      [
        { charge_type: "percent", charge_value: 101, note: "ok note" },
        "Enter a percentage from 0 to 100",
      ],
      [
        { charge_type: "percent", charge_value: -1, note: "ok note" },
        "Enter a percentage from 0 to 100, up to 2 decimals",
      ],
      [
        { charge_type: "fixed", charge_value: "1.234", note: "ok note" },
        "Enter an amount of 0 or more, up to 2 decimals",
      ],
      [
        { charge_type: "both", charge_value: 1, note: "ok note" },
        "Choose a percentage or a fixed amount",
      ],
      [
        { charge_type: "percent", charge_value: 10, note: "" },
        "Write a short note for the record — at least 3 characters",
      ],
    ]) {
      expect(
        await refusal(requests.approveCancelRequest(asked.id, input, admin, db)),
        message,
      ).toMatchObject({
        message,
      });
    }
    expect((await requestRow(asked.id)).status).toBe("pending");
  });

  test("9. a paid draft is made final before the refund", async () => {
    const t = await paidTest("Draft", { final: false });
    expect((await one(`SELECT status FROM bills WHERE id = $1`, [t.billId])).status).toBe("draft");
    const asked = await raise(t.order);
    const done = await requests.approveCancelRequest(
      asked.id,
      { charge_type: "fixed", charge_value: 50, note: "Approved on a draft" },
      admin,
      db,
    );
    expect(done).toMatchObject({ refund: 20000, charge: 5000 });
    expect((await one(`SELECT status FROM bills WHERE id = $1`, [t.billId])).status).toBe("final");
  });

  test("10. reject needs a note, lifts the hold and the test carries on", async () => {
    const t = await paidTest("Reject");
    const asked = await raise(t.order);
    expect(
      await refusal(requests.rejectCancelRequest(asked.id, { note: "" }, admin, db)),
    ).toMatchObject({ status: 400 });
    await requests.rejectCancelRequest(asked.id, { note: "Sample already in analyser" }, admin, db);
    expect(await requestRow(asked.id)).toMatchObject({
      status: "rejected",
      decision_note: "Sample already in analyser",
    });
    await lab.advanceSample(t.order, { to: "sample_sent", actorId: USERS.lab.id }, db);
    expect(
      await refusal(
        requests.approveCancelRequest(
          asked.id,
          { charge_type: "percent", charge_value: 10, note: "late" },
          admin,
          db,
        ),
      ),
    ).toMatchObject({ status: 409 });
  });

  test("11. two admins approving at once: only one succeeds", async () => {
    const t = await paidTest("Race");
    const asked = await raise(t.order);
    const decide = () =>
      requests
        .approveCancelRequest(
          asked.id,
          { charge_type: "percent", charge_value: 10, note: "race" },
          admin,
          db,
        )
        .then(() => "ok")
        .catch((e) => e.status);
    const results = await Promise.all([decide(), decide()]);
    expect(results.sort()).toEqual([409, "ok"].sort());
  });

  test("12. a settings change does not alter a past approval", async () => {
    await settings.updateSettings({ cancel_charge_pct: 20 }, admin, db);
    try {
      const t = await paidTest("Settings");
      expect((await requests.cancelStage(target(t.order), db)).defaults.percent).toBe(20);
      const row = await one(
        `SELECT charge_amount FROM billing_requests WHERE kind = 'test_cancel' AND status = 'approved'
            AND decision_note = 'Emergency, approved' ORDER BY decided_at DESC LIMIT 1`,
      );
      expect(row.charge_amount).toBe("25.00");
      expect(
        await refusal(settings.updateSettings({ cancel_charge_pct: 101 }, admin, db)),
      ).toMatchObject({ status: 400 });
    } finally {
      await settings.updateSettings({ cancel_charge_pct: 10 }, admin, db);
    }
  });

  test("13. the admin can cancel at once with the same result", async () => {
    const t = await paidTest("Now", { kind: "machine", status: "done" });
    const done = await requests.cancelNow(
      {
        target: target(t.order),
        reason_code: "wrong_test",
        charge_type: "percent",
        charge_value: 10,
        note: "Admin cancelled",
      },
      admin,
      db,
    );
    expect(done).toMatchObject({ status: "approved", paid: 40000, charge: 4000, refund: 36000 });
  });

  test("14. permissions: the floor asks, only an admin decides", async () => {
    const t = await paidTest("Perms");
    const asApi = async (role, method, url, data) => {
      const api = await apiAs(role);
      try {
        const res = await api[method](url, data ? { data } : undefined);
        return { status: res.status(), body: await res.json().catch(() => null) };
      } finally {
        await api.dispose();
      }
    };
    const asked = await asApi("lab", "post", "/api/giniflow/tests/cancel-requests", {
      target: { orderId: t.order },
      reason_code: "duplicate",
    });
    expect(asked.status, JSON.stringify(asked.body)).toBe(200);
    for (const role of ["lab", "reception", "reception_admin"]) {
      const res = await asApi(
        role,
        "post",
        `/api/giniflow/tests/cancel-requests/${asked.body.id}/approve`,
        {
          charge_type: "percent",
          charge_value: 10,
          note: "not mine",
        },
      );
      expect(res.status, role).toBe(403);
    }
    expect((await asApi("reception", "get", "/api/giniflow/tests/cancel-requests")).status).toBe(
      403,
    );
    const list = await asApi(
      "admin",
      "get",
      `/api/giniflow/tests/cancel-requests?status=pending&q=${encodeURIComponent(tag)}`,
    );
    expect(list.status).toBe(200);
    expect(list.body.rows.map((r) => r.id)).toContain(asked.body.id);
    const ok = await asApi(
      "admin",
      "post",
      `/api/giniflow/tests/cancel-requests/${asked.body.id}/reject`,
      {
        note: "Not urgent",
      },
    );
    expect(ok.status).toBe(200);
  });

  test("15. a HealthRay case collected at the lab: requested, held, then approved", async () => {
    const made = await extraVisit(ids, "Case");
    const caseNo = `G91-${tag}`;
    await query(
      `INSERT INTO lab_cases (case_no, patient_case_no, case_uid, lab_case_id, patient_id,
                              appointment_id, test_names, case_date, case_status, raw_list_json)
       VALUES ($1, $1, $1, $2, $3, $4, $5, $6::date, 'Registered', '{}'::jsonb)`,
      [
        caseNo,
        991000 + Math.floor(Math.random() * 8000),
        made.patient,
        made.appointment,
        [ids.hba1cName],
        ids.day,
      ],
    );
    const draft = await bills.openDraft(made.visit, desk, db);
    await bills.addLine(draft.id, { item_id: ids.hba1c, source: "lab_case" }, desk, db);
    const ready = await bills.setCategory(draft.id, { category: ids.pensioner }, desk, db);
    await payments.takePayments(
      ready.id,
      { version: ready.version, payments: [{ mode: "cash", amount: ready.totals.payable / 100 }] },
      desk,
      db,
    );
    const fresh = await bills.readBill(ready.id, db);
    await bills.finaliseBill(ready.id, { version: fresh.version }, desk, db);
    const caseTarget = { caseNo, patientId: made.patient, date: ids.day };
    expect((await requests.cancelStage(caseTarget, db)).stage).toBe("direct");
    await query(
      `INSERT INTO giniflow_lab_case_actions (case_no, action, actor_role, actor_id)
       VALUES ($1, 'sample_taken', 'lab', $2)`,
      [caseNo, USERS.lab.id],
    );
    expect(await requests.cancelStage(caseTarget, db)).toMatchObject({
      stage: "request",
      paid: 25000,
    });
    const asked = await requests.raiseCancelRequest(
      { target: caseTarget, reason_code: "sample_unusable" },
      labCtx,
      db,
    );
    const held = await refusal(
      lab.markLabCaseAction(caseNo, { action: "sample_sent", actorId: USERS.lab.id }, db),
    );
    expect(held).toMatchObject({ status: 409, code: "cancel_pending" });
    const done = await requests.approveCancelRequest(
      asked.id,
      { charge_type: "percent", charge_value: 10, note: "Sample haemolysed" },
      admin,
      db,
    );
    expect(done).toMatchObject({ paid: 25000, charge: 2500, refund: 22500 });
    const cancelled = await one(
      `SELECT 1 AS here FROM giniflow_lab_case_actions WHERE case_no = $1 AND action = 'cancelled'`,
      [caseNo],
    );
    expect(cancelled).toBeTruthy();
    await query(`DELETE FROM giniflow_lab_case_actions WHERE case_no = $1`, [caseNo]);
    await query(`DELETE FROM lab_cases WHERE case_no = $1`, [caseNo]);
  });
});
