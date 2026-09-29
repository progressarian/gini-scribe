import "../loadEnv.js";
import pool from "../config/db.js";

const [fileNo, day] = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
if (!fileNo) {
  console.error("usage: node scripts/why-bill-lines.mjs <FILE_NO> [YYYY-MM-DD]");
  process.exit(1);
}

const ist = (value) =>
  value
    ? new Date(value).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false })
    : "—";

const client = await pool.connect();
try {
  await client.query("BEGIN READ ONLY");
  const { rows: visits } = await client.query(
    `SELECT v.id, v.visit_date::text AS day, v.current_status, p.name, p.file_no,
            a.visit_type, a.doctor_name
       FROM giniflow_visits v
       JOIN patients p ON p.id = v.patient_id
       LEFT JOIN appointments a ON a.id = v.appointment_id
      WHERE p.file_no = $1
        AND v.visit_date = COALESCE($2::date, (NOW() AT TIME ZONE 'Asia/Kolkata')::date)
      ORDER BY v.created_at`,
    [fileNo, day ?? null],
  );
  if (!visits.length) console.log(`No visit for ${fileNo} on ${day ?? "today"}`);

  for (const visit of visits) {
    console.log(
      `\n${visit.name} (${visit.file_no}) · ${visit.day} · ${visit.visit_type ?? "no booking"} · ${visit.doctor_name ?? "—"} · now ${visit.current_status}`,
    );

    const { rows: orders } = await client.query(
      `SELECT o.id, o.kind, o.created_at, o.payment_status, o.sample_status, o.amount_paid,
              d.name AS ordered_by, d.role AS ordered_by_role,
              array_agg(t.test_name || CASE WHEN t.status = 'cancelled' THEN ' (cancelled)' ELSE '' END
                        ORDER BY t.test_name) AS tests,
              (SELECT e.actor_role || ' · ' || COALESCE(e.meta ->> 'source', e.status)
                 FROM giniflow_lab_order_events e
                WHERE e.lab_order_id = o.id ORDER BY e.occurred_at, e.seq LIMIT 1) AS first_event
         FROM giniflow_lab_orders o
         LEFT JOIN doctors d ON d.id = o.ordered_by
         JOIN giniflow_lab_order_tests t ON t.lab_order_id = o.id
        WHERE o.visit_id = $1
        GROUP BY o.id, d.name, d.role
        ORDER BY o.created_at`,
      [visit.id],
    );
    console.log(`\n  Orders on this visit: ${orders.length}`);
    for (const order of orders) {
      console.log(
        `  - ${order.kind} order at ${ist(order.created_at)} by ${order.ordered_by ?? "nobody recorded (system/sync)"}${order.ordered_by_role ? ` [${order.ordered_by_role}]` : ""}`,
      );
      console.log(`      tests: ${order.tests.join(", ")}`);
      console.log(
        `      payment ${order.payment_status}, sample ${order.sample_status}, paid ₹${Number(order.amount_paid)}${order.first_event ? `, first event: ${order.first_event}` : ""}`,
      );
    }

    const { rows: lines } = await client.query(
      `SELECT l.id, l.bill_name, l.item_code, l.source, l.lab_order_id, l.created_at,
              l.patient_payable, b.status AS bill_status, b.bill_no, d.name AS added_by
         FROM bill_lines l
         JOIN bills b ON b.id = l.bill_id
         LEFT JOIN doctors d ON d.id = l.created_by
        WHERE b.visit_id = $1 AND l.credited_line_id IS NULL
        ORDER BY l.created_at`,
      [visit.id],
    );
    console.log(`\n  Bill lines: ${lines.length}`);
    for (const line of lines) {
      const order = orders.find((o) => o.id === line.lab_order_id);
      console.log(
        `  - ${line.bill_name} (${line.item_code}) ₹${Number(line.patient_payable)} on ${line.bill_no ?? "draft"} [${line.bill_status}]`,
      );
      console.log(
        `      added ${ist(line.created_at)} by ${line.added_by ?? "the system"} · source "${line.source}"${order ? ` · from the ${order.kind} order placed ${ist(order.created_at)} by ${order.ordered_by ?? "system/sync"}` : line.lab_order_id ? " · from an order on another visit" : " · not from an order"}`,
      );
    }
  }
  await client.query("ROLLBACK");
} finally {
  client.release();
  await pool.end();
}
