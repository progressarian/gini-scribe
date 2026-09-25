import { test, expect } from "@playwright/test";
import pg from "pg";
import { getPool, one, query } from "../../helpers/db.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { TEST_DATABASE_URL, assertTestDatabase } from "../../setup/guard.mjs";
import {
  desk,
  extraVisit,
  failure,
  newTag,
  payRule,
  refused,
  setUp,
  tearDown,
} from "./p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");
const payments = await import("../../../server/services/billing/payments.js");
const shifts = await import("../../../server/services/billing/cashShifts.js");
const visitLines = await import("../../../server/services/billing/visitLines.js");
const testCancel = await import("../../../server/services/giniflow/testCancel.js");
const labStation = await import("../../../server/services/giniflow/labStation.js");
const reception = await import("../../../server/services/giniflow/receptionStation.js");
const labPayment = await import("../../../shared/labPayment.js");
const { ORDER_STATE } = await import("../../../shared/billingVocab.js");

const db = getPool();
const tag = newTag();
const VALVE = "SCRIBE_BILL_TAKES_TEST_PAYMENTS";
const valveAtStart = process.env[VALVE];
const DEADLOCK = "40P01";
let ids;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const setValve = (value) => {
  if (value === undefined) delete process.env[VALVE];
  else process.env[VALVE] = value;
};

const withValveOn = async (work) => {
  setValve("1");
  try {
    return await work();
  } finally {
    setValve(undefined);
  }
};

const closeOpenShifts = () =>
  query(
    `UPDATE cash_shifts
        SET closed_at = NOW(), expected_cash = opening_cash, counted_cash = opening_cash,
            difference = 0
      WHERE closed_at IS NULL AND user_id = $1`,
    [USERS.reception.id],
  );

const orderRow = (id) =>
  one(
    `SELECT payment_status, sample_status, amount_total, amount_paid, amount_claimed, claim_state
       FROM giniflow_lab_orders WHERE id = $1`,
    [id],
  );

const money = async (id) => {
  const row = await orderRow(id);
  return {
    status: row.payment_status,
    sample: row.sample_status,
    paid: Number(row.amount_paid),
    claimed: Number(row.amount_claimed),
    claim: row.claim_state,
  };
};

const orderOf = async (visit, tests) => {
  const total = tests.reduce((sum, entry) => sum + entry.price, 0);
  const order = await one(
    `INSERT INTO giniflow_lab_orders (visit_id, urgency, payment_status, amount_total,
                                      sample_status, kind)
     VALUES ($1, 'today', 'pending', $2, 'payment_pending', 'lab') RETURNING id`,
    [visit, total],
  );
  for (const entry of tests) {
    await query(
      `INSERT INTO giniflow_lab_order_tests (lab_order_id, test_name, price) VALUES ($1, $2, $3)`,
      [order.id, entry.name, entry.price],
    );
  }
  return order.id;
};

const hba1c = () => ({ name: ids.hba1cName, price: 250 });
const abi = () => ({ name: ids.abiName, price: 400 });
const unpriced = () => ({ name: ids.looseName, price: 300 });

const billedOrder = async (label, tests, { dressingFirst = 0, dressingAfter = 0, brace } = {}) => {
  const { visit } = await extraVisit(ids, label);
  const draft = await bills.openDraft(visit, desk, db);
  if (dressingFirst) {
    await bills.addLine(draft.id, { item_id: ids.dressing, quantity: dressingFirst }, desk, db);
  }
  const order = await orderOf(visit, tests);
  await visitLines.linesForOrder(
    visit,
    { labOrderId: order, testNames: tests.map((entry) => entry.name) },
    desk,
    db,
  );
  if (dressingAfter) {
    await bills.addLine(draft.id, { item_id: ids.dressing, quantity: dressingAfter }, desk, db);
  }
  if (brace) await bills.addLine(draft.id, { item_id: ids.brace }, desk, db);
  return { visit, order, billId: draft.id };
};

const payOnBill = async (billId, amount, pool = db) => {
  const bill = await bills.readBill(billId, db);
  return payments.takePayments(billId, { version: bill.version, mode: "cash", amount }, desk, pool);
};

const clear = (orderId, extra = {}) =>
  reception.clearPayment(
    orderId,
    { method: "paid", actorId: USERS.reception.id, confirmNotOnBill: true, ...extra },
    db,
  );

const claimAtReception = (orderId, amount) =>
  clear(orderId, { method: "insurance_claim", amountClaimed: amount, insurer: "Star Health" });

