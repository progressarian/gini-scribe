import { test, expect } from "@playwright/test";
import { one, query } from "../../helpers/db.mjs";
import { apiAs, loginAs } from "../../helpers/auth.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { desk, extraVisit, failure, newTag, setUp, tearDown } from "../phase4/p4-bills-fixture.mjs";
import {
  admin,
  askRefund,
  billRow,
  db,
  dropShifts,
  lineFor,
  openDeskShift,
  prepareCategory,
} from "./p4b-refunds.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");
const payments = await import("../../../server/services/billing/payments.js");
const requests = await import("../../../server/services/billing/billingRequests.js");
const visitLines = await import("../../../server/services/billing/visitLines.js");
const testCancel = await import("../../../server/services/giniflow/testCancel.js");

const tag = newTag();
let ids;

const hba1c = () => ({ name: ids.hba1cName, price: 250, item: ids.hba1c });
const abi = () => ({ name: ids.abiName, price: 400, item: ids.abi });

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

async function billedTest(label, tests, { kind = "lab", final = true, pay = true } = {}) {
  const { visit } = await extraVisit(ids, label);
  const { order, billId } = await orderOn(visit, tests, kind);
  if (!final) return { visit, order, bill: await bills.readBill(billId, db) };
  const ready = await bills.setCategory(billId, { category: ids.pensioner }, desk, db);
  let version = ready.version;
  if (pay) {
    const taken = await payments.takePayments(
      ready.id,
      { version, payments: [{ mode: "cash", amount: ready.totals.payable / 100 }] },
      desk,
      db,
    );
    version = taken.version;
  }
  const bill = await bills.finaliseBill(ready.id, { version, pay_later: !pay }, desk, db);
  return { visit, order, bill };
}

const cancelAt = (orderId, reason, { testId = null, note, station = null } = {}) =>
  testCancel.cancelTest(
    {
      target: testId ? { orderId, testId } : { orderId },
      reason,
      note,
      source: "station",
      stationLabel: station,
      actorId: USERS.lab.id,
      actorRole: "lab",
    },
    db,
  );

const pendingOn = (billId) =>
  query(
    `SELECT id, reason, reason_code, refund_lines, requested_mode, requested_by
       FROM billing_requests WHERE bill_id = $1 AND kind = 'refund' AND status = 'pending'`,
    [billId],
  ).then((r) => r.rows);

const lineRow = (id) =>
  one(`SELECT lab_order_id, source, is_live FROM bill_lines WHERE id = $1`, [id]);

const orderGone = async (id) =>
  !(await one(`SELECT 1 AS here FROM giniflow_lab_orders WHERE id = $1`, [id]));

const cancellationOf = (orderId) =>
  one(
    `SELECT reason, note, source FROM giniflow_test_cancellations WHERE order_id = $1
      ORDER BY seq DESC LIMIT 1`,
    [orderId],
  );

const testIdOf = async (orderId, name) =>
  (
    await one(
      `SELECT id FROM giniflow_lab_order_tests WHERE lab_order_id = $1 AND test_name = $2`,
      [orderId, name],
    )
  ).id;

