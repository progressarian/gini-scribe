import pg from "pg";
import "../loadEnv.js";

const IST = (col) => `to_char(${col} AT TIME ZONE 'Asia/Kolkata', 'DD Mon YYYY HH24:MI')`;
const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
await client.connect();
try {
  await client.query("BEGIN READ ONLY");
  const { rows } = await client.query(
    `SELECT c.id, c.patient_id, p.name AS patient, p.file_no, v.visit_date::text AS visit_date,
            v.patient_id AS visit_patient_id, f.name AS from_doctor, t.name AS to_doctor,
            b.name AS reassigned_by, ${IST("c.reassigned_at")} AS reassigned_ist
       FROM consultant_changes c
       LEFT JOIN patients p ON p.id = c.patient_id
       LEFT JOIN giniflow_visits v ON v.id = c.visit_id
       LEFT JOIN doctors f ON f.id = c.from_doctor_id
       LEFT JOIN doctors t ON t.id = c.to_doctor_id
       LEFT JOIN doctors b ON b.id = c.reassigned_by
      WHERE c.status = 'pending'
      ORDER BY c.reassigned_at DESC`,
  );
  console.log(`Pending consultant changes: ${rows.length}`);
  console.table(rows);
} finally {
  await client.query("ROLLBACK").catch(() => {});
  await client.end();
}
