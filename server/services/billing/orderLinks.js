import { CLAIM_STATE, PAYMENT_STATUS } from "../../../shared/labPayment.js";
import { writeAudit } from "./audit.js";
import { auditFields } from "./common.js";
import { paidByBillAlone } from "./payments.js";
import { TEST_MATCHES_SQL } from "./testMatch.js";

const sqlText = (values) => values.map((value) => `'${value}'`).join(", ");

export const SETTLED_AT_RECEPTION = `(o.amount_paid > 0
  OR o.claim_state IN (${sqlText([CLAIM_STATE.SUBMITTED, CLAIM_STATE.APPROVED])})
  OR (o.amount_total > 0 AND o.payment_status IN (${sqlText([
    PAYMENT_STATUS.PAID,
    PAYMENT_STATUS.CLAIM_APPROVED,
    PAYMENT_STATUS.CLAIM_SUBMITTED,
  ])})))`;

const STANDING_CLAIMS_SQL = sqlText([CLAIM_STATE.SUBMITTED, CLAIM_STATE.APPROVED]);

export const RECEPTION_MONEY_SQL = (order) => `(
  SELECT GREATEST(${order}.amount_paid - COALESCE(SUM(
           (s.meta -> 'after' ->> 'amount_paid')::numeric
           - (s.meta -> 'before' ->> 'amount_paid')::numeric) FILTER (WHERE s.live), 0), 0) AS cash,
         CASE WHEN ${order}.claim_state IN (${STANDING_CLAIMS_SQL})
               AND NOT COALESCE(bool_or(s.live AND s.bill_claim > 0), FALSE)
              THEN ${order}.amount_claimed ELSE 0 END AS claim,
         COUNT(*) FILTER (WHERE s.live)::int AS bill_settles,
         COUNT(*)::int AS bill_events
    FROM (SELECT DISTINCT ON (e.meta ->> 'bill_id') e.meta,
                 e.meta ? 'before' AND e.meta ? 'after'
                   AND NOT COALESCE((e.meta ->> 'released')::boolean, FALSE) AS live,
                 COALESCE((e.meta ->> 'bill_claim')::numeric,
                          CASE WHEN e.meta -> 'after' ->> 'claim_state' IN (${STANDING_CLAIMS_SQL})
                               THEN (e.meta -> 'after' ->> 'amount_claimed')::numeric
                               ELSE 0 END) AS bill_claim
            FROM giniflow_lab_order_events e
           WHERE e.lab_order_id = ${order}.id AND e.track = 'payment' AND e.meta ? 'bill_id'
           ORDER BY e.meta ->> 'bill_id', e.occurred_at DESC, e.seq DESC) s)`;

export const HELD_AT_RECEPTION = (money) =>
  `NOT (${money}.bill_settles > 0 AND ${money}.cash = 0 AND ${money}.claim = 0)`;

const OPEN_ORDERS_SQL = `
  WITH ordered AS MATERIALIZED (
    SELECT o.id AS order_id, o.created_at, ${SETTLED_AT_RECEPTION} AS settled, t.test_name
      FROM giniflow_lab_orders o
      JOIN giniflow_lab_order_tests t ON t.lab_order_id = o.id
     WHERE o.visit_id = $1 AND o.sample_status <> 'cancelled' AND t.status <> 'cancelled'),
  matched AS (${TEST_MATCHES_SQL("ARRAY(SELECT test_name FROM ordered)")})
  SELECT d.order_id, d.settled, array_agg(d.test_name ORDER BY d.test_name) AS test_names,
         count(*)::int - COALESCE((
           SELECT SUM(l.quantity) FROM bill_lines l
             JOIN bills b ON b.id = l.bill_id AND b.status <> 'cancelled'
             JOIN service_items si ON si.id = l.service_item_id
            WHERE l.lab_order_id = d.order_id AND l.is_live AND si.test_catalog_id = $2), 0)::int
           AS open
    FROM ordered d
    JOIN matched m ON m.test_name = d.test_name
   WHERE m.catalog_id = $2
   GROUP BY d.order_id, d.created_at, d.settled
   ORDER BY d.created_at, d.order_id`;

export async function lockVisitOrders(client, visitId) {
  await client.query(
    `SELECT id FROM giniflow_lab_orders WHERE visit_id = $1 ORDER BY id FOR UPDATE`,
    [visitId],
  );
}

export async function openOrdersFor(client, { visitId, billId, catalogId }) {
  if (!visitId || !catalogId) return [];
  const { rows } = await client.query(OPEN_ORDERS_SQL, [visitId, catalogId]);
  const open = [];
  for (const row of rows.filter((entry) => entry.open > 0)) {
    if (row.settled && !(await paidByBillAlone(client, billId, row.order_id))) continue;
    open.push(row);
  }
  return open;
}

export async function orderToLink(client, bill, item) {
  if (item.kind !== "test" || !item.test_catalog_id || !bill.visit_id) return null;
  await lockVisitOrders(client, bill.visit_id);
  const [first] = await openOrdersFor(client, {
    visitId: bill.visit_id,
    billId: bill.id,
    catalogId: item.test_catalog_id,
  });
  return first?.order_id ?? null;
}

export async function linkLine(client, bill, line, labOrderId, ctx) {
  const { rows } = await client.query(
    `UPDATE bill_lines SET source = 'lab_order', lab_order_id = $2, updated_at = NOW(),
            updated_by = $3
      WHERE id = $1 AND lab_order_id IS NULL AND is_live
      RETURNING id`,
    [line.id, labOrderId, ctx?.actorId ?? null],
  );
  if (!rows.length) return false;
  await writeAudit(client, {
    entity: "bill_lines",
    entityId: line.id,
    action: "update",
    before: { source: line.source, lab_order_id: null },
    after: { source: "lab_order", lab_order_id: labOrderId, bill_no: bill.bill_no },
    ...auditFields(ctx),
  });
  return true;
}
