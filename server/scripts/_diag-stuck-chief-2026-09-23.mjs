import "../loadEnv.js";
import pool from "../config/db.js";

const fileNos = ["P_181261", "P_178869", "P_181216", "P_181886"];

const appts = await pool.query(
  `SELECT a.id, a.file_no, a.patient_name, a.status, a.updated_at, a.healthray_id, a.bill_paid,
          jsonb_array_length(COALESCE(a.healthray_medications,'[]'::jsonb)) AS meds,
          jsonb_array_length(COALESCE(a.healthray_diagnoses,'[]'::jsonb)) AS dx
     FROM appointments a
    WHERE a.file_no = ANY($1) AND a.appointment_date = CURRENT_DATE
    ORDER BY a.file_no`,
  [fileNos],
);
console.table(appts.rows);

const locks = await pool.query(
  `SELECT l.objid, l.pid, l.granted, s.state, s.backend_start, s.state_change, s.application_name
     FROM pg_locks l LEFT JOIN pg_stat_activity s ON s.pid = l.pid
    WHERE l.locktype = 'advisory'
    ORDER BY l.objid`,
);
console.table(locks.rows);
await pool.end();
