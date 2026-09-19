// Read-only: why a visit does or does not count its lab case as belonging to an
// earlier lab-only visit (caseFromEarlierLabOnlyVisit).
//
//   node scripts/diag-labonly-lab-steps.mjs P_67040 [YYYY-MM-DD]

import "../loadEnv.js";
import pool from "../config/db.js";
import { IST_TODAY } from "../services/giniflow/statusEngine.js";
import { LIVE_LAB_CASE_SQL, caseFromEarlierLabOnlyVisit } from "../services/giniflow/testsHold.js";

const fileNo = process.argv[2];
const date = process.argv[3] || null;
const day = `COALESCE($2::date, ${IST_TODAY})`;
const q = async (label, sql) => {
  const { rows } = await pool.query(sql, [fileNo, date]);
  console.log(`\n── ${label}`);
  console.table(rows);
};

await q(
  "patient",
  `SELECT id, name, file_no, health_id FROM patients WHERE file_no = $1 AND $2::text IS NOT DISTINCT FROM $2::text`,
);
await q(
  "appointments today",
  `SELECT a.id, a.doctor_name, a.status, a.healthray_id, a.created_at
     FROM appointments a JOIN patients p ON p.id = a.patient_id
    WHERE p.file_no = $1 AND a.appointment_date = ${day}`,
);
await q(
  "visits today",
  `SELECT v.id, v.current_status, v.merged_into_visit_id, v.assigned_doctor_id,
          (SELECT min(e.occurred_at) FROM giniflow_visit_events e
            WHERE e.visit_id = v.id AND e.status = 'checked_in') AS checked_in_at,
          (SELECT min(e.occurred_at) FROM giniflow_visit_events e WHERE e.visit_id = v.id) AS first_event
     FROM giniflow_visits v JOIN patients p ON p.id = v.patient_id
    WHERE p.file_no = $1 AND v.visit_date = ${day}`,
);
await q(
  "lab steps",
  `SELECT s.step_catalog_id, s.status, s.source, s.created_at
     FROM giniflow_visit_steps s
     JOIN giniflow_visits v ON v.id = s.visit_id JOIN patients p ON p.id = v.patient_id
    WHERE p.file_no = $1 AND v.visit_date = ${day}
      AND s.step_catalog_id IN ('lab_billing', 'blood_sample')`,
);
await q(
  "lab orders today",
  `SELECT o.id, o.kind, o.urgency, o.payment_status, o.sample_status, o.created_at
     FROM giniflow_lab_orders o
     JOIN giniflow_visits v ON v.id = o.visit_id JOIN patients p ON p.id = v.patient_id
    WHERE p.file_no = $1 AND v.visit_date = ${day}`,
);
await q(
  "lab cases today",
  `SELECT lc.case_no, lc.patient_id, lc.case_status,
          COALESCE(lc.raw_detail_json, lc.raw_list_json)->>'registered_at' AS registered_at,
          ${LIVE_LAB_CASE_SQL("lc")} AS live,
          ${caseFromEarlierLabOnlyVisit("v")} AS earlier_lab_only
     FROM giniflow_visits v JOIN patients p ON p.id = v.patient_id
     JOIN lab_cases lc ON lc.case_date = v.visit_date
      AND (lc.patient_id = v.patient_id
           OR (lc.patient_id IS NULL AND lc.raw_list_json->'patient'->>'healthray_uid' = p.file_no))
    WHERE p.file_no = $1 AND v.visit_date = ${day} AND v.merged_into_visit_id IS NULL`,
);
await pool.end();
