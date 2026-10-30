import { EventEmitter } from "node:events";
import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../helpers/db.mjs";
import { apiAs } from "../helpers/auth.mjs";
import { USERS } from "../fixtures/data.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { extraVisit, newTag, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const ttlBefore = process.env.GINIFLOW_OUTSIDE_PENDING_TTL_MS;
process.env.GINIFLOW_OUTSIDE_PENDING_TTL_MS = "30000";
const outside = await import("../../server/services/giniflow/outsidePending.js");
const { default: refresh } = await import("../../server/middleware/outsidePendingRefresh.js");

const db = getPool();
const tag = newTag();
let ids;
let visit;
let orderId;

const counting = () => {
  const counter = { builds: 0 };
  counter.db = {
    query(text, params) {
      if (/FROM pending/.test(text)) counter.builds += 1;
      return db.query(text, params);
    },
  };
  return counter;
};

const mine = (rows) => rows.filter((row) => row.patient.name.includes(tag));

const through = (method, path, statusCode) => {
  const res = new EventEmitter();
  res.statusCode = statusCode;
  let passed = false;
  refresh({ method, path }, res, () => {
    passed = true;
  });
  res.emit("finish");
  return passed;
};

async function outsourcedOrder(status) {
  const row = await one(
    `INSERT INTO giniflow_lab_orders (visit_id, urgency, payment_status, amount_total, amount_paid,
                                      sample_status, kind, is_outsourced)
     VALUES ($1, 'today', 'paid', 500, 500, $2, 'lab', TRUE) RETURNING id`,
    [visit, status],
  );
  await query(
    `INSERT INTO giniflow_lab_order_tests (lab_order_id, test_name, price, status)
     VALUES ($1, $2, 500, $3)`,
    [row.id, ids.hba1cName, status],
  );
  await query(
    `INSERT INTO giniflow_lab_order_events (lab_order_id, track, status, actor_role, actor_id)
     VALUES ($1, 'sample', 'sample_collected', 'lab', $2)`,
    [row.id, USERS.lab.id],
  );
  return row.id;
}

test.describe.serial("G129 outside reports pending is shared, not rebuilt per poll", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    visit = (await extraVisit(ids, "SharedOutside")).visit;
    orderId = await outsourcedOrder("sample_collected");
    outside.forgetOutsidePending();
  });

  test.afterAll(async () => {
    process.env.GINIFLOW_OUTSIDE_PENDING_TTL_MS = ttlBefore;
    outside.forgetOutsidePending();
    await tearDown(ids);
  });

  test("1. two lists within 30 s build the pending set once", async () => {
    const counter = counting();
    const first = await outside.listOutsidePending({ q: tag }, counter.db);
    const second = await outside.listOutsidePending({ q: tag, status: "collected" }, counter.db);
    expect(counter.builds).toBe(1);
    expect(mine(first.rows).map((row) => row.orderId)).toEqual([orderId]);
    expect(mine(second.rows).map((row) => row.status)).toEqual(["collected"]);
    expect(second.counts).toEqual(first.counts);
  });

  test("2. ten requests at the same moment share one build", async () => {
    outside.forgetOutsidePending();
    const counter = counting();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => outside.listOutsidePending({ q: tag }, counter.db)),
    );
    expect(counter.builds).toBe(1);
    expect(new Set(results.map((result) => result.total)).size).toBe(1);
  });

  test("3. a change in the database shows after the 30 s window", async () => {
    const counter = counting();
    await outside.pendingRows(counter.db);
    await query(`UPDATE giniflow_lab_orders SET sample_status = 'sent_outside' WHERE id = $1`, [
      orderId,
    ]);
    const stale = await outside.pendingRows(counter.db);
    expect(stale.find((row) => row.ref === orderId)?.status).toBe("collected");
    const later = await outside.pendingRows(counter.db, Date.now() + 31_000);
    expect(later.find((row) => row.ref === orderId)?.status).toBe("sent");
    expect(counter.builds).toBe(1);
  });

  test("4. a lab action through the API clears the set; reads and refusals do not", async () => {
    outside.forgetOutsidePending();
    const counter = counting();
    await outside.pendingRows(counter.db);
    expect(through("GET", "/api/giniflow/stations/lab/outside-pending", 200)).toBe(true);
    expect(through("POST", `/api/giniflow/stations/lab/${orderId}/advance`, 409)).toBe(true);
    expect(through("POST", "/api/giniflow/stations/vitals/x/save", 200)).toBe(true);
    await outside.pendingRows(counter.db);
    expect(counter.builds).toBe(1);
    await query(
      `UPDATE giniflow_lab_orders SET sample_status = 'uploaded', uploaded_at = NOW() WHERE id = $1`,
      [orderId],
    );
    expect(through("POST", `/api/giniflow/stations/lab/${orderId}/report`, 200)).toBe(true);
    const fresh = await outside.pendingRows(counter.db);
    expect(counter.builds).toBe(2);
    expect(fresh.find((row) => row.ref === orderId)?.status).toBe("uploaded");
    for (const path of [
      "/api/giniflow/stations/reception/abc/cancel-test",
      "/api/giniflow/stations/lab/case/cancel-test",
      "/api/giniflow/stations/doctor/abc/tests",
      "/api/giniflow/stations/machine/cancelled/abc/restore",
    ]) {
      through("POST", path, 200);
      await outside.pendingRows(counter.db);
    }
    expect(counter.builds).toBe(6);
  });

  test("5. a billing master change clears the shared set", async () => {
    outside.forgetOutsidePending();
    const counter = counting();
    await outside.pendingRows(counter.db);
    await outside.pendingRows(counter.db);
    expect(counter.builds).toBe(1);
    through("PATCH", "/api/billing/master/items/1", 200);
    await outside.pendingRows(counter.db);
    expect(counter.builds).toBe(2);
  });

  test("6. the badge count route matches the list's counts and is lab-only", async () => {
    const lab = await apiAs("lab");
    const count = await lab.get("/api/giniflow/stations/lab/outside-pending/count");
    const list = await lab.get("/api/giniflow/stations/lab/outside-pending");
    expect(count.status()).toBe(200);
    expect(await count.json()).toEqual((await list.json()).counts);
    await lab.dispose();
    const reception = await apiAs("reception");
    const refused = await reception.get("/api/giniflow/stations/lab/outside-pending/count");
    expect(refused.status()).toBe(403);
    await reception.dispose();
  });
});
