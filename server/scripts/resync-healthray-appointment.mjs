import "../loadEnv.js";
import pool from "../config/db.js";
import { forceResyncAppointment } from "../services/cron/healthraySync.js";

const [fileNo, date] = process.argv.slice(2);
if (!fileNo || !/^\d{4}-\d{2}-\d{2}$/.test(date || "")) {
  console.error("Usage: node scripts/resync-healthray-appointment.mjs <file_no> <YYYY-MM-DD>");
  process.exit(1);
}

const activeMeds = async (patientId) =>
  (
    await pool.query(
      `SELECT name, dose, frequency, timing FROM medications
        WHERE patient_id = $1 AND is_active ORDER BY name`,
      [patientId],
    )
  ).rows;

try {
  const { rows } = await pool.query(
    `SELECT a.id, a.patient_id, a.healthray_id, md5(COALESCE(a.healthray_clinical_notes, '')) AS note
       FROM appointments a JOIN patients p ON p.id = a.patient_id
      WHERE upper(p.file_no) = upper($1) AND a.appointment_date = $2::date
        AND a.healthray_id IS NOT NULL
      ORDER BY a.id DESC LIMIT 1`,
    [fileNo, date],
  );
  if (!rows.length) throw new Error(`No HealthRay appointment for ${fileNo} on ${date}`);
  const appt = rows[0];
  console.log("before:", await activeMeds(appt.patient_id));
  const result = await forceResyncAppointment(date, appt.healthray_id);
  if (!result)
    throw new Error(`HealthRay did not list appointment ${appt.healthray_id} on ${date}`);
  const after = await pool.query(
    `SELECT md5(COALESCE(healthray_clinical_notes, '')) AS note FROM appointments WHERE id = $1`,
    [appt.id],
  );
  console.log("note changed:", after.rows[0].note !== appt.note);
  console.log("after:", await activeMeds(appt.patient_id));
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
