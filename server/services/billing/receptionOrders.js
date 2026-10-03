import pool from "../../config/db.js";
import { collectiblePaise, paise } from "../../../shared/labPayment.js";
import {
  HELD_AT_RECEPTION,
  lockVisitOrders,
  openOrdersFor,
  RECEPTION_MONEY_SQL,
  SETTLED_AT_RECEPTION,
} from "./orderLinks.js";
import { TEST_MATCHES_SQL } from "./testMatch.js";
import { httpError } from "./transaction.js";

export const PAID_AT_RECEPTION = "paid_at_reception";

const RECEPTION_EVENTS = ["paid", "part_paid", "insurance_claim", "claim_approved"];

const HELD_ORDERS_SQL = `
  WITH held AS MATERIALIZED (
    SELECT o.id, o.created_at, o.payment_status, o.amount_total, o.amount_paid,
           o.amount_claimed, o.claim_state, o.insurer, rm.cash, rm.claim, rm.bill_settles,
           rm.bill_events
      FROM giniflow_lab_orders o
      CROSS JOIN LATERAL ${RECEPTION_MONEY_SQL("o")} rm
     WHERE o.visit_id = $1 AND o.sample_status <> 'cancelled' AND ${SETTLED_AT_RECEPTION}
       AND ${HELD_AT_RECEPTION("rm")}),
  tests AS MATERIALIZED (
    SELECT t.lab_order_id, t.test_name, t.price
      FROM giniflow_lab_order_tests t JOIN held h ON h.id = t.lab_order_id
     WHERE t.status <> 'cancelled'),
  matched AS (${TEST_MATCHES_SQL("ARRAY(SELECT test_name FROM tests)")})
  SELECT h.id, h.payment_status, h.amount_total, h.amount_paid, h.amount_claimed,
         h.claim_state, h.insurer, h.cash, h.claim, h.bill_events,
         (SELECT max(e.occurred_at) FROM giniflow_lab_order_events e
           WHERE e.lab_order_id = h.id AND e.track = 'payment'
             AND e.status = ANY($2::text[]) AND NOT COALESCE(e.meta ? 'bill_id', FALSE))
           AS paid_at,
         (SELECT d.name FROM giniflow_lab_order_events e
            LEFT JOIN doctors d ON d.id = e.actor_id
           WHERE e.lab_order_id = h.id AND e.track = 'payment'
             AND e.status = ANY($2::text[]) AND NOT COALESCE(e.meta ? 'bill_id', FALSE)
           ORDER BY e.occurred_at DESC LIMIT 1) AS cleared_by,
         json_agg(json_build_object(
           'name', t.test_name,
           'price', t.price,
           'catalog_id', m.catalog_id,
           'billed', EXISTS (SELECT 1 FROM bill_lines bl
                               JOIN bills b ON b.id = bl.bill_id AND b.status <> 'cancelled'
                               JOIN service_items si ON si.id = bl.service_item_id
                              WHERE bl.lab_order_id = h.id AND bl.is_live
                                AND si.test_catalog_id = m.catalog_id))
           ORDER BY t.test_name) AS tests
    FROM held h
    JOIN tests t ON t.lab_order_id = h.id
    LEFT JOIN matched m ON m.test_name = t.test_name
   GROUP BY h.id, h.created_at, h.payment_status, h.amount_total, h.amount_paid,
            h.amount_claimed, h.claim_state, h.insurer, h.cash, h.claim, h.bill_events
   ORDER BY h.created_at, h.id`;

function heldOrder(row) {
  const cash = paise(row.cash);
  const claim = paise(row.claim);
  const legacy = !cash && !claim;
  const open = row.tests.filter((test) => !test.billed);
  const uncovered = open.reduce((sum, test) => sum + paise(test.price), 0);
  const committed = legacy ? paise(row.amount_total) : cash + claim;
  const billedSome = open.length < row.tests.length;
  const due = legacy ? 0 : billedSome ? Math.max(0, uncovered - committed) : collectiblePaise(row);
  return {
    lab_order_id: row.id,
    tests: (open.length ? open : row.tests).map((test) => test.name),
    paid: cash,
    paid_at: row.paid_at,
    cleared_by: row.cleared_by ?? null,
    modes: [],
    claim: claim ? { state: row.claim_state, amount: claim, insurer: row.insurer ?? null } : null,
    still_due: due,
    payment_status: row.payment_status,
    open,
    uncovered,
    committed,
    reception_only: row.bill_events === 0,
  };
}

async function heldOrders(db, visitId) {
  const { rows } = await db.query(HELD_ORDERS_SQL, [visitId, RECEPTION_EVENTS]);
  return rows.map(heldOrder);
}

const covers = (order, catalogId) =>
  order.open.some(
    (test) =>
      test.catalog_id === catalogId &&
      (order.reception_only || order.committed > order.uncovered - paise(test.price)),
  );

async function holderOf(db, orders, { visitId, billId, catalogId, labOrderId }) {
  const holding = orders.find(
    (order) => (!labOrderId || order.lab_order_id === labOrderId) && covers(order, catalogId),
  );
  if (!holding) return null;
  if (labOrderId) return holding;
  const open = await openOrdersFor(db, { visitId, billId, catalogId });
  return open.length ? null : holding;
}

export async function receptionHolds(db, { visitId, billId = null, catalogId, labOrderId = null }) {
  if (!visitId || !catalogId) return null;
  return holderOf(db, await heldOrders(db, visitId), { visitId, billId, catalogId, labOrderId });
}

export async function heldCatalogs(db, { visitId, billId = null, catalogIds }) {
  const held = new Set();
  if (!visitId) return held;
  const orders = await heldOrders(db, visitId);
  if (!orders.length) return held;
  for (const catalogId of new Set(catalogIds.filter(Boolean))) {
    if (await holderOf(db, orders, { visitId, billId, catalogId, labOrderId: null })) {
      held.add(catalogId);
    }
  }
  return held;
}

export async function refuseReceptionTest(client, bill, item, labOrderId = null) {
  if (item.kind !== "test" || !item.test_catalog_id || !bill.visit_id) return;
  await lockVisitOrders(client, bill.visit_id);
  const holding = await receptionHolds(client, {
    visitId: bill.visit_id,
    billId: bill.id,
    catalogId: item.test_catalog_id,
    labOrderId,
  });
  if (!holding) return;
  const way =
    holding.claim && !holding.paid
      ? "has its insurance claim at reception"
      : "was already paid at reception";
  throw httpError(
    409,
    `${item.name} ${way} — it's listed under Paid at reception and isn't charged on this bill`,
    { code: PAID_AT_RECEPTION, lab_order_id: holding.lab_order_id },
  );
}

const publicOrder = ({ open, uncovered, committed, reception_only, ...order }) => order;

export async function paidAtReception(visitId, db = pool) {
  const orders = (await heldOrders(db, visitId)).map(publicOrder);
  return {
    orders,
    total_paid: orders.reduce((sum, order) => sum + order.paid, 0),
    total_claimed: orders.reduce((sum, order) => sum + (order.claim?.amount ?? 0), 0),
    still_due: orders.reduce((sum, order) => sum + order.still_due, 0),
  };
}
