import "../loadEnv.js";
import pool from "../config/db.js";

const APPLY = process.argv.includes("--apply");

const kept = (a) => `${a}.booking_status = 'booked'
  AND EXISTS (
    SELECT 1 FROM appointments k
     WHERE k.status IN ('completed', 'seen')
       AND (k.id = ${a}.id
            OR (k.patient_id = ${a}.patient_id
                AND LOWER(TRIM(COALESCE(k.doctor_name, ''))) <> 'dr. hospital admin'))
       AND k.appointment_date >= COALESCE(GREATEST(${a}.appointment_date, ${a}.preferred_date), k.appointment_date))`;

const { rows } = await pool.query(
  `SELECT id, file_no, patient_name, appointment_date::text AS visit, booking_status,
          preferred_date::text AS preferred_date, preferred_time_slot, preferred_doctor
     FROM appointments a
    WHERE ${kept("a")}
    ORDER BY appointment_date DESC`,
);

console.table(
  rows.slice(0, 20).map((r) => ({
    file_no: r.file_no,
    patient: (r.patient_name || "").slice(0, 26),
    visit: r.visit,
    preferred: r.preferred_date,
  })),
);
console.log(`${rows.length} booking(s) still marked Booked though the patient already came`);

if (!APPLY) {
  console.log("dry run — pass --apply to clear them");
  await pool.end();
  process.exit(0);
}

const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query(
    `INSERT INTO appointment_change_log
       (appointment_id, field, field_label, old_value, new_value, changed_by)
     SELECT a.id, f.field, f.label, f.old_value, NULL, 'Visit completed'
       FROM appointments a
      CROSS JOIN LATERAL (VALUES
        ('booking_status', 'Booking Status', a.booking_status),
        ('preferred_date', 'Preferred Date', a.preferred_date::text),
        ('preferred_time_slot', 'Preferred Time', a.preferred_time_slot),
        ('preferred_doctor', 'Preferred Doctor', a.preferred_doctor)
      ) AS f(field, label, old_value)
      WHERE ${kept("a")}
        AND NULLIF(f.old_value, '') IS NOT NULL`,
  );
  const done = await client.query(
    `UPDATE appointments a
        SET booking_status = NULL, preferred_date = NULL, preferred_time_slot = NULL,
            preferred_doctor = NULL, updated_at = NOW()
      WHERE ${kept("a")}`,
  );
  await client.query("COMMIT");
  console.log(`cleared ${done.rowCount} booking(s)`);
} catch (e) {
  await client.query("ROLLBACK");
  throw e;
} finally {
  client.release();
  await pool.end();
}
