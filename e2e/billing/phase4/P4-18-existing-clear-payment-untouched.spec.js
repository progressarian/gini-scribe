import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../../helpers/db.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { desk, extraVisit, newTag, setUp, tearDown } from "./p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");
const payments = await import("../../../server/services/billing/payments.js");
const shifts = await import("../../../server/services/billing/cashShifts.js");
const visitLines = await import("../../../server/services/billing/visitLines.js");
const reception = await import("../../../server/services/giniflow/receptionStation.js");
const labStation = await import("../../../server/services/giniflow/labStation.js");
const labPayment = await import("../../../shared/labPayment.js");

const db = getPool();
const tag = newTag();
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const STATION = "server/services/giniflow/receptionStation.js";
const GATE = "shared/labPayment.js";
const GUARDED = ["getPaymentQueue", "clearPayment"];
let ids;

const bodyOf = (source, name) => {
  const start = source.indexOf(`export async function ${name}(`);
  expect(start, `${name} is no longer in ${STATION}`).toBeGreaterThan(-1);
  const end = source.indexOf("\n}\n", start);
  return source.slice(start, end + 2);
};

const digest = (text) => crypto.createHash("md5").update(text).digest("hex");

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
    `SELECT payment_status, sample_status, amount_total, amount_paid, amount_claimed, claim_state,
            version FROM giniflow_lab_orders WHERE id = $1`,
    [id],
  );

const pricedOrder = async (visit, name, price) => {
  const order = await one(
    `INSERT INTO giniflow_lab_orders (visit_id, urgency, payment_status, amount_total,
                                      sample_status, kind)
     VALUES ($1, 'today', 'pending', $2, 'payment_pending', 'lab') RETURNING id`,
    [visit, price],
  );
  await query(
    `INSERT INTO giniflow_lab_order_tests (lab_order_id, test_name, price) VALUES ($1, $2, $3)`,
    [order.id, name, price],
  );
  return order.id;
};

const clear = (orderId, extra = {}) =>
  reception.clearPayment(
    orderId,
    { method: "paid", actorId: USERS.reception.id, confirmNotOnBill: true, ...extra },
    db,
  );

const queueEntry = async (orderId) => {
  const queue = await reception.getPaymentQueue(ids.day, db);
  const lists = ["pending", "awaitingSample", "cleared"];
  for (const list of lists) {
    const found = queue[list].find((row) => row.orderId === orderId);
    if (found) return { list, order: found };
  }
  return { list: null, order: null };
};

