import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../helpers/db.mjs";
import { apiAs } from "../helpers/auth.mjs";
import { USERS } from "../fixtures/data.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { extraVisit, newTag, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const items = await import("../../server/services/billing/serviceItems.js");
const mo = await import("../../server/services/giniflow/moStation.js");
const lab = await import("../../server/services/giniflow/labStation.js");
const hold = await import("../../server/services/giniflow/testsHold.js");
const engine = await import("../../server/services/giniflow/statusEngine.js");

const db = getPool();
const tag = newTag();
const admin = { actorId: USERS.admin.id, ip: "10.9.6.62", role: "admin" };
let ids;
let visit;
let outsideOrder;
let inHouseOrder;

const ordersOf = (visitId) =>
  query(
    `SELECT o.id, o.is_outsourced, o.sample_status,
            array_agg(t.test_name ORDER BY t.test_name) AS tests
       FROM giniflow_lab_orders o JOIN giniflow_lab_order_tests t ON t.lab_order_id = o.id
      WHERE o.visit_id = $1 GROUP BY o.id ORDER BY o.is_outsourced`,
    [visitId],
  ).then((r) => r.rows);

const markPaid = (orderId) =>
  query(
    `UPDATE giniflow_lab_orders
        SET payment_status = 'paid', sample_status = 'paid', amount_paid = amount_total
      WHERE id = $1`,
    [orderId],
  );

const advance = (orderId, to, room = null) =>
  lab.advanceSample(orderId, { to, actorId: USERS.lab.id, room }, db);

const collect = async (orderId) => {
  await advance(orderId, "drawing", "collection");
  await advance(orderId, "sample_collected", "collection");
};

const refusal = (promise) => promise.then(() => null).catch((error) => error);

const queueOrder = async (room, orderId) => {
  const data = await lab.getLabQueue(ids.day, null, db, { room });
  const buckets = Object.values(data).filter((v) => Array.isArray(v));
  return buckets.flat().find((row) => row?.orderId === orderId) ?? null;
};

