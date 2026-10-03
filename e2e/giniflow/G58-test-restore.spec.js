import { test, expect } from "@playwright/test";
import { one, query } from "../helpers/db.mjs";
import { apiAs } from "../helpers/auth.mjs";
import { USERS } from "../fixtures/data.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { desk, extraVisit, newTag, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";
import { db, dropShifts, openDeskShift, prepareCategory } from "../billing/phase4b/p4b-refunds.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../server/services/billing/bills.js");
const payments = await import("../../server/services/billing/payments.js");
const visitLines = await import("../../server/services/billing/visitLines.js");
const testCancel = await import("../../server/services/giniflow/testCancel.js");
const restore = await import("../../server/services/giniflow/testRestore.js");
const { getMachines } = await import("../../server/services/giniflow/machineCatalog.js");
const { machinesForStation } = await import("../../shared/machineStages.js");

const tag = newTag();
let ids;
let echoTest;

async function orderOn(visit, name, price, kind, { paid = false } = {}) {
  const order = await one(
    `INSERT INTO giniflow_lab_orders (visit_id, urgency, payment_status, amount_total, amount_paid,
                                      sample_status, kind)
     VALUES ($1, 'today', $2, $3, $4, $5, $6) RETURNING id`,
    [
      visit,
      paid ? "paid" : "pending",
      price,
      paid ? price : 0,
      paid ? "paid" : "payment_pending",
      kind,
    ],
  );
  await query(
    `INSERT INTO giniflow_lab_order_tests (lab_order_id, test_name, price) VALUES ($1, $2, $3)`,
    [order.id, name, price],
  );
  await query(
    `INSERT INTO giniflow_lab_order_events (lab_order_id, track, status, actor_role)
     VALUES ($1, 'payment', $2, 'reception')`,
    [order.id, paid ? "paid" : "pending"],
  );
  return order.id;
}

const cancel = (orderId, { source = "station", reason = "doctor_cancelled" } = {}) =>
  testCancel.cancelTest(
    { target: { orderId }, reason, source, actorId: USERS.lab.id, actorRole: "lab" },
    db,
  );

const draftLines = (visit) =>
  query(
    `SELECT l.lab_order_id, l.source FROM bill_lines l JOIN bills b ON b.id = l.bill_id
      WHERE l.visit_id = $1 AND l.is_live AND b.status = 'draft'`,
    [visit],
  ).then((r) => r.rows);

const listed = async (station, orderId) =>
  (await restore.listCancelled(station, db)).find((row) => row.orderId === orderId);

