import "../loadEnv.js";
import pool from "../config/db.js";
import { markAppointmentAsSeen, maybeAutoSavePrescription } from "../services/healthray/db.js";

const [fileNo, date] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const apply = process.argv.includes("--apply");
const rxOnly = process.argv.includes("--rx");
if (!fileNo || !date) {
  console.error(
    "Usage: node scripts/recover-stuck-appointment.mjs <file_no> <YYYY-MM-DD> [--apply | --rx]",
  );
  process.exit(1);
}

const scribeRxCount = async (appointmentId) =>
  (
    await pool.query(
      `SELECT COUNT(*)::int AS n FROM documents d
         JOIN appointments a ON a.patient_id = d.patient_id AND a.id = $1
        WHERE d.doc_type = 'prescription' AND d.source <> 'healthray'
          AND d.consultation_id = a.consultation_id`,
      [appointmentId],
    )
  ).rows[0].n;

if (rxOnly) {
  const { rows: seen } = await pool.query(
    `SELECT a.id, a.status FROM appointments a JOIN patients p ON p.id = a.patient_id
      WHERE p.file_no = $1 AND a.appointment_date = $2::date
        AND a.status IN ('seen', 'completed') AND a.consultation_id IS NOT NULL`,
    [fileNo, date],
  );
  if (seen.length !== 1) {
    console.error(
      `${fileNo} on ${date}: ${seen.length} seen appointment(s) with a consultation; nothing changed.`,
    );
    await pool.end();
    process.exit(1);
  }
  console.log(`Scribe prescriptions before: ${await scribeRxCount(seen[0].id)}`);
  await maybeAutoSavePrescription(seen[0].id);
  console.log(`Scribe prescriptions after: ${await scribeRxCount(seen[0].id)}`);
  await pool.end();
  process.exit(0);
}

const { rows } = await pool.query(
  `SELECT a.id, a.status, a.doctor_name
     FROM appointments a JOIN patients p ON p.id = a.patient_id
    WHERE p.file_no = $1 AND a.appointment_date = $2::date
      AND a.status NOT IN ('seen', 'completed', 'cancelled', 'no_show')
      AND jsonb_array_length(COALESCE(a.healthray_diagnoses, '[]'::jsonb)) > 0
      AND jsonb_array_length(COALESCE(a.healthray_medications, '[]'::jsonb)) > 0
      AND EXISTS (
        SELECT 1 FROM documents d
         WHERE d.patient_id = a.patient_id
           AND d.source = 'healthray'
           AND d.doc_type = 'prescription'
           AND d.notes LIKE '%healthray_appt:' || a.healthray_id || '%'
           AND (d.storage_path IS NOT NULL OR d.file_url IS NOT NULL)
      )`,
  [fileNo, date],
);

if (rows.length !== 1) {
  console.error(
    `${fileNo} on ${date}: ${rows.length} appointment(s) meet the stuck-recovery rule (diagnosis, medicines and HealthRay Rx PDF); nothing changed.`,
  );
  await pool.end();
  process.exit(1);
}

const appt = rows[0];
console.log(`${fileNo} appointment ${appt.id} (${appt.doctor_name}): status ${appt.status}`);
if (!apply) {
  console.log("Dry run: would mark it seen, as the Stuck Status Recovery job does. Add --apply.");
} else {
  const result = await markAppointmentAsSeen(appt.id);
  for (let i = 0; result && i < 30 && !(await scribeRxCount(appt.id)); i++) {
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log(`Scribe prescriptions: ${await scribeRxCount(appt.id)}`);
  const after = await pool.query(`SELECT status FROM appointments WHERE id = $1`, [appt.id]);
  console.log(`Done: ${result ? "marked seen" : "no change"}; status now ${after.rows[0].status}`);
}
await pool.end();
