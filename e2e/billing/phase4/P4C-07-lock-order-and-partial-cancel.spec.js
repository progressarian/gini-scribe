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
const moStation = await import("../../../server/services/giniflow/moStation.js");

const db = getPool();
const tag = newTag();
const VALVE = "SCRIBE_BILL_TAKES_TEST_PAYMENTS";
const valveAtStart = process.env[VALVE];
const DEADLOCK = "40P01";
let ids;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const closeOpenShifts = () =>
  query(
    `UPDATE cash_shifts
        SET closed_at = NOW(), expected_cash = opening_cash, counted_cash = opening_cash,
            difference = 0
      WHERE closed_at IS NULL AND user_id = $1`,
    [USERS.reception.id],
  );

const money = async (id) => {
  const row = await one(
    `SELECT payment_status, sample_status, amount_total, amount_paid, amount_claimed
       FROM giniflow_lab_orders WHERE id = $1`,
    [id],
  );
  return {
    status: row.payment_status,
    sample: row.sample_status,
    total: Number(row.amount_total),
    paid: Number(row.amount_paid),
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

const billedOrder = async (label, tests, { dressingAfter = 0 } = {}) => {
  const { visit } = await extraVisit(ids, label);
  const draft = await bills.openDraft(visit, desk, db);
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
  return { visit, order, billId: draft.id };
};

const payOnBill = async (billId, amount, pool = db) => {
  const bill = await bills.readBill(billId, db);
  return payments.takePayments(billId, { version: bill.version, mode: "cash", amount }, desk, pool);
};

const clear = (orderId) =>
  reception.clearPayment(
    orderId,
    { method: "paid", actorId: USERS.reception.id, confirmNotOnBill: true },
    db,
  );

const drawIt = (orderId) =>
  labStation.advanceSample(orderId, { to: "drawing", actorId: USERS.lab.id }, db);

const lineFor = async (billId, itemId) =>
  (await bills.readBill(billId, db)).lines.find((line) => line.service_item_id === itemId);

const finalise = async (billId) => {
  const bill = await bills.readBill(billId, db);
  return bills.finaliseBill(billId, { version: bill.version }, desk, db);
};

const testIdOf = async (orderId, name) =>
  (
    await one(
      `SELECT id FROM giniflow_lab_order_tests WHERE lab_order_id = $1 AND test_name = $2`,
      [orderId, name],
    )
  ).id;

const cancelOnFloor = (orderId, pool = db, testId = null) =>
  testCancel.cancelTest(
    {
      target: testId ? { orderId, testId } : { orderId },
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

const connection = async () => {
  const client = new pg.Client({
    connectionString: TEST_DATABASE_URL,
    ssl: false,
    options: SESSION,
  });
  await client.connect();
  return client;
};

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

const noDeadlock = (runs) => {
  for (const [who, done] of Object.entries(runs)) {
    if (!done.ok) {
      throw new Error(
        `${who} failed: ${done.error.code ?? done.error.status} ${done.error.message}`,
      );
    }
  }
};

function gated(pool, pattern) {
  let reached;
  let open;
  const gate = {
    reached: new Promise((resolve) => (reached = resolve)),
    opened: new Promise((resolve) => (open = resolve)),
    open: () => open(),
  };
  const wrapped = {
    connect: async () => {
      const client = await pool.connect();
      const run = client.query.bind(client);
      let hit = false;
      client.query = async (...args) => {
        const text = typeof args[0] === "string" ? args[0] : args[0]?.text;
        if (!hit && pattern.test(text || "")) {
          hit = true;
          reached();
          await gate.opened;
        }
        return run(...args);
      };
      return client;
    },
  };
  return { pool: wrapped, gate };
}

async function stationAgainstDesk({ billId, station }) {
  const holder = await connection();
  const deskPool = actor();
  const stationPool = actor();
  try {
    const deskPid = await pidOf(deskPool);
    const stationPid = await pidOf(stationPool);
    await holder.query("BEGIN");
    await holder.query(`SELECT id FROM bills WHERE id = $1 FOR UPDATE`, [billId]);
    const deskRun = outcome(bills.addLine(billId, { item_id: ids.brace }, desk, deskPool));
    await waitsOnALock(deskPid, "the desk");
    const stationRun = outcome(station(stationPool));
    await waitsOnALock(stationPid, "the station");
    await holder.query("ROLLBACK");
    const [deskDone, stationDone] = await Promise.all([deskRun, stationRun]);
    return { desk: deskDone, station: stationDone };
  } finally {
    await holder.query("ROLLBACK").catch(() => {});
    await holder.end().catch(() => {});
    await deskPool.end().catch(() => {});
    await stationPool.end().catch(() => {});
  }
}

const liveLinesOf = async (orderId) =>
  (
    await query(`SELECT bill_name FROM bill_lines WHERE lab_order_id = $1 AND is_live`, [orderId])
  ).rows.map((row) => row.bill_name);

test.describe.serial("P4C-07 lock order and the partial floor cancel", () => {
  test.beforeAll(async () => {
    delete process.env[VALVE];
    ids = await setUp(tag);
    await payRule(ids, ids.pensioner, { name: "pensioner claims", patient_pays: "nothing" });
    await closeOpenShifts();
    ids.shift = (await shifts.openShift({ opening_cash: 0 }, desk, db)).id;
  });

  test.afterAll(async () => {
    if (valveAtStart === undefined) delete process.env[VALVE];
    else process.env[VALVE] = valveAtStart;
    await tearDown(ids);
    await closeOpenShifts();
    await query(`DELETE FROM cash_shifts WHERE user_id = $1`, [USERS.reception.id]).catch(() => {});
  });

  test("1. cancelling one test of a paid order on the floor leaves the draft free to finish", async () => {
    const billed = await billedOrder("PartialPaid", [hba1c(), abi()], { dressingAfter: 1 });
    await payOnBill(billed.billId, 650);
    expect(await money(billed.order)).toMatchObject({ status: "paid", paid: 650, sample: "paid" });

    await cancelOnFloor(billed.order, db, await testIdOf(billed.order, ids.abiName));
    expect(await money(billed.order)).toMatchObject({
      status: "paid",
      total: 250,
      paid: 250,
      sample: "paid",
    });
    let bill = await bills.readBill(billed.billId, db);
    expect(bill.lines.map((line) => line.service_item_id)).toEqual([ids.hba1c, ids.dressing]);
    expect(bill.totals).toMatchObject({ payable: 75000, paid: 65000 });
    expect((await lineFor(billed.billId, ids.hba1c)).order_state ?? null).toBeNull();

    const rest = await payOnBill(billed.billId, 100);
    expect(rest.totals.outstanding).toBe(0);
    const final = await finalise(billed.billId);
    expect(final.status).toBe("final");
    expect(await money(billed.order)).toMatchObject({ status: "paid", paid: 250, sample: "paid" });
    bill = await bills.readBill(billed.billId, db);
    expect(bill.totals).toMatchObject({ payable: 75000, paid: 75000 });
  });

  test("2. cancelling one test on the floor never opens the gate with the unpriced part unpaid", async () => {
    const billed = await billedOrder("PartialLoose", [hba1c(), abi(), unpriced()], {
      dressingAfter: 1,
    });
    await payOnBill(billed.billId, 650);
    expect(await money(billed.order)).toMatchObject({ status: "part_paid", paid: 650 });

    await cancelOnFloor(billed.order, db, await testIdOf(billed.order, ids.abiName));
    const after = await money(billed.order);
    expect(after).toMatchObject({ status: "part_paid", total: 550, paid: 250 });
    expect(after.sample).not.toBe("paid");
    await refused(drawIt(billed.order), 409, /Payment is not cleared/, "drawing before reception");

    expect(await clear(billed.order)).toMatchObject({ paymentStatus: "paid" });
    expect(await money(billed.order)).toMatchObject({ status: "paid", paid: 550, sample: "paid" });
    await payOnBill(billed.billId, 100);
    await finalise(billed.billId);
    expect(await money(billed.order)).toMatchObject({ status: "paid", paid: 550 });
  });

  test("3. cancelling one test of an order paid only at reception still caps its money", async () => {
    const { visit } = await extraVisit(ids, "PartialReception");
    const order = await orderOf(visit, [hba1c(), unpriced()]);
    expect(await clear(order)).toMatchObject({ paymentStatus: "paid" });
    await cancelOnFloor(order, db, await testIdOf(order, ids.looseName));
    expect(await money(order)).toMatchObject({ status: "paid", total: 250, paid: 250 });
    const row = await one(
      `SELECT refund_amount FROM giniflow_test_cancellations WHERE order_id = $1`,
      [order],
    );
    expect(row.refund_amount).toBeNull();
  });

  test("4. a desk line on a second bill while the floor cancels a test billed on an earlier one", async () => {
    let setup = null;
    for (let tries = 0; tries < 12 && !setup; tries += 1) {
      const { visit } = await extraVisit(ids, `Approval${tries}`);
      const order = await orderOf(visit, [hba1c()]);
      const first = await visitLines.linesForOrder(
        visit,
        { labOrderId: order, testNames: [ids.hba1cName] },
        desk,
        db,
      );
      await bills.setCategory(first.bill_id, { category: ids.pensioner }, desk, db);
      await finalise(first.bill_id);
      await bills.cancelBill(first.bill_id, { reason: "wrong patient" }, desk, db);
      const second = await bills.openDraft(visit, desk, db);
      if (first.bill_id < second.id) setup = { order, earlier: first.bill_id, later: second.id };
    }
    expect(setup).not.toBeNull();

    const deskActor = actor();
    const floorPool = actor();
    const { pool: deskPool, gate } = gated(deskActor, /FROM service_items\s+WHERE id = \$1/);
    try {
      const floorPid = await pidOf(floorPool);
      const deskRun = outcome(bills.addLine(setup.later, { item_id: ids.brace }, desk, deskPool));
      await gate.reached;
      const floorRun = outcome(cancelOnFloor(setup.order, floorPool));
      await waitsOnALock(floorPid, "the floor cancel");
      gate.open();
      const [deskDone, floorDone] = await Promise.all([deskRun, floorRun]);
      expect(deskDone.error?.code).not.toBe(DEADLOCK);
      expect(floorDone.error?.code).not.toBe(DEADLOCK);
      noDeadlock({ desk: deskDone, floor: floorDone });
    } finally {
      gate.open();
      await deskActor.end().catch(() => {});
      await floorPool.end().catch(() => {});
    }
    const bill = await bills.readBill(setup.later, db);
    expect(bill.lines.map((line) => line.service_item_id)).toEqual([ids.brace]);
    expect(
      Number(
        (
          await one(`SELECT COUNT(*)::int AS n FROM giniflow_lab_orders WHERE id = $1`, [
            setup.order,
          ])
        ).n,
      ),
    ).toBe(0);
  });

  test("5. a deadlocked station fails with its order, never commits the order without its line", async () => {
    const { visit } = await extraVisit(ids, "Swallow");
    const draft = await bills.openDraft(visit, desk, db);
    await bills.addLine(draft.id, { item_id: ids.dressing }, desk, db);
    let orderId = null;
    const race = await stationAgainstDesk({
      billId: draft.id,
      station: async (pool) => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query(`SELECT id FROM giniflow_visits WHERE id = $1 FOR UPDATE`, [visit]);
          const { rows } = await client.query(
            `INSERT INTO giniflow_lab_orders (visit_id, urgency, payment_status, amount_total,
                                              sample_status, kind)
             VALUES ($1, 'today', 'pending', 250, 'payment_pending', 'lab') RETURNING id`,
            [visit],
          );
          orderId = rows[0].id;
          await client.query(
            `INSERT INTO giniflow_lab_order_tests (lab_order_id, test_name, price)
             VALUES ($1, $2, 250)`,
            [orderId, ids.hba1cName],
          );
          const added = await visitLines.linesForOrder(
            visit,
            { labOrderId: orderId, testNames: [ids.hba1cName] },
            desk,
            client,
          );
          await client.query("COMMIT");
          return added;
        } catch (error) {
          await client.query("ROLLBACK").catch(() => {});
          throw error;
        } finally {
          client.release();
        }
      },
    });
    const committed = Number(
      (await one(`SELECT COUNT(*)::int AS n FROM giniflow_lab_orders WHERE id = $1`, [orderId])).n,
    );
    if (committed) {
      expect(race.station.ok).toBe(true);
      expect(await liveLinesOf(orderId)).toEqual([`HbA1c ${tag}`]);
    } else {
      expect(race.station.error?.code).toBe(DEADLOCK);
    }
    expect(race.station.ok || race.desk.ok).toBe(true);
  });

  test("6. the MO ordering tests while the desk adds a line to the same draft", async () => {
    const { visit } = await extraVisit(ids, "MoOrder");
    const draft = await bills.openDraft(visit, desk, db);
    await bills.addLine(draft.id, { item_id: ids.dressing }, desk, db);
    const race = await stationAgainstDesk({
      billId: draft.id,
      station: (pool) =>
        moStation.orderTests(visit, { urgency: "today", tests: [ids.hba1cName] }, pool),
    });
    expect(race.desk.error?.code).not.toBe(DEADLOCK);
    expect(race.station.error?.code).not.toBe(DEADLOCK);
    noDeadlock(race);
    const bill = await bills.readBill(draft.id, db);
    expect(bill.lines.map((line) => line.service_item_id).sort()).toEqual(
      [ids.dressing, ids.brace, ids.hba1c].sort(),
    );
    expect(await liveLinesOf(race.station.value.orderId)).toEqual([`HbA1c ${tag}`]);
  });

  test("7. a failed partial cancel changes nothing", async () => {
    const billed = await billedOrder("PartialFinal", [hba1c(), abi()]);
    await payOnBill(billed.billId, 650);
    await finalise(billed.billId);
    const refusal = await failure(
      cancelOnFloor(billed.order, db, await testIdOf(billed.order, ids.abiName)),
    );
    expect(refusal?.status).toBe(409);
    expect(await money(billed.order)).toMatchObject({ status: "paid", total: 650, paid: 650 });
  });
});
