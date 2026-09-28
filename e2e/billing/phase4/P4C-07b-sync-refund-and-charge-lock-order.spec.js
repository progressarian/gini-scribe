import { test, expect } from "@playwright/test";
import pg from "pg";
import { getPool, one, query } from "../../helpers/db.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { TEST_DATABASE_URL, assertTestDatabase } from "../../setup/guard.mjs";
import { desk, extraVisit, newTag, payRule, setUp, tearDown } from "./p4-bills-fixture.mjs";
import { refundApproved } from "../phase4b/p4b-refunds.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");
const payments = await import("../../../server/services/billing/payments.js");
const shifts = await import("../../../server/services/billing/cashShifts.js");
const visitLines = await import("../../../server/services/billing/visitLines.js");
const testCancel = await import("../../../server/services/giniflow/testCancel.js");
const machineSync = await import("../../../server/services/giniflow/machineSync.js");

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

const waitsOrFinishes = async (pid, run) => {
  let settled = false;
  run.then(() => (settled = true));
  for (let tries = 0; tries < 400 && !settled; tries += 1) {
    const row = await one(`SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1`, [pid]);
    if (row?.wait_event_type === "Lock") return;
    await sleep(25);
  }
};

const outcome = (promise) =>
  promise.then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  );

const described = (done) =>
  done.ok ? "ok" : `${done.error.code ?? done.error.status} ${done.error.message}`;

function gated(pool, pattern, nth = 1) {
  let reached;
  let open;
  const gate = {
    reached: new Promise((resolve) => (reached = resolve)),
    opened: new Promise((resolve) => (open = resolve)),
    open: () => open(),
  };
  let hits = 0;
  const wrapped = {
    query: (...args) => pool.query(...args),
    connect: async () => {
      const client = await pool.connect();
      const run = client.query.bind(client);
      client.query = async (...args) => {
        const text = typeof args[0] === "string" ? args[0] : args[0]?.text;
        if (hits < nth && pattern.test(text || "")) {
          hits += 1;
          if (hits === nth) {
            reached();
            await gate.opened;
          }
        }
        return run(...args);
      };
      return client;
    },
  };
  return { pool: wrapped, gate };
}

async function race({ first, firstPattern, nth = 1, second, secondWaits = true }) {
  const firstActor = actor();
  const secondPool = actor();
  const { pool: firstPool, gate } = gated(firstActor, firstPattern, nth);
  try {
    const secondPid = await pidOf(secondPool);
    const firstRun = outcome(first(firstPool));
    await Promise.race([gate.reached, firstRun]);
    const secondRun = outcome(second(secondPool));
    if (secondWaits) await waitsOnALock(secondPid, "the second actor");
    else await waitsOrFinishes(secondPid, secondRun);
    gate.open();
    const [firstDone, secondDone] = await Promise.all([firstRun, secondRun]);
    return { first: firstDone, second: secondDone };
  } finally {
    gate.open();
    await firstActor.end().catch(() => {});
    await secondPool.end().catch(() => {});
  }
}

const storeHealthrayBill = (patientId, items) =>
  query(
    `INSERT INTO giniflow_patient_bills (patient_id, bill_date, status, items, invoice_no, read_at)
     VALUES ($1, $2::date, 'billed', $3::jsonb, $4, NOW())
     ON CONFLICT (patient_id, bill_date) DO UPDATE
        SET status = 'billed', items = EXCLUDED.items, invoice_no = EXCLUDED.invoice_no,
            read_at = NOW()`,
    [patientId, ids.day, JSON.stringify(items), `HR-${tag}`],
  );

const syncTarget = (visitId) =>
  one(
    `SELECT v.id AS visit_id, v.patient_id, v.visit_date::text AS visit_date, v.current_status,
            NULL::text AS healthray_id, 'hr-' || v.patient_id AS hr_patient_id,
            FALSE AS refundable_open, FALSE AS tests_trimmed, p.name
       FROM giniflow_visits v JOIN patients p ON p.id = v.patient_id
      WHERE v.id = $1`,
    [visitId],
  );

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

const billedOrder = async (label) => {
  const { visit, patient } = await extraVisit(ids, label);
  const draft = await bills.openDraft(visit, desk, db);
  const order = await orderOf(visit, [
    { name: ids.hba1cName, price: 250 },
    { name: ids.lipidName, price: 400 },
  ]);
  await visitLines.linesForOrder(
    visit,
    { labOrderId: order, testNames: [ids.hba1cName, ids.lipidName] },
    desk,
    db,
  );
  return { visit, patient, order, billId: draft.id };
};

