// Reception: the payment desk, and the gate it guards.
//
// The rule that matters (brief §2.2): the lab may not collect a sample until the
// order is paid or an insurance claim is approved. Reception is what moves an
// order across that line, so these checks are mostly about money and the log.
//
//   npm run smoke:giniflow-reception   (from server/)
import "../loadEnv.js";
process.env.GINIFLOW_ALLOW_DEMO = "1";
import pool from "../config/db.js";
import { seedDemoDay, cleanDemoDay } from "../services/giniflow/demo.js";
import {
  getPaymentQueue,
  clearPayment,
  getTestCatalog,
} from "../services/giniflow/receptionStation.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok " : "FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];

const TEST_DAY = "2019-01-04";
const before = await one(
  `SELECT (SELECT count(*)::int FROM flow_visits) AS v,
          (SELECT count(*)::int FROM giniflow_test_catalog) AS cat`,
);

await cleanDemoDay();
await seedDemoDay({ date: TEST_DAY });

const catalog = await getTestCatalog();
check("the price catalogue is readable", catalog.length > 0, `${catalog.length} tests`);
check(
  "catalogue prices are marked as placeholders",
  catalog.every((t) => t.source === "prototype_placeholder"),
  "so nobody mistakes a mockup figure for a tariff",
);

const q = await getPaymentQueue(TEST_DAY);
check("payment-pending orders are listed", q.pending.length > 0, `${q.pending.length}`);
const order = q.pending[0];
check("an order carries its patient", !!order.name && !!order.fileNo);
check("an order lists its tests with prices", order.tests.length > 0 && order.tests[0].price > 0);
check(
  "the total is summed from the order's own lines",
  order.total === order.tests.reduce((s, t) => s + Number(t.price), 0),
  `${order.total}`,
);
check("who ordered it is shown", "orderedBy" in order);

// Clearing is what lets the lab collect.
const cleared = await clearPayment(order.orderId, { method: "paid" });
check("clearing marks the order paid", cleared.paymentStatus === "paid");
const afterRow = await one(
  `SELECT payment_status, sample_status FROM giniflow_lab_orders WHERE id = $1`,
  [order.orderId],
);
check(
  "the sample task opens for the lab",
  afterRow.sample_status === "paid",
  afterRow.sample_status,
);

const events = await pool.query(
  `SELECT track, status, actor_role FROM giniflow_lab_order_events
    WHERE lab_order_id = $1 ORDER BY occurred_at`,
  [order.orderId],
);
check(
  "the payment is logged, not just stored",
  events.rows.some(
    (e) => e.track === "payment" && e.status === "paid" && e.actor_role === "reception",
  ),
);
check(
  "the sample hand-off is logged too",
  events.rows.some((e) => e.track === "sample" && e.status === "paid"),
);

// A double-tap at a busy counter must not read as paying twice.
const again = await clearPayment(order.orderId, { method: "paid" });
check("clearing twice is a no-op", again.alreadySettled === true);
const paymentEvents = await one(
  `SELECT count(*)::int AS c FROM giniflow_lab_order_events
    WHERE lab_order_id = $1 AND track = 'payment' AND status = 'paid'`,
  [order.orderId],
);
check("only one payment event exists", paymentEvents.c === 1, `${paymentEvents.c}`);

const q2 = await getPaymentQueue(TEST_DAY);
check("the order leaves the pending list", !q2.pending.find((o) => o.orderId === order.orderId));
check(
  "and appears as cleared or awaiting the lab",
  [...q2.cleared, ...q2.awaitingSample].some((o) => o.orderId === order.orderId),
);

// Insurance is the other way across the same line.
if (q2.pending[0]) {
  const claim = await clearPayment(q2.pending[0].orderId, { method: "insurance_claim" });
  check("an insurance claim also clears the order", claim.paymentStatus === "insurance_claim");
}

const bad = await clearPayment(order.orderId, { method: "waived" })
  .then(() => false)
  .catch(() => true);
check("an unknown settlement method is rejected", bad);

const missing = await clearPayment("00000000-0000-0000-0000-000000000000", { method: "paid" })
  .then(() => false)
  .catch(() => true);
check("an unknown order is rejected", missing);

await cleanDemoDay();
const after = await one(
  `SELECT (SELECT count(*)::int FROM flow_visits) AS v,
          (SELECT count(*)::int FROM giniflow_test_catalog) AS cat`,
);
check("old flow_* module untouched", after.v === before.v, `${before.v}→${after.v}`);
check("the catalogue survives a smoke run", after.cat === before.cat, `${before.cat}→${after.cat}`);

console.log(failures ? `\n${failures} FAILED\n` : "\nall checks passed\n");
await pool.end();
process.exit(failures ? 1 : 0);
