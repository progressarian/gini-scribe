import { testPricesFor, withHomeDiscount } from "../pricing.js";

export async function repriceOpenLabOrders(client, visitId) {
  const { rows: billed } = await client.query(
    `SELECT 1 FROM giniflow_patient_bills pb
       JOIN giniflow_visits v ON v.patient_id = pb.patient_id AND v.visit_date = pb.bill_date
      WHERE v.id = $1 AND pb.status = 'billed'`,
    [visitId],
  );
  if (billed.length) return 0;
  await client.query(`SELECT id FROM giniflow_lab_orders WHERE visit_id = $1 FOR UPDATE`, [
    visitId,
  ]);
  const { rows: orders } = await client.query(
    `SELECT o.id, o.scheme_code,
            json_agg(json_build_object('id', t.id, 'name', t.test_name, 'price', t.price)) AS tests
       FROM giniflow_lab_orders o
       JOIN giniflow_lab_order_tests t ON t.lab_order_id = o.id
      WHERE o.visit_id = $1 AND o.kind = 'lab'
        AND o.payment_status = 'pending'
        AND COALESCE(o.amount_paid, 0) = 0
        AND COALESCE(o.claim_state, 'none') = 'none'
      GROUP BY o.id`,
    [visitId],
  );
  let repriced = 0;
  for (const order of orders) {
    const names = order.tests.map((t) => t.name);
    const priceOf = await withHomeDiscount(
      visitId,
      await testPricesFor(names, order.scheme_code, client),
      client,
    );
    const changed = order.tests.filter(
      (t) => priceOf[t.name] !== undefined && Number(priceOf[t.name]) !== Number(t.price),
    );
    if (!changed.length) continue;
    await client.query(
      `UPDATE giniflow_lab_order_tests AS t SET price = c.price
         FROM UNNEST($1::uuid[], $2::numeric[]) AS c(id, price)
        WHERE t.id = c.id`,
      [changed.map((t) => t.id), changed.map((t) => priceOf[t.name])],
    );
    await client.query(
      `UPDATE giniflow_lab_orders
          SET amount_total = (SELECT COALESCE(sum(price), 0) FROM giniflow_lab_order_tests
                               WHERE lab_order_id = $1),
              version = version + 1,
              updated_at = NOW()
        WHERE id = $1`,
      [order.id],
    );
    repriced++;
  }
  return repriced;
}
