import "../loadEnv.js";
import pool from "../config/db.js";
import { hideLabOnlyPatients } from "../services/giniflow/floorSettings.js";
import { LAB_ONLY_DOCTOR } from "../../shared/labOnly.js";

const fileNos = process.argv.slice(2);
console.log("LAB_ONLY_DOCTOR =", JSON.stringify(LAB_ONLY_DOCTOR), "| hide setting =", await hideLabOnlyPatients());
const { rows } = await pool.query(
  `SELECT p.file_no, p.name, a.id AS appt, a.doctor_name, a.status, a.time_slot,
          v.current_status, v.assigned_doctor_id, d.name AS assigned_doctor
     FROM patients p
     LEFT JOIN appointments a ON a.patient_id = p.id AND a.appointment_date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date
     LEFT JOIN giniflow_visits v ON v.patient_id = p.id AND v.visit_date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date
     LEFT JOIN doctors d ON d.id = v.assigned_doctor_id
    WHERE p.file_no = ANY($1) ORDER BY p.file_no, a.id`,
  [fileNos],
);
for (const r of rows) console.log(JSON.stringify(r));
await pool.end();
