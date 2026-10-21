import pg from "pg";
import "../loadEnv.js";

const [fileNo, date] = process.argv.slice(2);
if (!fileNo || !/^\d{4}-\d{2}-\d{2}$/.test(date || "")) {
  console.error("Usage: node scripts/visit-consultant-footprint.mjs <UHID> <YYYY-MM-DD>");
  process.exit(1);
}

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
await client.connect();

const show = async (title, sql, params) => {
  await client.query("SAVEPOINT step");
  const { rows } = await client.query(sql, params).catch(async (e) => {
    await client.query("ROLLBACK TO SAVEPOINT step");
    return { rows: [{ error: e.message }] };
  });
  console.log(`${title}: ${rows.length}`);
  if (rows.length) console.table(rows);
};

try {
  await client.query("BEGIN READ ONLY");
  const { rows: patients } = await client.query(
    `SELECT id, name FROM patients WHERE file_no = $1`,
    [fileNo],
  );
  console.table(patients);
  const ids = patients.map((p) => p.id);
  const visitIds = `SELECT id FROM giniflow_visits WHERE patient_id = ANY($1) AND visit_date = $2`;

  await show(
    "Appointments",
    `SELECT id, doctor_name, status FROM appointments
      WHERE patient_id = ANY($1) AND appointment_date = $2`,
    [ids, date],
  );
  await show(
    "Gini Flow visits",
    `SELECT v.id, d.name AS assigned_doctor FROM giniflow_visits v
       LEFT JOIN doctors d ON d.id = v.assigned_doctor_id
      WHERE v.patient_id = ANY($1) AND v.visit_date = $2`,
    [ids, date],
  );
  await show(
    "Bill lines",
    `SELECT b.id AS bill_id, b.status AS bill_status, bc.name AS bill_consultant,
            l.bill_name, l.source, d.name AS line_doctor, l.is_live, l.patient_payable
       FROM bills b
       LEFT JOIN doctors bc ON bc.id = b.consultant_id
       LEFT JOIN bill_lines l ON l.bill_id = b.id
       LEFT JOIN doctors d ON d.id = l.doctor_id
      WHERE b.visit_id IN (${visitIds})
      ORDER BY b.created_at, l.line_no`,
    [ids, date],
  );
  await show(
    "Consultations",
    `SELECT id, con_name, mo_name, status, created_at FROM consultations
      WHERE patient_id = ANY($1) AND visit_date = $2`,
    [ids, date],
  );
  await show(
    "Documents created that day",
    `SELECT id, doc_type, title, source, created_at FROM documents
      WHERE patient_id = ANY($1) AND created_at >= $2::date AND created_at < $2::date + 1`,
    [ids, date],
  );
} finally {
  await client.query("ROLLBACK").catch(() => {});
  await client.end();
}
