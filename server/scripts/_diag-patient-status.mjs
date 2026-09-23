import "../loadEnv.js";
import pool from "../config/db.js";

const fileNos = process.argv.slice(2);
const { rows } = await pool.query(
  `SELECT a.id AS appt, a.file_no, a.patient_name, a.doctor_name, a.time_slot, a.status AS appt_status,
          a.healthray_id, a.updated_at AS appt_updated,
          v.id AS visit_id, v.current_status, v.healthray_status, v.healthray_status_at, v.behind_station, v.blocked_reason
     FROM appointments a
     LEFT JOIN giniflow_visits v ON v.appointment_id = a.id
    WHERE a.file_no = ANY($1) AND a.appointment_date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date
    ORDER BY a.file_no`,
  [fileNos],
);
for (const r of rows) {
  console.log(JSON.stringify(r));
  if (!r.visit_id) continue;
  const ev = await pool.query(
    `SELECT status, actor_role, occurred_at FROM giniflow_visit_events WHERE visit_id=$1 ORDER BY occurred_at`,
    [r.visit_id],
  );
  for (const e of ev.rows)
    console.log("   ", new Date(e.occurred_at).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false }), e.status, e.actor_role);
}
const found = new Set(rows.map((r) => r.file_no));
for (const f of fileNos) if (!found.has(f)) console.log(f, "— no appointment today");
await pool.end();
