import { fileURLToPath } from "url";
import { dirname, join } from "path";
const __dirname = dirname(fileURLToPath(import.meta.url));
const dotenv = await import("dotenv");
dotenv.config({ path: join(__dirname, "..", ".env") });
const { default: pool } = await import("../config/db.js");

const r = await pool.query(`
  WITH meds AS (
    SELECT m.id, m.patient_id, m.consultation_id,
           REPLACE(m.notes, 'healthray:', '') AS hr_id
      FROM medications m
     WHERE m.source = 'healthray' AND m.notes LIKE 'healthray:%'
  ),
  target AS (
    SELECT m.id, m.patient_id, m.consultation_id AS current_consult,
           c.id AS target_consult
      FROM meds m
      LEFT JOIN appointments a
        ON a.healthray_id::text = m.hr_id AND a.patient_id = m.patient_id
      LEFT JOIN consultations c
        ON c.patient_id = m.patient_id AND c.visit_date = a.appointment_date
  )
  SELECT
    COUNT(*) FILTER (WHERE target_consult IS NOT NULL AND current_consult IS DISTINCT FROM target_consult) AS still_mismatched,
    COUNT(*) FILTER (WHERE target_consult IS NOT NULL AND current_consult = target_consult) AS now_matched
   FROM target
`);
console.log("Mismatch progress:", r.rows[0]);
await pool.end();
