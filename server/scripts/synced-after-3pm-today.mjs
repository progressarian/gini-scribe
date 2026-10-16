import pg from "pg";
import "../loadEnv.js";

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
await client.connect();
try {
  await client.query("BEGIN READ ONLY");
  const visits = await client.query(
    `SELECT to_char(v.created_at AT TIME ZONE 'Asia/Kolkata', 'HH24:MI') AS synced_ist,
            p.name, p.file_no, a.doctor_name, v.current_status,
            p.created_at >= v.created_at - interval '5 minutes' AS new_patient
       FROM giniflow_visits v
       JOIN patients p ON p.id = v.patient_id
       LEFT JOIN appointments a ON a.id = v.appointment_id
      WHERE v.visit_date = (now() AT TIME ZONE 'Asia/Kolkata')::date
        AND v.created_at >= ((now() AT TIME ZONE 'Asia/Kolkata')::date + time '15:00')
                            AT TIME ZONE 'Asia/Kolkata'
      ORDER BY v.created_at`,
  );
  console.log(`Visits added to today's Gini Flow board after 3:00 PM IST: ${visits.rowCount}`);
  console.table(visits.rows);

  const patients = await client.query(
    `SELECT to_char(created_at AT TIME ZONE 'Asia/Kolkata', 'HH24:MI') AS created_ist,
            name, file_no
       FROM patients
      WHERE created_at >= ((now() AT TIME ZONE 'Asia/Kolkata')::date + time '15:00')
                          AT TIME ZONE 'Asia/Kolkata'
      ORDER BY created_at`,
  );
  console.log(`New patient records created after 3:00 PM IST: ${patients.rowCount}`);
  console.table(patients.rows);
} finally {
  await client.query("ROLLBACK").catch(() => {});
  await client.end();
}