const decideClaim = (orderId, method) =>
  reception.clearPayment(
    orderId,
    { method, actorId: USERS.coordinator.id, note: "insurer's answer" },
    db,
  );

const drawIt = (orderId) =>
  labStation.advanceSample(orderId, { to: "drawing", actorId: USERS.lab.id }, db);

const lineFor = async (billId, itemId) =>
  (await bills.readBill(billId, db)).lines.find((line) => line.service_item_id === itemId);

const removeItem = async (billId, itemId, reason = "not today", pool = db) =>
  bills.removeLine(billId, (await lineFor(billId, itemId)).id, { reason }, desk, pool);

const setQuantity = async (billId, itemId, quantity, pool = db) =>
  bills.changeQuantity(billId, (await lineFor(billId, itemId)).id, { quantity }, desk, pool);

const finalise = async (billId) => {
  const bill = await bills.readBill(billId, db);
  return bills.finaliseBill(billId, { version: bill.version }, desk, db);
};

const cancelOnFloor = (orderId, pool = db) =>
  testCancel.cancelTest(
    {
      target: { orderId },
      reason: "patient_declined",
      source: "station",
      actorId: USERS.reception.id,
      actorRole: "reception",
    },
    pool,
  );

const SESSION =
  "-c lock_timeout=15000 -c statement_timeout=20000 -c idle_in_transaction_session_timeout=30000";

const actor = () =>
  new pg.Pool({
    connectionString: TEST_DATABASE_URL,
    max: 1,
    idleTimeoutMillis: 0,
    ssl: false,
    options: SESSION,
  });

const pidOf = async (pool) => (await pool.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid;

const waitsOnALock = async (pid, label) => {
  for (let tries = 0; tries < 400; tries += 1) {
    const row = await one(`SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1`, [pid]);
    if (row?.wait_event_type === "Lock") return;
    await sleep(25);
  }
  throw new Error(`${label} never waited on a lock`);
};

const outcome = (promise) =>
  promise.then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  );

async function interleave({ hold, deskWork, orderId }) {
  const holder = new pg.Client({
    connectionString: TEST_DATABASE_URL,
    ssl: false,
    options: SESSION,
  });
  const deskPool = actor();
  const floorPool = actor();
  await holder.connect();
  try {
    const deskPid = await pidOf(deskPool);
    const floorPid = await pidOf(floorPool);
    await holder.query("BEGIN");
    await holder.query(hold.sql, hold.params);
    const deskRun = outcome(deskWork(deskPool));
    await waitsOnALock(deskPid, "the desk");
    const floorRun = outcome(cancelOnFloor(orderId, floorPool));
    await waitsOnALock(floorPid, "the floor cancel");
    await holder.query("ROLLBACK");
    const [deskDone, floorDone] = await Promise.all([deskRun, floorRun]);
    return { deskDone, floorDone };
  } finally {
    await holder.query("ROLLBACK").catch(() => {});
    await holder.end().catch(() => {});
    await deskPool.end().catch(() => {});
    await floorPool.end().catch(() => {});
  }
}

const noDeadlock = ({ deskDone, floorDone }) => {
  for (const [who, done] of [
    ["desk", deskDone],
    ["floor", floorDone],
  ]) {
    if (!done.ok) {
      throw new Error(
        `${who} failed: ${done.error.code ?? done.error.status} ${done.error.message}`,
      );
    }
  }
};

const holdLine = async (billId, itemId) => ({
  sql: `SELECT id FROM bill_lines WHERE id = $1 FOR UPDATE`,
  params: [(await lineFor(billId, itemId)).id],
});

const orderGone = async (orderId) =>
  Number(
    (await one(`SELECT COUNT(*)::int AS n FROM giniflow_lab_orders WHERE id = $1`, [orderId])).n,
  ) === 0;