test.describe.serial("P4-18 the existing Clear payment is untouched", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    await closeOpenShifts();
    ids.shift = (await shifts.openShift({ opening_cash: 0 }, desk, db)).id;
  });

  test.afterAll(async () => {
    await tearDown(ids);
    await closeOpenShifts();
    await query(`DELETE FROM cash_shifts WHERE user_id = $1`, [USERS.reception.id]).catch(() => {});
  });

  test("1. clearPayment and getPaymentQueue are exactly what the repository holds", async () => {
    const atHead = (file) =>
      execFileSync("git", ["show", `HEAD:${file}`], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      });
    const working = fs.readFileSync(path.join(repoRoot, STATION), "utf8");
    const committed = atHead(STATION);
    expect(
      digest(fs.readFileSync(path.join(repoRoot, GATE), "utf8")),
      `the gate code in ${GATE} has been edited`,
    ).toBe(digest(atHead(GATE)));
    for (const name of GUARDED) {
      expect(digest(bodyOf(working, name)), `${name} has been edited`).toBe(
        digest(bodyOf(committed, name)),
      );
    }
    expect(digest(bodyOf(working, "getPaymentQueue"))).toBe("c7e6c3f66a2c37d919dea2862aa14c50");
    expect(digest(bodyOf(working, "clearPayment"))).toBe("5f9a03a44cdf720b5cc7673258346ce9");
  });

  test("2. clearing a payment at reception still opens the lab gate", async () => {
    const { visit } = await extraVisit(ids, "Desk");
    ids.deskOrder = await pricedOrder(visit, ids.looseName, 300);
    const before = await queueEntry(ids.deskOrder);
    expect(before.list).toBe("pending");
    expect(before.order.outstanding).toBe(300);

    const cleared = await clear(ids.deskOrder);
    expect(cleared).toMatchObject({ paymentStatus: "paid", outstanding: 0, alreadySettled: false });
    const after = await orderRow(ids.deskOrder);
    expect(after).toMatchObject({ payment_status: "paid", sample_status: "paid" });
    expect(labPayment.opensLabGate(after.payment_status)).toBe(true);
    expect((await queueEntry(ids.deskOrder)).list).toBe("awaitingSample");
    const drawn = await labStation.advanceSample(
      ids.deskOrder,
      { to: "drawing", actorId: USERS.lab.id },
      db,
    );
    expect(drawn.sampleStatus).toBe("drawing");
    expect((await queueEntry(ids.deskOrder)).list).toBe("cleared");
  });

  test("3. an order the bill already paid through is not collected again at reception", async () => {
    const { visit } = await extraVisit(ids, "Billed");
    const order = await pricedOrder(visit, ids.hba1cName, 250);
    const raised = await visitLines.linesForOrder(
      visit,
      { labOrderId: order, testNames: [ids.hba1cName] },
      desk,
      db,
    );
    const draft = await bills.readBill(raised.bill_id, db);
    await payments.takePayments(
      draft.id,
      { version: draft.version, mode: "cash", amount: 250 },
      desk,
      db,
    );
    const settled = await orderRow(order);
    expect(settled.payment_status).toBe("paid");

    const again = await clear(order);
    expect(again).toMatchObject({ alreadySettled: true, outstanding: 0 });
    const after = await orderRow(order);
    expect(Number(after.amount_paid)).toBe(250);
    expect(after.version).toBe(settled.version);
    const { taken } = await one(
      `SELECT COALESCE(SUM(amount), 0)::numeric AS taken FROM payments WHERE bill_id = $1`,
      [draft.id],
    );
    expect(Number(taken)).toBe(250);
  });

  test("4. an order reception cleared is left alone by the bill — but the patient can still be charged twice", async () => {
    const { visit } = await extraVisit(ids, "Twice");
    const order = await pricedOrder(visit, ids.hba1cName, 250);
    const raised = await visitLines.linesForOrder(
      visit,
      { labOrderId: order, testNames: [ids.hba1cName] },
      desk,
      db,
    );
    await clear(order);
    const cleared = await orderRow(order);
    expect(Number(cleared.amount_paid)).toBe(250);

    const draft = await bills.readBill(raised.bill_id, db);
    expect(draft.totals.payable).toBe(25000);
    const paid = await payments.takePayments(
      draft.id,
      { version: draft.version, mode: "cash", amount: 250 },
      desk,
      db,
    );
    expect(paid.orders).toHaveLength(0);
    const after = await orderRow(order);
    expect(Number(after.amount_paid)).toBe(250);
    expect(after.version).toBe(cleared.version);

    const { taken } = await one(
      `SELECT COALESCE(SUM(amount), 0)::numeric AS taken FROM payments WHERE bill_id = $1`,
      [draft.id],
    );
    expect(Number(taken)).toBe(250);
    expect(Number(taken) + Number(after.amount_paid)).toBe(500);
  });

  test("5. an order the bill settled looks exactly like one reception cleared", async () => {
    const billed = await extraVisit(ids, "Same");
    const byBill = await pricedOrder(billed.visit, ids.hba1cName, 250);
    const raised = await visitLines.linesForOrder(
      billed.visit,
      { labOrderId: byBill, testNames: [ids.hba1cName] },
      desk,
      db,
    );
    const draft = await bills.readBill(raised.bill_id, db);
    await payments.takePayments(
      draft.id,
      { version: draft.version, mode: "cash", amount: 250 },
      desk,
      db,
    );
    const atDesk = await extraVisit(ids, "Samedesk");
    const byDesk = await pricedOrder(atDesk.visit, ids.hba1cName, 250);
    await clear(byDesk);

    const whole = (id) => one(`SELECT * FROM giniflow_lab_orders WHERE id = $1`, [id]);
    const ledger = async (id) =>
      (
        await query(
          `SELECT track, status, actor_role FROM giniflow_lab_order_events
            WHERE lab_order_id = $1 ORDER BY occurred_at, seq`,
          [id],
        )
      ).rows;
    const ownColumns = new Set(["id", "visit_id", "created_at", "updated_at", "ordered_by"]);
    const money = (row) =>
      Object.fromEntries(Object.entries(row).filter(([key]) => !ownColumns.has(key)));
    expect(money(await whole(byBill))).toEqual(money(await whole(byDesk)));
    expect(await ledger(byBill)).toEqual(await ledger(byDesk));
  });
});