const repricedAndDead = (label) => [
  { category: "lab", desc: ids.hba1cName, amount: 300, itemId: `hb-${label}-${tag}` },
  {
    category: "lab",
    desc: ids.lipidName,
    amount: 400,
    itemId: `lipid-${label}-${tag}`,
    cancelled: true,
  },
];

const testsOf = async (orderId) =>
  (
    await query(
      `SELECT test_name, price::float AS price FROM giniflow_lab_order_tests
        WHERE lab_order_id = $1 ORDER BY test_name`,
      [orderId],
    )
  ).rows;

const syncCancelled = async (orderId) =>
  (
    await query(
      `SELECT test_name FROM giniflow_test_cancellations
        WHERE order_id = $1 AND source = 'healthray'`,
      [orderId],
    )
  ).rows.map((row) => row.test_name);

const BILL_LOCK_IN_CANCEL = /FROM bills\s+WHERE \(visit_id = \$1 AND status = 'draft'/;

const runSync = (visit) => (pool) => machineSync.syncMachineOrdersForVisit(visit, pool);

test.describe.serial("P4C-07b the sync, a pay-out and a charge cancel keep the lock order", () => {
  test.beforeAll(async () => {
    delete process.env[VALVE];
    ids = await setUp(tag);
    await payRule(ids, ids.pensioner, { name: "pensioner claims", patient_pays: "nothing" });
    ids.lipidName = `P4 Lipid ${tag}`;
    const lipidTest = await one(
      `INSERT INTO giniflow_test_catalog (test_name, price, category) VALUES ($1, 400, 'lab')
       RETURNING id`,
      [ids.lipidName],
    );
    ids.lipid = (
      await one(
        `INSERT INTO service_items (code, name, subgroup_id, base_price, kind, test_catalog_id)
         VALUES ($1, $2, $3, 400, 'test', $4) RETURNING id`,
        [`P4-LP-${tag}`, `Lipid ${tag}`, ids.subgroup, lipidTest.id],
      )
    ).id;
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

  test("1. the sync reprices an order and cancels a dead test while the desk takes the payment", async () => {
    const billed = await billedOrder("SyncPay");
    await storeHealthrayBill(billed.patient, repricedAndDead("pay"));
    const visit = await syncTarget(billed.visit);
    const before = await bills.readBill(billed.billId, db);
    const result = await race({
      first: runSync(visit),
      firstPattern: BILL_LOCK_IN_CANCEL,
      second: (pool) =>
        payments.takePayments(
          billed.billId,
          { version: before.version, mode: "card", amount: 650, reference: `P7B-${tag}` },
          desk,
          pool,
        ),
    });
    expect(result.first.error?.code, described(result.first)).not.toBe(DEADLOCK);
    expect(result.second.error?.code, described(result.second)).not.toBe(DEADLOCK);
    expect(result.first.ok, described(result.first)).toBe(true);
    if (!result.second.ok) {
      expect(result.second.error.status, described(result.second)).toBe(409);
      expect(result.second.error.message).toMatch(/changed while you were working/);
    }
    expect(await syncCancelled(billed.order)).toEqual([ids.lipidName]);
    expect(await testsOf(billed.order)).toEqual([{ test_name: ids.hba1cName, price: 300 }]);
    const bill = await bills.readBill(billed.billId, db);
    expect(bill.lines.map((line) => line.service_item_id)).toEqual([ids.hba1c]);
  });

  test("2. the sync cancels a dead test while the desk adds a line to the same draft", async () => {
    const billed = await billedOrder("SyncAdd");
    await storeHealthrayBill(billed.patient, repricedAndDead("add"));
    const visit = await syncTarget(billed.visit);
    const result = await race({
      first: runSync(visit),
      firstPattern: BILL_LOCK_IN_CANCEL,
      second: (pool) => bills.addLine(billed.billId, { item_id: ids.brace }, desk, pool),
      secondWaits: false,
    });
    expect(result.first.error?.code, described(result.first)).not.toBe(DEADLOCK);
    expect(result.second.error?.code, described(result.second)).not.toBe(DEADLOCK);
    expect(result.first.ok, described(result.first)).toBe(true);
    expect(result.second.ok, described(result.second)).toBe(true);
    expect(await syncCancelled(billed.order)).toEqual([ids.lipidName]);
    const bill = await bills.readBill(billed.billId, db);
    expect(bill.lines.map((line) => line.service_item_id).sort()).toEqual(
      [ids.hba1c, ids.brace].sort(),
    );
  });

  test("3. paying out a credit note while the floor cancels a test on both bills", async () => {
    let setup = null;
    for (let tries = 0; tries < 12 && !setup; tries += 1) {
      const billed = await billedOrder(`PayOut${tries}`);
      const draft = await bills.readBill(billed.billId, db);
      const paid = await payments.takePayments(
        billed.billId,
        { version: draft.version, mode: "card", amount: 650, reference: `P7B-${tag}-${tries}` },
        desk,
        db,
      );
      const final = await bills.finaliseBill(billed.billId, { version: paid.version }, desk, db);
      const lipidLine = final.lines.find((line) => line.service_item_id === ids.lipid);
      const approved = await refundApproved(final.id, [{ line_id: lipidLine.id }]);
      const note = approved.credit_note;
      if (note.id < final.id) setup = { order: billed.order, note, original: final.id };
    }
    expect(setup).not.toBeNull();
    const held = await query(
      `SELECT DISTINCT bill_id FROM bill_lines WHERE lab_order_id = $1 ORDER BY bill_id`,
      [setup.order],
    );
    expect(held.rows.map((row) => row.bill_id)).toEqual([setup.note.id, setup.original]);

    const result = await race({
      first: (pool) =>
        payments.payOut(
          setup.note.id,
          {
            version: setup.note.version,
            payments: [{ mode: "card", amount: 400, reference: `REV-${tag}` }],
          },
          desk,
          pool,
        ),
      firstPattern: /FROM bills WHERE id = \$1 FOR UPDATE/,
      nth: 2,
      second: (pool) =>
        testCancel.cancelTest(
          {
            target: { orderId: setup.order },
            reason: "patient_declined",
            source: "station",
            actorId: USERS.reception.id,
            actorRole: "reception",
          },
          pool,
        ),
    });
    expect(result.first.error?.code, described(result.first)).not.toBe(DEADLOCK);
    expect(result.second.error?.code, described(result.second)).not.toBe(DEADLOCK);
    expect(result.first.ok, described(result.first)).toBe(true);
    expect(result.first.value.totals).toMatchObject({ refunded: 40000, due: 0 });
    if (!result.second.ok) expect(result.second.error.status, described(result.second)).toBe(409);
  });

  test("4. the floor cancels a HealthRay charge while the sync reprices it", async () => {
    const { visit, patient } = await extraVisit(ids, "Charge");
    const itemName = `P4 Knee view ${tag}`;
    const charge = await one(
      `INSERT INTO giniflow_bill_charges (visit_id, item_name, amount) VALUES ($1, $2, 500)
       RETURNING id`,
      [visit, itemName],
    );
    await storeHealthrayBill(patient, [
      { category: "imaging", desc: itemName, amount: 600, itemId: `xr-${tag}` },
    ]);
    const target = await syncTarget(visit);
    const result = await race({
      first: (pool) =>
        testCancel.cancelTest(
          {
            target: { chargeId: charge.id },
            reason: "patient_declined",
            source: "station",
            actorId: USERS.reception.id,
            actorRole: "reception",
          },
          pool,
        ),
      firstPattern: /FOR NO KEY UPDATE|FOR UPDATE OF c/,
      nth: 2,
      second: runSync(target),
    });
    expect(result.first.error?.code, described(result.first)).not.toBe(DEADLOCK);
    expect(result.second.error?.code, described(result.second)).not.toBe(DEADLOCK);
    expect(result.first.ok, described(result.first)).toBe(true);
    expect(result.second.ok, described(result.second)).toBe(true);
    const left = await query(`SELECT id FROM giniflow_bill_charges WHERE visit_id = $1`, [visit]);
    expect(left.rows).toEqual([]);
    const cancelled = await one(
      `SELECT kind, test_name FROM giniflow_test_cancellations WHERE charge_id = $1`,
      [charge.id],
    );
    expect(cancelled).toMatchObject({ kind: "charge", test_name: itemName });
  });
});
