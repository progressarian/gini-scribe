import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../../helpers/db.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import {
  desk,
  discountCode,
  extraVisit,
  labOrder,
  newTag,
  noHealthrayBill,
  setUp,
  tearDown,
} from "../phase4/p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");
const { withHomeDiscount, testPricesFor } = await import("../../../server/services/pricing.js");
const { repriceOpenLabOrders } =
  await import("../../../server/services/giniflow/homeOrderPrices.js");
const { getPaymentQueue } = await import("../../../server/services/giniflow/receptionStation.js");
const { HOME_COLLECTION_CODE } = await import("../../../shared/billingVocab.js");

const db = getPool();
const tag = newTag();
const labCtx = { actorId: null, ip: "10.9.4.2", role: "lab" };
let ids;
let home;
let plain;

const codeLines = (billId) =>
  query(
    `SELECT l.service_item_id, d.code, d.amount FROM bill_line_discounts d
       JOIN bill_lines l ON l.id = d.bill_line_id
      WHERE l.bill_id = $1 AND l.is_live AND d.code IS NOT NULL`,
    [billId],
  ).then((r) => r.rows);

const markHome = (visitId) =>
  query(`UPDATE giniflow_visits SET lab_site = 'home' WHERE id = $1`, [visitId]);

test.describe.serial("P5-15 home collection discount", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    const clash = await one(
      `SELECT count(*)::int AS n FROM discount_rules WHERE lower(code) = lower($1)`,
      [HOME_COLLECTION_CODE],
    );
    if (clash.n) throw new Error(`${HOME_COLLECTION_CODE} already exists in the test database`);
    ids.rule = await discountCode(ids, HOME_COLLECTION_CODE, {
      kind: "percent",
      value: 10,
      service_item_ids: [ids.hba1c],
    });
    home = await extraVisit(ids, "Home");
    plain = await extraVisit(ids, "Plain");
    await markHome(home.visit);
  });

  test.afterAll(async () => {
    await tearDown(ids);
  });

  test("1. a home-collection bill gets the code on its lab test only", async () => {
    const draft = await bills.openDraft(home.visit, desk, db);
    home.bill = draft.id;
    await bills.addLine(home.bill, { item_id: ids.hba1c }, desk, db);
    const bill = await bills.addLine(home.bill, { item_id: ids.brace }, desk, db);
    expect(bill.codes).toEqual([HOME_COLLECTION_CODE]);
    const lines = await codeLines(home.bill);
    expect(lines).toHaveLength(1);
    expect(lines[0].service_item_id).toBe(ids.hba1c);
    expect(Number(lines[0].amount)).toBe(25);
    const audit = await one(
      `SELECT count(*)::int AS n FROM billing_audit
        WHERE entity = 'bills' AND entity_id = $1
          AND after->>'reason' = 'Home collection discount applied automatically'`,
      [home.bill],
    );
    expect(audit.n).toBe(1);
  });

  test("2. a visit that is not home collection gets nothing", async () => {
    const draft = await bills.openDraft(plain.visit, desk, db);
    plain.bill = draft.id;
    const bill = await bills.addLine(plain.bill, { item_id: ids.hba1c }, desk, db);
    expect(bill.codes).toEqual([]);
    expect(await codeLines(plain.bill)).toHaveLength(0);
  });

  test("3. a reprice by a non-desk role keeps the code", async () => {
    const bill = await bills.addLine(home.bill, { item_id: ids.dressing }, labCtx, db);
    expect(bill.codes).toEqual([HOME_COLLECTION_CODE]);
    expect(await codeLines(home.bill)).toHaveLength(1);
  });

  test("4. removing it keeps it off while the bill changes", async () => {
    let bill = await bills.removeCode(home.bill, { code: HOME_COLLECTION_CODE }, desk, db);
    expect(bill.codes).toEqual([]);
    expect(bill.home_code_removed).toBe(true);
    const row = await one(
      `SELECT home_code_removed_at IS NOT NULL AS removed, home_code_removed_by FROM bills WHERE id = $1`,
      [home.bill],
    );
    expect(row.removed).toBe(true);
    expect(row.home_code_removed_by).toBe(desk.actorId);
    bill = await bills.addLine(home.bill, { item_id: ids.abi }, desk, db);
    expect(bill.codes).toEqual([]);
    expect(await codeLines(home.bill)).toHaveLength(0);
  });

  test("5. entering the code again turns it back on", async () => {
    const bill = await bills.addCode(home.bill, { code: HOME_COLLECTION_CODE }, desk, db);
    expect(bill.codes).toEqual([HOME_COLLECTION_CODE]);
    expect(bill.home_code_removed).toBe(false);
    const dressing = await one(
      `SELECT id FROM bill_lines WHERE bill_id = $1 AND service_item_id = $2 AND is_live`,
      [home.bill, ids.dressing],
    );
    const again = await bills.changeQuantity(home.bill, dressing.id, { quantity: 2 }, labCtx, db);
    expect(again.codes).toEqual([HOME_COLLECTION_CODE]);
  });

  test("6. floor prices: lab test 10% off at home, other tests and other visits untouched", async () => {
    const listed = await testPricesFor([ids.hba1cName, ids.abiName], null, db);
    expect(listed[ids.hba1cName]).toBe(250);
    const atHome = await withHomeDiscount(home.visit, listed, db);
    expect(atHome[ids.hba1cName]).toBe(225);
    expect(atHome[ids.abiName]).toBe(400);
    const notHome = await withHomeDiscount(plain.visit, listed, db);
    expect(notHome[ids.hba1cName]).toBe(250);
  });

  test("7. an unpaid order is repriced once the visit is home; a paid one is not", async () => {
    const late = await extraVisit(ids, "Late", { healthray: false });
    const visitIds = { ...ids, visit: late.visit };
    const open = await labOrder(visitIds, [ids.hba1cName]);
    const paid = await labOrder(visitIds, [ids.hba1cName]);
    await query(`UPDATE giniflow_lab_order_tests SET price = 250 WHERE lab_order_id = ANY($1)`, [
      [open, paid],
    ]);
    await query(`UPDATE giniflow_lab_orders SET amount_total = 250 WHERE id = ANY($1)`, [
      [open, paid],
    ]);
    await query(
      `UPDATE giniflow_lab_orders SET payment_status = 'paid', amount_paid = 250 WHERE id = $1`,
      [paid],
    );
    await markHome(late.visit);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      expect(await repriceOpenLabOrders(client, late.visit)).toBe(1);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    const totals = await query(
      `SELECT id, amount_total FROM giniflow_lab_orders WHERE id = ANY($1)`,
      [[open, paid]],
    );
    const byId = Object.fromEntries(totals.rows.map((r) => [r.id, Number(r.amount_total)]));
    expect(byId[open]).toBe(225);
    expect(byId[paid]).toBe(250);

    const queue = await getPaymentQueue(ids.day, db);
    const shown = queue.pending.find((o) => o.orderId === open);
    expect(shown?.homeDiscount).toBe(25);
    expect(shown?.total).toBe(225);
  });

  test("8. a HealthRay-billed visit is never repriced from the catalogue", async () => {
    const billed = await extraVisit(ids, "Billed");
    const order = await labOrder({ ...ids, visit: billed.visit }, [ids.hba1cName]);
    await markHome(billed.visit);
    const client = await db.connect();
    try {
      expect(await repriceOpenLabOrders(client, billed.visit)).toBe(0);
    } finally {
      client.release();
    }
    const row = await one(`SELECT amount_total FROM giniflow_lab_orders WHERE id = $1`, [order]);
    expect(Number(row.amount_total)).toBe(0);
    await noHealthrayBill(ids, billed.patient);
  });
});
