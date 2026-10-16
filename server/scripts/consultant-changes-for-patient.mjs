import pg from "pg";
import "../loadEnv.js";

const fileNo = process.argv[2];
if (!fileNo) {
  console.error("Usage: node scripts/consultant-changes-for-patient.mjs <UHID>");
  process.exit(1);
}
const IST = (col) => `to_char(${col} AT TIME ZONE 'Asia/Kolkata', 'DD Mon YYYY HH24:MI')`;

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
await client.connect();
try {
  await client.query("BEGIN READ ONLY");
  const patients = await client.query(
    `SELECT id, name, file_no FROM patients WHERE file_no = $1 ORDER BY id`,
    [fileNo],
  );
  console.table(patients.rows);
  const ids = patients.rows.map((p) => p.id);

  const log = await client.query(
    `SELECT ${IST("l.changed_at")} AS changed_ist, a.appointment_date::text AS appt_date,
            l.old_value AS from_consultant, l.new_value AS to_consultant,
            COALESCE(l.changed_by, d.name) AS changed_by, d.role
       FROM appointment_change_log l
       JOIN appointments a ON a.id = l.appointment_id
       LEFT JOIN doctors d ON d.id = l.changed_by_id
      WHERE a.patient_id = ANY($1) AND l.field = 'doctor_name'
      ORDER BY l.changed_at`,
    [ids],
  );
  console.log(`Consultant changes in appointment history: ${log.rowCount}`);
  console.table(log.rows);

  const changes = await client.query(
    `SELECT ${IST("c.reassigned_at")} AS reassigned_ist, v.visit_date::text AS visit_date,
            f.name AS from_doctor, t.name AS to_doctor, b.name AS reassigned_by, b.role,
            c.status, x.name AS decided_by, ${IST("c.decided_at")} AS decided_ist, c.note
       FROM consultant_changes c
       JOIN giniflow_visits v ON v.id = c.visit_id
       LEFT JOIN doctors f ON f.id = c.from_doctor_id
       LEFT JOIN doctors t ON t.id = c.to_doctor_id
       LEFT JOIN doctors b ON b.id = c.reassigned_by
       LEFT JOIN doctors x ON x.id = c.decided_by
      WHERE c.patient_id = ANY($1)
      ORDER BY c.reassigned_at`,
    [ids],
  );
  console.log(`Consultant changes on Gini Flow visits: ${changes.rowCount}`);
  console.table(changes.rows);

  const appts = await client.query(
    `SELECT a.id, a.appointment_date::text AS appt_date, a.doctor_name, a.status,
            ${IST("a.doctor_set_manually_at")} AS set_manually_ist,
            ad.name AS visit_assigned_doctor
       FROM appointments a
       LEFT JOIN giniflow_visits v ON v.appointment_id = a.id
       LEFT JOIN doctors ad ON ad.id = v.assigned_doctor_id
      WHERE a.patient_id = ANY($1)
      ORDER BY a.appointment_date DESC
      LIMIT 10`,
    [ids],
  );
  console.log("Latest appointments:");
  console.table(appts.rows);
} finally {
  await client.query("ROLLBACK").catch(() => {});
  await client.end();
}