test.describe.serial("G62 an outsourced test is sent out and never holds the patient", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    await items.updateItem(ids.hba1c, { is_outsourced: true }, admin, db);
    ({ visit } = await extraVisit(ids, "Outside"));
  });

  test.afterAll(async () => {
    await tearDown(ids);
  });

  test("1. ordering puts the outsourced test in its own order", async () => {
    await mo.orderTests(
      visit,
      { urgency: "today", tests: [ids.hba1cName, ids.looseName], actorId: USERS.admin.id },
      db,
    );
    const orders = await ordersOf(visit);
    expect(orders.map((o) => [o.is_outsourced, o.tests])).toEqual([
      [false, [ids.looseName]],
      [true, [ids.hba1cName]],
    ]);
    inHouseOrder = orders[0].id;
    outsideOrder = orders[1].id;
    await markPaid(inHouseOrder);
    await markPaid(outsideOrder);
  });

  test("2. after collection the collection room offers Send to outside lab; the bench never sees it", async () => {
    await collect(outsideOrder);
    const card = await queueOrder("collection", outsideOrder);
    expect(card.outsourced).toBe(true);
    expect(card.nextAction).toEqual({ to: "sent_outside", label: "📮 Mark sent to outside lab" });
    expect(await queueOrder("processing", outsideOrder)).toBeNull();
  });

  test("3. the in-house ladder is refused for an outsourced order, and the other way round", async () => {
    const wrongWay = await refusal(advance(outsideOrder, "sample_sent", "collection"));
    expect(wrongWay?.status).toBe(409);
    expect(wrongWay.message).toMatch(/outside lab/);
    await collect(inHouseOrder);
    const notOutsourced = await refusal(advance(inHouseOrder, "sent_outside", "collection"));
    expect(notOutsourced?.status).toBe(409);
    const byBench = await refusal(advance(outsideOrder, "sent_outside", "processing"));
    expect(byBench?.status).toBe(403);
  });

  test("4. a collected sample not yet sent still holds the patient; once sent it does not", async () => {
    expect((await hold.getTestsHold(visit, db)).count).toBe(2);
    const leaving = await refusal(
      engine.advanceStatus(db, {
        visitId: visit,
        toStatus: "exited",
        actorRole: "pharmacy",
        actorId: USERS.admin.id,
        allowSkip: true,
      }),
    );
    expect(leaving?.status).toBe(409);
    expect(leaving.message).toMatch(/still open/);
    await advance(outsideOrder, "sent_outside", "collection");
    expect(
      (await one(`SELECT sample_status FROM giniflow_lab_orders WHERE id = $1`, [outsideOrder]))
        .sample_status,
    ).toBe("sent_outside");
    expect((await hold.getTestsHold(visit, db)).count).toBe(1);
    const card = await queueOrder("collection", outsideOrder);
    expect(card.nextAction).toEqual({ to: "uploaded", label: "📤 Upload report" });
  });

  test("5. with only the outside report pending, the patient can see the doctor and leave", async () => {
    await advance(inHouseOrder, "sample_sent", "collection");
    await advance(inHouseOrder, "sample_received", "processing");
    await advance(inHouseOrder, "uploaded", "processing");
    expect((await hold.getTestsHold(visit, db)).count).toBe(0);
    const visitRow = await one(`SELECT results_status FROM giniflow_visits WHERE id = $1`, [visit]);
    expect(visitRow.results_status).toBe("ready");
    await engine.advanceStatus(db, {
      visitId: visit,
      toStatus: "ready_for_doctor",
      actorRole: "reception",
      actorId: USERS.reception.id,
      allowSkip: true,
    });
    await engine.advanceStatus(db, {
      visitId: visit,
      toStatus: "exited",
      actorRole: "pharmacy",
      actorId: USERS.admin.id,
      allowSkip: true,
    });
    const after = await one(`SELECT current_status FROM giniflow_visits WHERE id = $1`, [visit]);
    expect(after.current_status).toBe("exited");
    expect(
      (await one(`SELECT sample_status FROM giniflow_lab_orders WHERE id = $1`, [outsideOrder]))
        .sample_status,
    ).toBe("sent_outside");
  });

  test("6. lab staff may upload an outsourced report; only the bench uploads an in-house one", async () => {
    const api = await apiAs("lab");
    const body = {
      base64: Buffer.from("%PDF-1.4").toString("base64"),
      fileName: "r.pdf",
      mediaType: "application/pdf",
    };
    const inHouse = await api.post(`/api/giniflow/stations/lab/${inHouseOrder}/outside-report`, {
      data: body,
    });
    expect(inHouse.status()).toBe(403);
    const bench = await api.post(`/api/giniflow/stations/lab/${outsideOrder}/report`, {
      data: body,
    });
    expect(bench.status()).toBe(403);
    const outside = await api.post(`/api/giniflow/stations/lab/${outsideOrder}/outside-report`, {
      data: body,
    });
    expect([200, 503]).toContain(outside.status());
    await api.dispose();
  });

  test("7. the report arriving later finishes the order", async () => {
    await advance(outsideOrder, "uploaded");
    const order = await one(
      `SELECT sample_status, uploaded_at FROM giniflow_lab_orders WHERE id = $1`,
      [outsideOrder],
    );
    expect(order.sample_status).toBe("uploaded");
    expect(order.uploaded_at).not.toBeNull();
    const events = await query(
      `SELECT status FROM giniflow_lab_order_events
        WHERE lab_order_id = $1 AND track = 'sample' ORDER BY occurred_at, id`,
      [outsideOrder],
    );
    expect(events.rows.map((e) => e.status)).toEqual([
      "drawing",
      "sample_collected",
      "sent_outside",
      "uploaded",
    ]);
  });
});
