import fs from "node:fs";
import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../../helpers/db.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { desk, labOrder, newTag, refused, setUp, tearDown } from "./p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");
const visitLines = await import("../../../server/services/billing/visitLines.js");

const db = getPool();
const tag = newTag();
let ids;

const linesOf = (billId) =>
  query(
    `SELECT bill_name, service_item_id, source, lab_order_id, actual_amount
       FROM bill_lines WHERE bill_id = $1 AND is_live ORDER BY line_no`,
    [billId],
  ).then((r) => r.rows);

const draftOf = () =>
  one(`SELECT id FROM bills WHERE visit_id = $1 AND status = 'draft'`, [ids.visit]);

test.describe.serial("P4-08 lines from test orders", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
  });

  test.afterAll(async () => {
    await tearDown(ids);
  });

  test("1. ordering HbA1c and ABI adds two lines", async () => {
    ids.order = await labOrder(ids, [ids.hba1cName, ids.abiName]);
    const result = await visitLines.linesForOrder(
      ids.visit,
      { labOrderId: ids.order, testNames: [ids.hba1cName, ids.abiName] },
      desk,
      db,
    );
    expect(result.ok).toBe(true);
    expect(result.added).toEqual([ids.hba1cName, ids.abiName]);
    expect(result.not_priced).toEqual([]);
    const draft = await draftOf();
    const lines = await linesOf(draft.id);
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.service_item_id)).toEqual([ids.hba1c, ids.abi]);
    expect(lines.every((l) => l.source === "lab_order" && l.lab_order_id === ids.order)).toBe(true);
    expect(lines.map((l) => Number(l.actual_amount))).toEqual([250, 400]);
    const { patient_payable: payable } = await one(
      `SELECT patient_payable FROM bills WHERE id = $1`,
      [draft.id],
    );
    expect(Number(payable)).toBe(650);
  });

  test("2. a test with no item is reported, never silently skipped", async () => {
    const order = await labOrder(ids, [ids.looseName]);
    const result = await visitLines.linesForOrder(
      ids.visit,
      { labOrderId: order, testNames: [ids.looseName] },
      desk,
      db,
    );
    expect(result.ok).toBe(true);
    expect(result.added).toEqual([]);
    expect(result.not_priced).toEqual([ids.looseName]);
    expect(await visitLines.notPricedForVisit(ids.visit, db)).toContain(ids.looseName);
    await query(`DELETE FROM giniflow_lab_orders WHERE id = $1`, [order]);
  });

  test("3. a failure never blocks the order", async () => {
    const result = await visitLines.linesForOrder(
      "11111111-1111-1111-1111-111111111111",
      { labOrderId: ids.order, testNames: [ids.hba1cName] },
      desk,
      db,
    );
    expect(result.added).toEqual([]);
    expect(result.skipped[0].message).toMatch(/visit/i);
    const broken = await visitLines.linesForOrder(
      ids.visit,
      { labOrderId: "not-an-order", testNames: [ids.hba1cName] },
      desk,
      db,
    );
    expect(broken.added).toEqual([]);
    expect(broken.skipped[0].message).toMatch(/test order/i);
  });

  test("4. a later order opens a new draft once every earlier bill is final", async () => {
    const draft = await draftOf();
    await query(
      `UPDATE bills SET status = 'final', bill_no = $2, series = 'MAIN', fy = $3,
              finalised_at = NOW() WHERE id = $1`,
      [draft.id, `P4-${tag}-0001`, ids.fy],
    );
    const order = await labOrder(ids, [ids.hba1cName]);
    const result = await visitLines.linesForOrder(
      ids.visit,
      { labOrderId: order, testNames: [ids.hba1cName] },
      desk,
      db,
    );
    expect(result.added).toEqual([]);
    expect(result.skipped[0].message).toMatch(new RegExp(`Already billed on bill P4-${tag}-0001`));
    const second = await visitLines.linesForOrder(
      ids.visit,
      { labOrderId: order, testNames: [ids.looseName] },
      desk,
      db,
    );
    expect(second.bill_id).toBeNull();
    const fresh = await one(
      `INSERT INTO service_items (code, name, subgroup_id, base_price, kind, test_catalog_id)
       VALUES ($1, $2, $3, 300, 'test', $4) RETURNING id`,
      [`P4-LO-${tag}`, `P4 Loose ${tag}`, ids.subgroup, ids.looseTest],
    );
    const third = await visitLines.linesForOrder(
      ids.visit,
      { labOrderId: order, testNames: [ids.looseName] },
      desk,
      db,
    );
    expect(third.added).toEqual([ids.looseName]);
    const next = await draftOf();
    expect(next.id).not.toBe(draft.id);
    const lines = await linesOf(next.id);
    expect(lines.map((l) => l.service_item_id)).toEqual([fresh.id]);
    ids.finalBill = draft.id;
    ids.secondBill = next.id;
    ids.secondOrder = order;
  });

  test("5. cancelling a test takes its draft line off the bill", async () => {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const removed = await visitLines.releaseOrderLines(client, ids.secondOrder);
      expect(removed.removed).toHaveLength(1);
      await client.query(`DELETE FROM giniflow_lab_orders WHERE id = $1`, [ids.secondOrder]);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    expect(await linesOf(ids.secondBill)).toEqual([]);
    const { count } = await one(
      `SELECT COUNT(*)::int AS count FROM giniflow_lab_orders WHERE id = $1`,
      [ids.secondOrder],
    );
    expect(count).toBe(0);
  });

  test("6. a test already on a final bill refuses the cancel", async () => {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await refused(
        visitLines.releaseOrderLines(client, ids.order),
        409,
        /is on bill P4-/,
        "a final bill's test",
      );
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    expect(await linesOf(ids.finalBill)).toHaveLength(2);
  });

  test("7. every path that raises an order adds its lines the same way", async () => {
    const paths = [
      "server/services/giniflow/moStation.js",
      "server/services/giniflow/machineStation.js",
      "server/services/giniflow/journey.js",
      "server/services/giniflow/machineSync.js",
    ];
    for (const path of paths) {
      const source = fs.readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
      expect(source, path).toMatch(/await linesForOrder\(/);
    }
    const cancel = fs.readFileSync(
      new URL("../../../server/services/giniflow/testCancel.js", import.meta.url),
      "utf8",
    );
    expect(cancel).toMatch(/await releaseOrderLines\(/);
  });

  test("8. the bill reads back with its lines and codes", async () => {
    const bill = await bills.readBill(ids.finalBill, db);
    expect(bill.status).toBe("final");
    expect(bill.lines.map((l) => l.bill_name)).toEqual([`HbA1c ${tag}`, `ABI ${tag}`]);
    expect(bill.codes).toEqual([]);
  });
  test("9. a test on a cancelled bill can still be taken off the floor", async () => {
    await bills.cancelBill(
      ids.finalBill,
      { reason: "The bill was made for the wrong patient" },
      desk,
      db,
    );
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const released = await visitLines.releaseOrderLines(client, ids.order, null, desk);
      expect(released.removed).toEqual([]);
      await client.query(`DELETE FROM giniflow_lab_orders WHERE id = $1`, [ids.order]);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    const { count } = await one(
      `SELECT COUNT(*)::int AS count FROM giniflow_lab_orders WHERE id = $1`,
      [ids.order],
    );
    expect(count).toBe(0);
    const { rows } = await query(
      `SELECT lab_order_id, is_live FROM bill_lines WHERE bill_id = $1`,
      [ids.finalBill],
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.lab_order_id === null && row.is_live === false)).toBe(true);
  });

  test("10. a test that can't be priced never takes the order down with it", async () => {
    ids.broken = `p4bad-${tag}`;
    await query(`INSERT INTO patient_schemes (code, label) VALUES ($1, $2)`, [
      ids.broken,
      `P4 Broken ${tag}`,
    ]);
    await query(
      `INSERT INTO category_payment_rules (scheme_code, name, service_item_id, patient_pays,
                                           remainder)
       VALUES ($1, $2, $3, 'nothing', 'claim')`,
      [ids.broken, `P4 broken rule ${tag}`, ids.hba1c],
    );
    await query(`UPDATE bills SET scheme_code = $2 WHERE id = $1`, [ids.secondBill, ids.broken]);
    const client = await db.connect();
    let order;
    try {
      await client.query("BEGIN");
      order = (
        await client.query(
          `INSERT INTO giniflow_lab_orders (visit_id, urgency, payment_status, amount_total,
                                            sample_status, kind)
           VALUES ($1, 'today', 'pending', 650, 'payment_pending', 'lab') RETURNING id`,
          [ids.visit],
        )
      ).rows[0].id;
      const result = await visitLines.linesForOrder(
        ids.visit,
        { labOrderId: order, testNames: [ids.hba1cName, ids.abiName] },
        desk,
        client,
      );
      expect(result.added).toEqual([ids.abiName]);
      expect(result.skipped.map((entry) => entry.test)).toEqual([ids.hba1cName]);
      expect(result.skipped[0].message).toMatch(/payer name/i);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    const { count } = await one(
      `SELECT COUNT(*)::int AS count FROM giniflow_lab_orders WHERE id = $1`,
      [order],
    );
    expect(count).toBe(1);
    const lines = await linesOf(ids.secondBill);
    expect(lines.map((line) => line.service_item_id)).toEqual([ids.abi]);
    ids.brokenOrder = order;
  });

  test("11. taking a billed test off the bill is audited, and an empty order is harmless", async () => {
    const line = await one(`SELECT id FROM bill_lines WHERE lab_order_id = $1`, [ids.brokenOrder]);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const released = await visitLines.releaseOrderLines(client, ids.brokenOrder, null, desk);
      expect(released.removed).toEqual([`ABI ${tag}`]);
      await client.query(`DELETE FROM giniflow_lab_orders WHERE id = $1`, [ids.brokenOrder]);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    const audit = await one(
      `SELECT action, actor_id, after FROM billing_audit
        WHERE entity = 'bill_lines' AND entity_id = $1 ORDER BY id DESC LIMIT 1`,
      [line.id],
    );
    expect(audit).toMatchObject({ action: "delete", actor_id: desk.actorId });
    expect(audit.after.reason).toMatch(/cancelled on the floor/i);
    expect(await linesOf(ids.secondBill)).toEqual([]);

    const second = await db.connect();
    let order;
    try {
      await second.query("BEGIN");
      order = (
        await second.query(
          `INSERT INTO giniflow_lab_orders (visit_id, urgency, payment_status, amount_total,
                                            sample_status, kind)
           VALUES ($1, 'today', 'pending', 0, 'payment_pending', 'lab') RETURNING id`,
          [ids.visit],
        )
      ).rows[0].id;
      const result = await visitLines.linesForOrder(
        ids.visit,
        { labOrderId: order, testNames: null },
        desk,
        second,
      );
      expect(result.added).toEqual([]);
      await second.query(`DELETE FROM giniflow_lab_orders WHERE id = $1`, [order]);
      await second.query("COMMIT");
    } finally {
      second.release();
    }
    await query(`UPDATE bills SET scheme_code = NULL WHERE id = $1`, [ids.secondBill]);
    await query(`DELETE FROM category_payment_rules WHERE scheme_code = $1`, [ids.broken]);
    await query(`DELETE FROM patient_schemes WHERE code = $1`, [ids.broken]);
  });
});