test.describe.serial("G58 restore a mistakenly cancelled test", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    await prepareCategory(ids);
    await openDeskShift(0);
    echoTest = machinesForStation(await getMachines(db), "echo")[0].tests[0];
  });

  test.afterAll(async () => {
    await tearDown(ids);
    await dropShifts();
  });

  test("1. a paid echo comes back as the same order, still paid, with its history", async () => {
    const { visit } = await extraVisit(ids, "Echo");
    const orderId = await orderOn(visit, echoTest, 1800, "machine", { paid: true });
    await cancel(orderId);
    expect(
      await one(`SELECT 1 AS here FROM giniflow_lab_orders WHERE id = $1`, [orderId]),
    ).toBeFalsy();

    const before = await listed("echo", orderId);
    expect(before).toMatchObject({
      tests: echoTest,
      canRestore: true,
      restoredAt: null,
      amountPaid: 1800,
    });
    expect(before.patient.fileNo).toBeTruthy();

    const result = await restore.restoreTest(
      { orderId, station: "echo", actorId: USERS.reception.id, actorRole: "reception" },
      db,
    );
    expect(result).toMatchObject({
      orderId,
      paymentStatus: "paid",
      amountPaid: 1800,
      billLines: [],
    });
    const order = await one(
      `SELECT payment_status, amount_paid::float AS paid, sample_status FROM giniflow_lab_orders WHERE id = $1`,
      [orderId],
    );
    expect(order).toEqual({ payment_status: "paid", paid: 1800, sample_status: "paid" });
    const events = await query(
      `SELECT track, status FROM giniflow_lab_order_events WHERE lab_order_id = $1 ORDER BY seq`,
      [orderId],
    );
    expect(events.rows).toEqual([
      { track: "payment", status: "paid" },
      { track: "station", status: "restored" },
    ]);
    const marker = await one(
      `SELECT meta FROM giniflow_visit_events WHERE visit_id = $1 AND status = 'test_restored'`,
      [visit],
    );
    expect(marker.meta.tests).toEqual([echoTest]);

    const after = await listed("echo", orderId);
    expect(after).toMatchObject({ canRestore: false, restoredBy: expect.any(String) });
    expect(await listed("machine", orderId)).toBeUndefined();
    await expect(
      restore.restoreTest({ orderId, station: "echo", actorId: USERS.reception.id }, db),
    ).rejects.toMatchObject({ status: 409, message: "This test is already restored" });
  });

  test("2. an unpaid lab test goes back on the draft bill it was taken off", async () => {
    const { visit } = await extraVisit(ids, "LabUnpaid");
    const orderId = await orderOn(visit, ids.hba1cName, 250, "lab");
    await visitLines.linesForOrder(
      visit,
      { labOrderId: orderId, testNames: [ids.hba1cName] },
      desk,
      db,
    );
    expect(await draftLines(visit)).toEqual([{ lab_order_id: orderId, source: "lab_order" }]);
    await cancel(orderId);
    expect(await draftLines(visit)).toEqual([]);

    const result = await restore.restoreTest(
      { orderId, station: "lab", actorId: USERS.lab.id, actorRole: "lab" },
      db,
    );
    expect(result.billLines).toEqual([ids.hba1cName]);
    expect(await draftLines(visit)).toEqual([{ lab_order_id: orderId, source: "lab_order" }]);
  });

  test("3. a restored cancel no longer stops the HealthRay bill from raising the test", async () => {
    const { visit } = await extraVisit(ids, "Suppress");
    const orderId = await orderOn(visit, ids.hba1cName, 250, "lab");
    await cancel(orderId);
    const blocked = await testCancel.billSuppressor(db, visit);
    expect(blocked({ kind: "lab", testName: ids.hba1cName, line: null })).toBe(true);
    await restore.restoreTest({ orderId, station: "lab", actorId: USERS.lab.id }, db);
    const open = await testCancel.billSuppressor(db, visit);
    expect(open({ kind: "lab", testName: ids.hba1cName, line: null })).toBe(false);
  });

  test("4. a test HealthRay cancelled is refused, with the reason", async () => {
    const { visit } = await extraVisit(ids, "Hr");
    const orderId = await orderOn(visit, ids.hba1cName, 250, "lab");
    await cancel(orderId, { source: "healthray", reason: "refunded_in_healthray" });
    const row = await listed("lab", orderId);
    expect(row).toMatchObject({ canRestore: false, whyNot: restore.RESTORE_REFUSALS.healthray });
    await expect(
      restore.restoreTest({ orderId, station: "lab", actorId: USERS.lab.id }, db),
    ).rejects.toMatchObject({ status: 409, message: restore.RESTORE_REFUSALS.healthray });
  });

  test("5. a test that was on a final bill is refused: its money is in the refund workflow", async () => {
    const { visit } = await extraVisit(ids, "Final");
    const orderId = await orderOn(visit, ids.hba1cName, 250, "lab");
    const raised = await visitLines.linesForOrder(
      visit,
      { labOrderId: orderId, testNames: [ids.hba1cName] },
      desk,
      db,
    );
    const ready = await bills.setCategory(raised.bill_id, { category: ids.pensioner }, desk, db);
    const taken = await payments.takePayments(
      ready.id,
      { version: ready.version, payments: [{ mode: "cash", amount: ready.totals.payable / 100 }] },
      desk,
      db,
    );
    await bills.finaliseBill(ready.id, { version: taken.version }, desk, db);
    await cancel(orderId);
    await expect(
      restore.restoreTest({ orderId, station: "lab", actorId: USERS.lab.id }, db),
    ).rejects.toMatchObject({ status: 409, message: restore.RESTORE_REFUSALS.final_bill });
  });

  test("6. over HTTP: the station lists its cancels, a lab user may restore a lab test, not an echo", async () => {
    const { visit } = await extraVisit(ids, "Http");
    const labOrder = await orderOn(visit, ids.hba1cName, 250, "lab");
    const echoOrder = await orderOn(visit, echoTest, 1800, "machine", { paid: true });
    await cancel(labOrder);
    await cancel(echoOrder);
    const api = await apiAs("lab");
    const list = await api.get("/api/giniflow/stations/lab/cancelled");
    expect(list.status()).toBe(200);
    const body = await list.json();
    expect(body.cancelled.map((r) => r.orderId)).toContain(labOrder);
    expect(body.cancelled.map((r) => r.orderId)).not.toContain(echoOrder);
    const wrong = await api.post(`/api/giniflow/stations/lab/cancelled/${echoOrder}/restore`, {
      data: {},
    });
    expect(wrong.status()).toBe(409);
    const ok = await api.post(`/api/giniflow/stations/lab/cancelled/${labOrder}/restore`, {
      data: {},
    });
    expect(ok.status(), (await ok.json()).error).toBe(200);
    await api.dispose();
  });
});
