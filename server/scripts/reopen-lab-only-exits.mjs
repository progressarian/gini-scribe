import "../loadEnv.js";
import pool from "../config/db.js";
import { reopenAfterLabOnlyExit } from "../services/giniflow/appointmentSync.js";

const day = process.argv[2] || new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const client = await pool.connect();
try {
  console.log(`${day}: reopened ${await reopenAfterLabOnlyExit(client, day)} visit(s)`);
} finally {
  client.release();
}
const { rows } = await pool.query(
  `SELECT p.file_no, p.name, v.current_status, a.doctor_name, a.status AS healthray
     FROM giniflow_visits v
     JOIN patients p ON p.id = v.patient_id
     LEFT JOIN appointments a ON a.id = v.appointment_id
    WHERE v.visit_date = $1::date
      AND EXISTS (SELECT 1 FROM giniflow_visit_events e WHERE e.visit_id = v.id
                   AND e.meta->>'reason' = 'consult_booked_after_lab_only_exit')
    ORDER BY p.file_no`,
  [day],
);
console.table(rows);
await pool.end();
