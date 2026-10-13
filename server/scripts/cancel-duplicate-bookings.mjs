import "../loadEnv.js";
import pool from "../config/db.js";
import { NOT_LAB_ONLY, IST_TODAY } from "../services/ghmDayWindow.js";

const APPLY = process.argv.includes("--apply");

const DUPLICATES = `
  SELECT DISTINCT ON (s.id) s.id, h.id AS healthray_row, s.file_no, s.patient_name,
         s.appointment_date::text AS visit, s.doctor_name, h.doctor_name AS healthray_doctor
    FROM appointments s
    JOIN appointments h
      ON h.patient_id = s.patient_id
     AND h.appointment_date = s.appointment_date
     AND h.healthray_id IS NOT NULL
     AND h.id <> s.id
     AND ${NOT_LAB_ONLY("h")}
   WHERE s.healthray_id IS NULL
     AND s.status = 'scheduled'
     AND s.appointment_date < ${IST_TODAY}
   ORDER BY s.id, h.id`;

const { rows } = await pool.query(DUPLICATES);
console.table(rows);
console.log(`${rows.length} stale booking row(s) duplicate a HealthRay visit`);

if (!APPLY) {
  console.log("dry run — pass --apply to cancel them");
  await pool.end();
  process.exit(0);
}

const client = await pool.connect();
try {
  await client.query("BEGIN");
  for (const r of rows) {
    await client.query(
      `UPDATE appointments SET status = 'cancelled', updated_at = NOW()
        WHERE id = $1 AND status = 'scheduled'`,
      [r.id],
    );
    await client.query(
      `INSERT INTO appointment_change_log
         (appointment_id, field, field_label, old_value, new_value, changed_by)
       VALUES ($1, 'status', 'Status', 'scheduled', 'cancelled', $2)`,
      [r.id, `Duplicate of HealthRay visit #${r.healthray_row}`],
    );
  }
  await client.query("COMMIT");
  console.log(`cancelled ${rows.length} duplicate row(s)`);
} catch (e) {
  await client.query("ROLLBACK");
  throw e;
} finally {
  client.release();
  await pool.end();
}
