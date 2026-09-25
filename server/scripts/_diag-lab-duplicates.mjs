import "../loadEnv.js";
import pool from "../config/db.js";
import { LIVE_LAB_CASE_SQL } from "../services/giniflow/testsHold.js";

const days = process.argv.slice(2).length ? process.argv.slice(2) : [new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" })];
const ist = (d) => (d ? new Date(d).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false }) : "—");
const payload = (a) => `COALESCE(${a}.raw_detail_json, ${a}.raw_list_json)`;
const dup = await pool.query(
  `SELECT v.visit_date::text AS d, p.file_no, o.id AS order_id, o.sample_status, o.payment_status, o.created_at,
          (SELECT array_agg(test_name) FROM giniflow_lab_order_tests t WHERE t.lab_order_id = o.id) AS tests,
          (SELECT json_agg(json_build_object('case', lc.case_no,
                     'registered', ${payload("lc")}->>'registered_at',
                     'reported', ${payload("lc")}->>'reported_on',
                     'tests', lc.test_names))
             FROM lab_cases lc
            WHERE lc.case_date = v.visit_date AND lc.patient_id = v.patient_id AND ${LIVE_LAB_CASE_SQL("lc")}) AS cases
     FROM giniflow_lab_orders o
     JOIN giniflow_visits v ON v.id = o.visit_id
     JOIN patients p ON p.id = v.patient_id
    WHERE v.visit_date = ANY($1::date[]) AND o.kind = 'lab' AND o.ordered_by IS NULL
      AND o.sample_status IN ('ordered', 'payment_pending', 'paid')
      AND EXISTS (SELECT 1 FROM lab_cases lc
                   WHERE lc.case_date = v.visit_date AND lc.patient_id = v.patient_id
                     AND ${LIVE_LAB_CASE_SQL("lc")}
                     AND (${payload("lc")}->>'registered_at')::timestamptz < o.created_at)
    ORDER BY v.visit_date, p.file_no`,
  [days],
);
console.log(`bill-raised lab orders still undrawn, with an earlier HealthRay case (${days.join(", ")}):`, dup.rowCount);
for (const r of dup.rows) {
  console.log(" ", r.d, r.file_no, "order", ist(r.created_at), r.sample_status, r.payment_status, JSON.stringify(r.tests));
  for (const c of r.cases || []) console.log("     case", c.case, "reg", ist(c.registered), "reported", ist(c.reported), JSON.stringify(c.tests));
}
await pool.end();
