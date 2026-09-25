import "../loadEnv.js";
import pool from "../config/db.js";
const { rows } = await pool.query(
  `SELECT d.id, d.patient_id, p.file_no, d.title, d.doc_date::text AS doc_date, d.created_at,
          d.consultation_id, a.appointment_date::text AS visit_date, a.id AS appt_id
     FROM documents d
     JOIN patients p ON p.id = d.patient_id
     LEFT JOIN appointments a ON a.consultation_id = d.consultation_id
    WHERE d.source = 'visit' AND d.doc_type = 'prescription'
      AND d.created_at > now() - '3 hours'::interval
      AND a.appointment_date < (now() AT TIME ZONE 'Asia/Kolkata')::date
    ORDER BY d.patient_id, d.created_at`,
);
const byPatient = new Map();
for (const r of rows) byPatient.set(r.file_no, [...(byPatient.get(r.file_no) || []), r]);
console.log(`${rows.length} Scribe prescription copies made in the last 3h for past visits, ${byPatient.size} patient(s)`);
for (const [f, list] of byPatient) console.log(" ", f, "visit", list[0].visit_date, "| copies:", list.length, "| dated", list.map((x) => x.doc_date).join(","), "| ids", list.map((x) => x.id).join(","));
await pool.end();
