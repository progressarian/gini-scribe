import { paise } from "../../../shared/labPayment.js";

export const CLEARED_SOURCES = [
  { key: "payments_tab", label: "Cleared on Payments tab (taken in HealthRay)" },
  { key: "fee_settle", label: "Fee change settled (taken in HealthRay)" },
];

export const PAYMENTS_TAB_CLEARED = `
  SELECT DISTINCT ON (e.lab_order_id) e.lab_order_id, e.actor_id AS staff, e.occurred_at AS at,
         o.amount_paid AS amount, o.visit_id
    FROM giniflow_lab_order_events e
    JOIN giniflow_lab_orders o ON o.id = e.lab_order_id
   WHERE e.track = 'payment' AND e.status IN ('paid', 'split')
     AND e.meta ->> 'bill_id' IS NULL AND o.amount_paid > 0`;

export async function clearedInWindow(client, userId, from, to) {
  const { rows } = await client.query(
    `SELECT 'payments_tab' AS source, COUNT(*) AS n, COALESCE(SUM(amount), 0) AS amount
       FROM (${PAYMENTS_TAB_CLEARED}
               AND e.actor_id = $1 AND e.occurred_at BETWEEN $2 AND $3
             ORDER BY e.lab_order_id, e.occurred_at) tab
     UNION ALL
     SELECT 'fee_settle', COUNT(*), COALESCE(SUM(c.amount), 0)
       FROM giniflow_bill_charges c
      WHERE c.payment_status = 'paid' AND c.paid_by = $1 AND c.paid_at BETWEEN $2 AND $3`,
    [userId, from, to],
  );
  return Object.fromEntries(
    rows.map((row) => [row.source, { count: Number(row.n), amount: paise(row.amount) }]),
  );
}
