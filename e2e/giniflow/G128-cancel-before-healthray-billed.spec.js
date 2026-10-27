import { test, expect } from "@playwright/test";
import { one, query } from "../helpers/db.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { USERS } from "../fixtures/data.mjs";
import {
  extraVisit,
  healthrayBill,
  newTag,
  noHealthrayBill,
  setUp,
  tearDown,
} from "../billing/phase4/p4-bills-fixture.mjs";
import { db } from "../billing/phase4b/p4b-refunds.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const { cancelTest, billSuppressor } = await import("../../server/services/giniflow/testCancel.js");

const tag = newTag();
const CONSULT = { desc: "New Appointment", amount: 1500, category: "consultation", itemId: 1 };
const ABI_LINE = {
  desc: "ABI,VPT,Fundus",
  amount: 800,
  category: "machine",
  invoice: "OPD/T-30",
  itemId: 9,
};
const lineRef = ({ itemId, invoice, desc, amount }) => ({ itemId, invoice, desc, amount });
let ids;

async function abiOrder(visit) {
  const order = await one(
    `INSERT INTO giniflow_lab_orders (visit_id, urgency, payment_status, amount_total,
                                      amount_paid, sample_status, kind)
     VALUES ($1, 'today', 'pending', 500, 0, 'payment_pending', 'machine') RETURNING id`,
    [visit],
  );
  await query(
    `INSERT INTO giniflow_lab_order_tests (lab_order_id, test_name, price) VALUES ($1, 'ABI', 500)`,
    [order.id],
  );
  return order.id;
}

const cancelAbi = (orderId) =>
  cancelTest(
    {
      target: { orderId },
      reason: "billed_by_mistake",
      source: "reception",
      stationLabel: "reception",
      actorId: USERS.reception.id,
      actorRole: "reception",
      skipRefund: true,
    },
    db,
  );

const blocks = async (visit, line) =>
  (await billSuppressor(db, visit))({ kind: "machine", machineId: "abi", line });

test.describe
  .serial("G128 a test cancelled before HealthRay billed it comes back when it is billed", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
  });

  test.afterAll(async () => {
    await tearDown(ids);
  });

  test("1. cancelled while the read HealthRay bill had no such line, a later HealthRay line is not blocked", async () => {
    const { patient, visit } = await extraVisit(ids, "Later");
    await healthrayBill(ids, patient, [CONSULT]);
    await cancelAbi(await abiOrder(visit));
    const row = await one(`SELECT bill_line FROM giniflow_test_cancellations WHERE visit_id = $1`, [
      visit,
    ]);
    expect(row.bill_line).toEqual({ notOnBill: true });
    expect(await blocks(visit, lineRef(ABI_LINE))).toBe(false);
  });

  test("2. cancelled while HealthRay had the line, that same line stays blocked", async () => {
    const { patient, visit } = await extraVisit(ids, "Same");
    await healthrayBill(ids, patient, [CONSULT, ABI_LINE]);
    await cancelAbi(await abiOrder(visit));
    expect(await blocks(visit, lineRef(ABI_LINE))).toBe(true);
    expect(await blocks(visit, lineRef({ ...ABI_LINE, itemId: 10, invoice: "OPD/T-31" }))).toBe(
      false,
    );
  });

  test("3. cancelled before any HealthRay bill was read, every line stays blocked as before", async () => {
    const { patient, visit } = await extraVisit(ids, "Unread");
    await noHealthrayBill(ids, patient);
    await cancelAbi(await abiOrder(visit));
    expect(await blocks(visit, lineRef(ABI_LINE))).toBe(true);
  });
});
