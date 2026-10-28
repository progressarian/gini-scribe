import "../loadEnv.js";
import pool from "../config/db.js";

const fileNo = process.argv[2];
const date = process.argv[3] || new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const c = await pool.connect();
try {
  await c.query("BEGIN READ ONLY");
  const { rows: v } = await c.query(
    `SELECT v.*, to_jsonb(v) - 'id' AS j FROM giniflow_visits v JOIN patients p ON p.id = v.patient_id
      WHERE p.file_no = $1 AND v.visit_date = $2::date`,
    [fileNo, date],
  );
  for (const visit of v) {
    const { j } = visit;
    console.log("VISIT", visit.id, Object.fromEntries(Object.entries(j).filter(([k, x]) => x !== null && !/steps|journey/.test(k))));
    console.log("JOURNEY", JSON.stringify(j.journey_steps ?? j.journey ?? null));
    const { rows: ev } = await c.query(
      `SELECT to_char(occurred_at AT TIME ZONE 'Asia/Kolkata','HH24:MI') t, to_jsonb(e) - 'visit_id' - 'id' - 'occurred_at' AS e
         FROM giniflow_visit_events e WHERE visit_id = $1 ORDER BY occurred_at`,
      [visit.id],
    );
    for (const r of ev) console.log(r.t, JSON.stringify(r.e));
    const { rows: st } = await c.query(
      `SELECT to_jsonb(s) - 'visit_id' - 'id' AS s FROM giniflow_visit_steps s WHERE visit_id = $1 ORDER BY 1`,
      [visit.id],
    );
    for (const r of st) console.log("STEP", JSON.stringify(r.s));
    const { rows: lo } = await c.query(
      `SELECT o.id, o.kind, o.sample_status, o.payment_status, o.lab_site,
              (SELECT array_agg(test_name) FROM giniflow_lab_order_tests t WHERE t.order_id = o.id) tests
         FROM giniflow_lab_orders o WHERE o.visit_id = $1`,
      [visit.id],
    );
    console.log("ORDERS", JSON.stringify(lo));
    const { rows: ap } = await c.query(
      `SELECT id, status, visit_type, doctor_name, appointment_date FROM appointments WHERE id = $1`,
      [visit.appointment_id],
    );
    console.log("APPT", ap);
  }
  await c.query("ROLLBACK");
} finally {
  c.release();
  await pool.end();
}