test.describe.serial("P4C-06 lock order and reception claims", () => {
  test.beforeAll(async () => {
    setValve(undefined);
    ids = await setUp(tag);
    await payRule(ids, ids.pensioner, { name: "pensioner claims", patient_pays: "nothing" });
    await closeOpenShifts();
    ids.shift = (await shifts.openShift({ opening_cash: 0 }, desk, db)).id;
  });

  test.afterAll(async () => {
    setValve(valveAtStart);
    await tearDown(ids);
    await closeOpenShifts();
    await query(`DELETE FROM cash_shifts WHERE user_id = $1`, [USERS.reception.id]).catch(() => {});
  });

  test("1. removing a line at the desk while the floor cancels a test on that bill", async () => {
    const billed = await billedOrder("RaceRemove", [hba1c()], { dressingAfter: 1, brace: true });
    await payOnBill(billed.billId, 250);
    expect(await money(billed.order)).toMatchObject({ status: "paid", paid: 250 });

    const race = await interleave({
      hold: await holdLine(billed.billId, ids.brace),
      deskWork: (pool) => removeItem(billed.billId, ids.brace, "brace not needed", pool),
      orderId: billed.order,
    });
    expect(race.deskDone.error?.code).not.toBe(DEADLOCK);
    expect(race.floorDone.error?.code).not.toBe(DEADLOCK);
    noDeadlock(race);
    expect(await orderGone(billed.order)).toBe(true);
    const bill = await bills.readBill(billed.billId, db);
    expect(bill.lines.map((line) => line.service_item_id)).toEqual([ids.dressing]);
    expect(bill.totals.payable).toBe(50000);
  });

  test("2. changing a quantity at the desk while the floor cancels a test on that bill", async () => {
    const billed = await billedOrder("RaceQty", [hba1c()], { dressingAfter: 1 });
    await payOnBill(billed.billId, 250);

    const race = await interleave({
      hold: await holdLine(billed.billId, ids.dressing),
      deskWork: (pool) => setQuantity(billed.billId, ids.dressing, 2, pool),
      orderId: billed.order,
    });
    expect(race.deskDone.error?.code).not.toBe(DEADLOCK);
    expect(race.floorDone.error?.code).not.toBe(DEADLOCK);
    noDeadlock(race);
    expect(await orderGone(billed.order)).toBe(true);
    const bill = await bills.readBill(billed.billId, db);
    expect(bill.lines.map((line) => [line.service_item_id, Number(line.quantity)])).toEqual([
      [ids.dressing, 2],
    ]);
    expect(bill.totals.payable).toBe(100000);
  });

  test("3. taking a payment at the desk while the floor cancels a test on that bill", async () => {
    const billed = await billedOrder("RacePay", [hba1c()], { dressingAfter: 1 });

    const race = await interleave({
      hold: { sql: `SELECT id FROM cash_shifts WHERE id = $1 FOR UPDATE`, params: [ids.shift] },
      deskWork: (pool) => payOnBill(billed.billId, 250, pool),
      orderId: billed.order,
    });
    expect(race.deskDone.error?.code).not.toBe(DEADLOCK);
    expect(race.floorDone.error?.code).not.toBe(DEADLOCK);
    noDeadlock(race);
    expect(await orderGone(billed.order)).toBe(true);
    const bill = await bills.readBill(billed.billId, db);
    expect(bill.lines.map((line) => line.service_item_id)).toEqual([ids.dressing]);
    expect(bill.totals).toMatchObject({ payable: 50000, paid: 25000 });
  });

  test("4. adding a line at the desk while the floor cancels a test on a visit's second bill", async () => {
    const { visit } = await extraVisit(ids, "RaceAdd");
    const first = await bills.openDraft(visit, desk, db);
    await bills.addLine(first.id, { item_id: ids.dressing }, desk, db);
    await payOnBill(first.id, 500);
    await finalise(first.id);
    const order = await orderOf(visit, [hba1c()]);
    const added = await visitLines.linesForOrder(
      visit,
      { labOrderId: order, testNames: [ids.hba1cName] },
      desk,
      db,
    );
    expect(added.bill_id).not.toBe(first.id);
    await payOnBill(added.bill_id, 250);

    const race = await interleave({
      hold: { sql: `SELECT id FROM bills WHERE id = $1 FOR UPDATE`, params: [first.id] },
      deskWork: (pool) => bills.addLine(added.bill_id, { item_id: ids.brace }, desk, pool),
      orderId: order,
    });
    expect(race.deskDone.error?.code).not.toBe(DEADLOCK);
    expect(race.floorDone.error?.code).not.toBe(DEADLOCK);
    noDeadlock(race);
    expect(await orderGone(order)).toBe(true);
    const bill = await bills.readBill(added.bill_id, db);
    expect(bill.lines.map((line) => line.service_item_id)).toEqual([ids.brace]);
    expect(bill.totals).toMatchObject({ payable: 80000, paid: 25000 });
  });

  test("5. a floor cancel still removes a draft line, refuses a final bill's and frees a cancelled bill's", async () => {
    const onDraft = await billedOrder("CancelDraft", [hba1c(), abi()], { dressingAfter: 1 });
    await cancelOnFloor(onDraft.order);
    expect(await orderGone(onDraft.order)).toBe(true);
    let bill = await bills.readBill(onDraft.billId, db);
    expect(bill.lines.map((line) => line.service_item_id)).toEqual([ids.dressing]);
    expect(bill.totals.payable).toBe(50000);

    const onFinal = await billedOrder("CancelFinal", [hba1c()]);
    await payOnBill(onFinal.billId, 250);
    const final = await finalise(onFinal.billId);
    const refusal = await failure(cancelOnFloor(onFinal.order));
    expect(refusal?.status).toBe(409);
    expect(refusal.message).toBe(
      `HbA1c ${tag} is on bill ${final.bill_no}, so it can't be cancelled here — cancel that bill first`,
    );
    expect(await orderGone(onFinal.order)).toBe(false);

    const onCancelled = await billedOrder("CancelCancelled", [hba1c()]);
    await bills.setCategory(onCancelled.billId, { category: ids.pensioner }, desk, db);
    await finalise(onCancelled.billId);
    await bills.cancelBill(onCancelled.billId, { reason: "wrong patient" }, desk, db);
    await cancelOnFloor(onCancelled.order);
    expect(await orderGone(onCancelled.order)).toBe(true);
    const { rows } = await query(
      `SELECT lab_order_id, is_live FROM bill_lines WHERE bill_id = $1`,
      [onCancelled.billId],
    );
    expect(rows).toEqual([{ lab_order_id: null, is_live: false }]);
  });

  test("6. an approved reception claim on the unpriced part leaves the bill free to finish", async () => {
    const billed = await billedOrder("ClaimApproved", [hba1c(), unpriced()]);
    await payOnBill(billed.billId, 250);
    await withValveOn(() => claimAtReception(billed.order, 300));
    expect(await money(billed.order)).toMatchObject({
      status: "insurance_claim",
      paid: 250,
      claimed: 300,
      claim: "submitted",
    });
    expect((await lineFor(billed.billId, ids.hba1c)).order_state ?? null).toBeNull();

    await decideClaim(billed.order, "claim_approved");
    expect(await money(billed.order)).toMatchObject({
      status: "claim_approved",
      paid: 250,
      claimed: 300,
      claim: "approved",
      sample: "paid",
    });
    expect((await lineFor(billed.billId, ids.hba1c)).order_state ?? null).toBeNull();
    const final = await finalise(billed.billId);
    expect(final.status).toBe("final");
    expect(await money(billed.order)).toMatchObject({
      status: "claim_approved",
      paid: 250,
      claimed: 300,
      claim: "approved",
    });
  });

  test("7. removing the billed test after an approved reception claim gives back only the bill's cash", async () => {
    const billed = await billedOrder("ClaimRemoved", [hba1c(), unpriced()], { dressingAfter: 1 });
    await payOnBill(billed.billId, 250);
    await withValveOn(() => claimAtReception(billed.order, 300));
    await decideClaim(billed.order, "claim_approved");
    expect(await money(billed.order)).toMatchObject({ status: "claim_approved", sample: "paid" });

    await removeItem(billed.billId, ids.hba1c, "HbA1c another day");
    expect(await money(billed.order)).toMatchObject({
      status: "pending",
      paid: 0,
      claimed: 300,
      claim: "approved",
      sample: "ordered",
    });
    expect(labPayment.outstandingOf(await orderRow(billed.order))).toBe(250);
    await refused(drawIt(billed.order), 409, /Payment is not cleared/, "drawing the removed test");

    expect(await withValveOn(() => clear(billed.order))).toMatchObject({
      paymentStatus: "claim_approved",
    });
    expect(await money(billed.order)).toMatchObject({ paid: 250, claimed: 300, sample: "paid" });
  });

  test("8. a submitted reception claim survives a line change and the bill still finishes", async () => {
    const billed = await billedOrder("ClaimSubmitted", [hba1c(), unpriced()], { dressingAfter: 1 });
    await payOnBill(billed.billId, 250);
    await withValveOn(() => claimAtReception(billed.order, 300));

    await setQuantity(billed.billId, ids.dressing, 2);
    expect(await money(billed.order)).toMatchObject({
      status: "insurance_claim",
      paid: 250,
      claimed: 300,
      claim: "submitted",
    });
    expect((await lineFor(billed.billId, ids.hba1c)).order_state ?? null).toBeNull();

    const rest = await payOnBill(billed.billId, 1000);
    expect(rest.totals.outstanding).toBe(0);
    await decideClaim(billed.order, "claim_approved");
    await finalise(billed.billId);
    expect(await money(billed.order)).toMatchObject({
      status: "claim_approved",
      paid: 250,
      claimed: 300,
      claim: "approved",
    });

    const removed = await billedOrder("ClaimSubmittedGone", [hba1c(), unpriced()], {
      dressingAfter: 1,
    });
    await payOnBill(removed.billId, 250);
    await withValveOn(() => claimAtReception(removed.order, 300));
    await removeItem(removed.billId, ids.hba1c);
    expect(await money(removed.order)).toMatchObject({
      status: "insurance_claim",
      paid: 0,
      claimed: 300,
      claim: "submitted",
    });
  });

  test("9. a rejected reception claim, then cash at reception, and the bill still finishes", async () => {
    const billed = await billedOrder("ClaimRejected", [hba1c(), abi(), unpriced()], {
      dressingAfter: 1,
    });
    await payOnBill(billed.billId, 650);
    expect(await money(billed.order)).toMatchObject({ status: "part_paid", paid: 650 });
    await withValveOn(() => claimAtReception(billed.order, 300));
    await removeItem(billed.billId, ids.abi, "ABI another day");
    expect(await money(billed.order)).toMatchObject({
      status: "insurance_claim",
      paid: 250,
      claimed: 300,
      claim: "submitted",
    });

    await decideClaim(billed.order, "claim_rejected");
    expect(await money(billed.order)).toMatchObject({
      status: "part_paid",
      paid: 250,
      claim: "rejected",
    });
    expect((await lineFor(billed.billId, ids.hba1c)).order_state ?? null).toBeNull();

    expect(await withValveOn(() => clear(billed.order))).toMatchObject({ paymentStatus: "paid" });
    expect(await money(billed.order)).toMatchObject({ status: "paid", paid: 950 });
    await setQuantity(billed.billId, ids.dressing, 2);
    expect(await money(billed.order)).toMatchObject({ status: "paid", paid: 950 });
    await payOnBill(billed.billId, 600);
    await finalise(billed.billId);
    expect(await money(billed.order)).toMatchObject({
      status: "paid",
      paid: 950,
      claim: "rejected",
    });
  });

  test("10. raising an earlier line's quantity takes back a later order the bill no longer covers", async () => {
    const billed = await billedOrder("Earlier", [abi()], { dressingFirst: 1 });
    await payOnBill(billed.billId, 900);
    expect(await money(billed.order)).toMatchObject({ status: "paid", paid: 400, sample: "paid" });

    await setQuantity(billed.billId, ids.dressing, 2);
    expect(await money(billed.order)).toMatchObject({
      status: "pending",
      paid: 0,
      sample: "ordered",
    });
    await refused(
      drawIt(billed.order),
      409,
      /Payment is not cleared/,
      "drawing the uncovered test",
    );

    await payOnBill(billed.billId, 500);
    expect(await money(billed.order)).toMatchObject({ status: "paid", paid: 400, sample: "paid" });

    const kept = await billedOrder("EarlierKept", [hba1c(), unpriced()], { dressingFirst: 1 });
    await payOnBill(kept.billId, 750);
    expect(await clear(kept.order)).toMatchObject({ paymentStatus: "paid" });
    expect(await money(kept.order)).toMatchObject({ status: "paid", paid: 550 });
    await setQuantity(kept.billId, ids.dressing, 2);
    expect(await money(kept.order)).toMatchObject({
      status: "part_paid",
      paid: 300,
      sample: "ordered",
    });
    await payOnBill(kept.billId, 500);
    expect(await money(kept.order)).toMatchObject({ status: "paid", paid: 550, sample: "paid" });
  });

  test("11. a test re-added after reception took its money is named, with only reception's part", async () => {
    const billed = await billedOrder("Readded", [hba1c(), abi()], { dressingAfter: 1 });
    await payOnBill(billed.billId, 650);
    await removeItem(billed.billId, ids.abi, "ABI paid at the desk");
    expect(await withValveOn(() => clear(billed.order))).toMatchObject({ paymentStatus: "paid" });
    expect(await money(billed.order)).toMatchObject({ status: "paid", paid: 650 });

    const readded = await bills.addLine(
      billed.billId,
      { item_id: ids.abi, source: "lab_order", lab_order_id: billed.order },
      desk,
      db,
    );
    const state = (item) =>
      readded.lines.find((line) => line.service_item_id === item).order_state ?? null;
    expect(state(ids.abi)).toBe(ORDER_STATE.PAID_AT_RECEPTION);
    expect(state(ids.hba1c)).toBeNull();
    const attempt = await failure(finalise(billed.billId));
    expect(attempt?.code).toBe("order_paid");
    expect(attempt.message).toBe(
      `ABI ${tag} was already paid ₹400.00 at reception, so it can't also be paid on this visit's draft bill — remove it from this bill`,
    );
  });
});
