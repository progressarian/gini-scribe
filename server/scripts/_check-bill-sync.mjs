import "../loadEnv.js";
import pool from "../config/db.js";
const SINCE = process.argv[2];
const { rows } = await pool.query(
  `SELECT p.file_no, p.name, v.current_status,
          to_char((SELECT min(s.created_at) FROM giniflow_visit_steps s WHERE s.visit_id = v.id) AT TIME ZONE 'Asia/Kolkata', 'HH24:MI') AS checked_in,
          to_char(v.machine_scan_at AT TIME ZONE 'Asia/Kolkata', 'HH24:MI') AS scanned,
          b.status AS bill, to_char(b.read_at AT TIME ZONE 'Asia/Kolkata', 'HH24:MI') AS bill_read,
          (SELECT count(*)::int FROM jsonb_array_elements(b.items) i WHERE i->>'category' <> 'consultation' AND NOT COALESCE((i->>'cancelled')::bool, false)) AS billed_tests,
          (SELECT string_agg(s.step_catalog_id || CASE WHEN s.status = 'skipped' THEN '(skipped)' ELSE '' END, ', ' ORDER BY s.step_order)
             FROM giniflow_visit_steps s LEFT JOIN flow_step_catalog c ON c.id = s.step_catalog_id
            WHERE s.visit_id = v.id AND (s.step_catalog_id IN ('lab_billing','blood_sample','lab_processing_2') OR COALESCE(c.machine, false))) AS test_steps,
          (SELECT count(*)::int FROM giniflow_lab_orders o WHERE o.visit_id = v.id) AS orders
     FROM giniflow_visits v JOIN patients p ON p.id = v.patient_id
     LEFT JOIN giniflow_patient_bills b ON b.patient_id = v.patient_id AND b.bill_date = v.visit_date
    WHERE v.visit_date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date AND v.merged_into_visit_id IS NULL
      AND v.current_status NOT IN ('booked','confirmed','no_show','cancelled')
      AND ((SELECT min(s.created_at) FROM giniflow_visit_steps s WHERE s.visit_id = v.id) > $1::timestamptz
           OR b.read_at > $1::timestamptz)
    ORDER BY 4`,
  [SINCE],
);
console.table(rows);
const kv = await pool.query(`SELECT key, value FROM app_kv WHERE key IN ('healthray_bill_cooldown','healthray_login_cooldown')`);
for (const r of kv.rows) console.log(r.key, new Date(Number(r.value.until)).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" }), r.value.blockCount ?? r.value.failCount);
await pool.end();
