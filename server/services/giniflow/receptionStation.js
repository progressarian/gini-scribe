import pool from "../../config/db.js";

// Reception: the payment desk between the MO ordering tests and the lab
// collecting a sample.
//
// The gate this screen exists to enforce (brief §2.2): the lab may not collect
// a sample until the order is paid or an insurance claim is approved. Reception
// is what moves an order across that line, so every action here is logged to
// giniflow_lab_order_events — a payment dispute a week later is answered from
// that log, not from a status column that only shows the present.

const ORDER_SELECT = `
  SELECT o.id, o.visit_id, o.urgency, o.payment_status, o.sample_status,
         o.amount_total, o.created_at, o.updated_at,
         p.id AS patient_id, p.name, p.file_no, p.age, p.sex,
         d.short_name AS ordered_by,
         paid_ev.occurred_at AS paid_at,
         COALESCE(t.tests, '[]'::json) AS tests
    FROM giniflow_lab_orders o
    JOIN giniflow_visits v ON v.id = o.visit_id
    JOIN patients p ON p.id = v.patient_id
    LEFT JOIN doctors d ON d.id = o.ordered_by
    LEFT JOIN LATERAL (
      SELECT json_agg(json_build_object('name', lt.test_name, 'price', lt.price)
                      ORDER BY lt.test_name) AS tests
        FROM giniflow_lab_order_tests lt WHERE lt.lab_order_id = o.id
    ) t ON TRUE
    LEFT JOIN LATERAL (
      SELECT occurred_at FROM giniflow_lab_order_events e
       WHERE e.lab_order_id = o.id AND e.track = 'payment'
         AND e.status IN ('paid', 'insurance_claim')
       ORDER BY occurred_at DESC LIMIT 1
    ) paid_ev ON TRUE
   WHERE v.visit_date = $1::date
     AND NOT COALESCE(p.is_blocked, FALSE)`;

const shape = (r) => ({
  orderId: r.id,
  visitId: r.visit_id,
  patientId: r.patient_id,
  name: r.name,
  fileNo: r.file_no,
  age: r.age,
  sex: r.sex,
  orderedBy: r.ordered_by,
  urgency: r.urgency,
  paymentStatus: r.payment_status,
  sampleStatus: r.sample_status,
  tests: r.tests || [],
  // The total is summed from the order's own lines, not from the catalogue: the
  // patient is charged what they were quoted, whatever the catalogue says now.
  total: (r.tests || []).reduce((sum, t) => sum + Number(t.price || 0), 0),
  orderedAt: r.created_at ? new Date(r.created_at).toISOString() : null,
  paidAt: r.paid_at ? new Date(r.paid_at).toISOString() : null,
});

export async function getPaymentQueue(visitDate, db = pool) {
  const { rows } = await db.query(`${ORDER_SELECT} ORDER BY o.created_at`, [visitDate]);
  const orders = rows.map(shape);

  const pending = orders.filter((o) => o.paymentStatus === "pending");
  // Paid, but the lab has not taken the sample yet — reception's own "did my
  // clearing actually reach the lab" check.
  const awaitingSample = orders.filter(
    (o) =>
      o.paymentStatus !== "pending" &&
      ["ordered", "payment_pending", "paid"].includes(o.sampleStatus),
  );
  const cleared = orders.filter(
    (o) => o.paymentStatus !== "pending" && !awaitingSample.includes(o),
  );

  // Whether reception is looking at real prices or the mockup's. Drives the
  // warning on the screen, which then disappears on its own.
  const { rows: placeholder } = await db.query(
    `SELECT EXISTS (
       SELECT 1 FROM giniflow_test_catalog
        WHERE is_active AND source = 'prototype_placeholder'
     ) AS placeholder`,
  );

  return {
    pending,
    awaitingSample,
    cleared,
    pricesArePlaceholders: placeholder[0].placeholder,
  };
}

// Clearing an order is what lets the lab collect. One transaction: the status,
// and the event that records who cleared it and how.
export async function clearPayment(orderId, { method = "paid", actorId = null }, db = pool) {
  if (!["paid", "insurance_claim"].includes(method)) {
    throw Object.assign(new Error("Payment must be settled as paid or insurance_claim"), {
      status: 400,
    });
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT payment_status, sample_status FROM giniflow_lab_orders WHERE id = $1 FOR UPDATE`,
      [orderId],
    );
    if (!rows.length) throw Object.assign(new Error("Order not found"), { status: 404 });

    // Already settled: don't write a second payment event. A double-tap at a
    // busy counter must not read later as the patient having paid twice.
    if (rows[0].payment_status !== "pending") {
      await client.query("COMMIT");
      return { orderId, paymentStatus: rows[0].payment_status, alreadySettled: true };
    }

    await client.query(
      `UPDATE giniflow_lab_orders
          SET payment_status = $2,
              sample_status = CASE WHEN sample_status IN ('ordered', 'payment_pending')
                                   THEN 'paid' ELSE sample_status END,
              updated_at = NOW()
        WHERE id = $1`,
      [orderId, method],
    );
    await client.query(
      `INSERT INTO giniflow_lab_order_events (lab_order_id, track, status, actor_role, actor_id)
       VALUES ($1, 'payment', $2, 'reception', $3)`,
      [orderId, method, actorId],
    );
    // The lab's queue reads sample_status, so the sample task appearing there is
    // the same write — trigger 3 in the brief, not a second job that can fail.
    await client.query(
      `INSERT INTO giniflow_lab_order_events (lab_order_id, track, status, actor_role, actor_id)
       VALUES ($1, 'sample', 'paid', 'reception', $2)`,
      [orderId, actorId],
    );

    await client.query("COMMIT");
    return { orderId, paymentStatus: method, alreadySettled: false };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function getTestCatalog(db = pool) {
  const { rows } = await db.query(
    `SELECT test_name, price, source FROM giniflow_test_catalog
      WHERE is_active ORDER BY test_name`,
  );
  return rows.map((r) => ({ name: r.test_name, price: Number(r.price), source: r.source }));
}