test.describe.serial("P4B-15 a floor cancel of a paid test raises a refund request", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    await prepareCategory(ids);
    await openDeskShift(0);
  });

  test.afterAll(async () => {
    await tearDown(ids);
    await dropShifts();
  });

  test("1. the lab station cancels a paid test on a final bill: test gone, refund raised, station told", async () => {
    const { order, bill } = await billedTest("LabStation", [hba1c()]);
    const line = lineFor(bill, ids.hba1c);
    const api = await apiAs("lab");
    const response = await api.post(`/api/giniflow/stations/lab/${order}/cancel-test`, {
      data: { reason: "doctor_cancelled" },
    });
    const body = await response.json();
    await api.dispose();
    expect(response.status(), body.error).toBe(200);
    expect(body.refunds).toEqual([
      {
        status: "raised",
        request_id: expect.any(String),
        bill_id: bill.id,
        bill_no: bill.bill_no,
        amount: 25000,
        due: 25000,
        message: `Refund request raised for ₹250 on bill ${bill.bill_no} — waiting for admin approval`,
      },
    ]);
    expect(await orderGone(order)).toBe(true);
    expect(await cancellationOf(order)).toMatchObject({
      reason: "doctor_cancelled",
      source: "station",
    });
    const [pending] = await pendingOn(bill.id);
    expect(pending).toMatchObject({
      id: body.refunds[0].request_id,
      reason_code: "doctor_cancelled",
      reason: `Doctor cancelled the test — Cancelled at the lab station by ${USERS.lab.name}`,
      refund_lines: [{ line_id: line.id, quantity: 1 }],
      requested_mode: "as_paid",
      requested_by: USERS.lab.id,
    });
    expect(await lineRow(line.id)).toEqual({ lab_order_id: null, source: "added", is_live: true });
    const marker = await one(
      `SELECT meta FROM giniflow_visit_events WHERE visit_id = $1 AND status = 'test_cancelled'`,
      [bill.visit_id],
    );
    expect(marker.meta.refunds).toEqual([
      { status: "raised", request_id: pending.id, bill_no: bill.bill_no },
    ]);
  });

  test("2. the machine station cancels a paid machine test when the machine is down", async () => {
    const { order, bill } = await billedTest("MachineStation", [abi()], { kind: "machine" });
    const api = await apiAs("admin");
    const response = await api.post(`/api/giniflow/stations/machine/${order}/cancel-test`, {
      data: { reason: "station_unavailable" },
    });
    const body = await response.json();
    await api.dispose();
    expect(response.status(), body.error).toBe(200);
    expect(body.refunds[0]).toMatchObject({
      status: "raised",
      due: 40000,
      message: `Refund request raised for ₹400 on bill ${bill.bill_no} — waiting for admin approval`,
    });
    expect(await orderGone(order)).toBe(true);
    const [pending] = await pendingOn(bill.id);
    expect(pending).toMatchObject({
      reason_code: "station_unavailable",
      reason: `Machine / station not available — Cancelled at the machine room station by ${USERS.admin.name}`,
      refund_lines: [{ line_id: lineFor(bill, ids.abi).id, quantity: 1 }],
    });
  });

  test("3. every floor reason maps to a refund reason, keeping the floor's words", async () => {
    const cases = [
      ["patient_declined", undefined, "patient_declined", "Patient declined — "],
      [
        "billed_by_mistake",
        "Wrong box ticked",
        "billed_by_mistake",
        "Billed by mistake / duplicate — Wrong box ticked — ",
      ],
      ["duplicate", undefined, "billed_by_mistake", "Billed by mistake / duplicate — Duplicate — "],
      ["refunded", "Money given back", "other", "Refunded — Money given back — "],
      ["other", "Vein too thin today", "other", "Vein too thin today — "],
    ];
    for (const [reason, note, code, start] of cases) {
      const { order, bill } = await billedTest(`Map${reason}`, [hba1c()]);
      const result = await cancelAt(order, reason, { note });
      expect(result.refunds[0].status).toBe("raised");
      const [pending] = await pendingOn(bill.id);
      expect(pending.reason_code, reason).toBe(code);
      expect(pending.reason, reason).toBe(
        `${start}Cancelled at the lab station by ${USERS.lab.name}`,
      );
    }
  });

  test("4. one test of a paid two-test order: only its line is asked back, the other stays paid", async () => {
    const { order, bill } = await billedTest("Partial", [hba1c(), abi()]);
    const result = await cancelAt(order, "patient_declined", {
      testId: await testIdOf(order, ids.abiName),
    });
    expect(result.wholeOrder).toBe(false);
    expect(result.refunds[0]).toMatchObject({ status: "raised", due: 40000 });
    const [pending] = await pendingOn(bill.id);
    expect(pending.refund_lines).toEqual([{ line_id: lineFor(bill, ids.abi).id, quantity: 1 }]);
    const left = await one(
      `SELECT payment_status, sample_status, amount_total, amount_paid FROM giniflow_lab_orders
        WHERE id = $1`,
      [order],
    );
    expect(left).toMatchObject({ payment_status: "paid", sample_status: "paid" });
    expect(Number(left.amount_total)).toBe(250);
    expect(Number(left.amount_paid)).toBe(250);
    expect(await lineRow(lineFor(bill, ids.hba1c).id)).toEqual({
      lab_order_id: order,
      source: "lab_order",
      is_live: true,
    });
  });

  test("5. a refund already waiting on the bill: the test is still cancelled, the station is told", async () => {
    const { visit } = await extraVisit(ids, "Waiting");
    const first = await orderOn(visit, [hba1c()], "lab");
    const second = await orderOn(visit, [abi()], "machine");
    expect(second.billId).toBe(first.billId);
    await bills.addLine(first.billId, { item_id: ids.brace }, desk, db);
    const ready = await bills.setCategory(first.billId, { category: ids.pensioner }, desk, db);
    const taken = await payments.takePayments(
      ready.id,
      { version: ready.version, payments: [{ mode: "cash", amount: ready.totals.payable / 100 }] },
      desk,
      db,
    );
    const bill = await bills.finaliseBill(ready.id, { version: taken.version }, desk, db);
    const asked = await askRefund(bill.id, [{ line_id: lineFor(bill, ids.brace).id }]);

    const result = await cancelAt(first.order, "patient_declined");
    expect(result.refunds).toEqual([
      {
        status: "waiting",
        request_id: asked.id,
        bill_id: bill.id,
        bill_no: bill.bill_no,
        message: `A refund request on bill ${bill.bill_no} is already waiting — ask the admin to include this test`,
      },
    ]);
    expect(await orderGone(first.order)).toBe(true);
    const pending = await pendingOn(bill.id);
    expect(pending).toHaveLength(1);
    expect(pending[0].refund_lines).toEqual([
      { line_id: lineFor(bill, ids.brace).id, quantity: 1 },
    ]);
    expect(await lineRow(lineFor(bill, ids.hba1c).id)).toEqual({
      lab_order_id: null,
      source: "added",
      is_live: true,
    });

    await requests.rejectRequest(asked.id, { note: "Brace was used" }, admin, db);
    const again = await askRefund(bill.id, [{ line_id: lineFor(bill, ids.abi).id }]);
    const included = await cancelAt(second.order, "station_unavailable");
    expect(included.refunds).toEqual([
      {
        status: "included",
        request_id: again.id,
        bill_id: bill.id,
        bill_no: bill.bill_no,
        message: `This test is already in the refund request waiting on bill ${bill.bill_no}`,
      },
    ]);
    expect(await orderGone(second.order)).toBe(true);
    expect(await pendingOn(bill.id)).toHaveLength(1);
  });

  test("6. a test already sampled is refused as before and raises nothing", async () => {
    const { order, bill } = await billedTest("Done", [hba1c()]);
    await query(`UPDATE giniflow_lab_orders SET sample_status = 'sample_collected' WHERE id = $1`, [
      order,
    ]);
    const refusal = await failure(cancelAt(order, "patient_declined"));
    expect(refusal?.status).toBe(409);
    expect(refusal.message).toBe("The sample is already taken — it cannot be cancelled");
    expect(await orderGone(order)).toBe(false);
    expect(await pendingOn(bill.id)).toEqual([]);
  });

  test("7. a test on a draft bill: its line is removed as before, no refund", async () => {
    const { order, bill } = await billedTest("Draft", [hba1c()], { final: false });
    await bills.addLine(bill.id, { item_id: ids.brace }, desk, db);
    const result = await cancelAt(order, "patient_declined");
    expect(result.refunds).toEqual([]);
    expect(await orderGone(order)).toBe(true);
    const after = await bills.readBill(bill.id, db);
    expect(after.lines.map((line) => line.service_item_id)).toEqual([ids.brace]);
    expect(await pendingOn(bill.id)).toEqual([]);
  });

  test("8. a pay-later bill: the refund comes off what is owed and the station says so", async () => {
    const { order, bill } = await billedTest("Owed", [hba1c()], { pay: false });
    const result = await cancelAt(order, "patient_declined");
    expect(result.refunds[0]).toMatchObject({
      status: "raised",
      amount: 25000,
      due: 0,
      message: `Refund request raised on bill ${bill.bill_no} — ₹250 comes off what is still owed, waiting for admin approval`,
    });
  });

  test("9. a HealthRay sync cancel still refuses a test on a final bill", async () => {
    const { order, bill } = await billedTest("Sync", [hba1c()]);
    const refusal = await failure(
      testCancel.cancelTest(
        {
          target: { orderId: order },
          reason: "cancelled_in_healthray",
          source: "healthray",
          actorRole: "system",
        },
        db,
      ),
    );
    expect(refusal?.status).toBe(409);
    expect(refusal.message).toMatch(/cancel that bill first/);
    expect(await orderGone(order)).toBe(false);
    expect(await pendingOn(bill.id)).toEqual([]);
  });

  test("10. approval then pay-out closes the loop", async () => {
    const { order, bill } = await billedTest("Loop", [hba1c()]);
    const result = await cancelAt(order, "doctor_cancelled");
    const approved = await requests.approveRequest(result.refunds[0].request_id, {}, admin, db);
    expect(approved.status).toBe("approved");
    expect(approved.released_orders).toEqual([]);
    expect(approved.visit_left).toBeNull();
    const note = approved.credit_note;
    expect(note.totals.payable).toBe(25000);
    expect(note.refund.due).toBe(25000);
    expect((await lineRow(lineFor(bill, ids.hba1c).id)).is_live).toBe(false);
    const paid = await payments.payOut(
      note.id,
      { version: note.version, payments: [{ mode: "cash", amount: 250 }] },
      desk,
      db,
    );
    expect(paid).toBeTruthy();
    const after = await billRow(note.id);
    expect(Number(after.paid_amount)).toBe(250);
    const refunded = await one(
      `SELECT COALESCE(SUM(amount), 0)::numeric AS out FROM payments
        WHERE bill_id = $1 AND direction = 'out'`,
      [note.id],
    );
    expect(Number(refunded.out)).toBe(250);
  });

  test("11. the machine station screen shows the refund message after the cancel", async ({
    page,
  }) => {
    const { bill } = await billedTest("Screen", [abi()], { kind: "machine" });
    await query(`UPDATE giniflow_visits SET current_status = 'checked_in' WHERE id = $1`, [
      bill.visit_id,
    ]);
    await loginAs(page, "admin");
    await page.goto("/giniflow/station/machine");
    await page.getByText(`P4 Screen ${tag}`).first().click();
    await page.getByRole("button", { name: `✕ Cancel ${ids.abiName}` }).click();
    const form = page.getByRole("form", { name: `Cancel ${ids.abiName}` });
    await form.getByLabel("Reason").selectOption("station_unavailable");
    await form.getByRole("button", { name: `Cancel ${ids.abiName}` }).click();
    await expect(page.locator(".toast")).toContainText(
      `Refund request raised for ₹400 on bill ${bill.bill_no} — waiting for admin approval`,
    );
    expect(await pendingOn(bill.id)).toHaveLength(1);
  });
});
