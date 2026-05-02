// Stamp `visit_status` ('current' | 'previous') on every active medication row
// for a patient. Called from every write path that adds, edits, stops, or
// re-prescribes a medication, so readers (scribe UI, summary route, genie
// app screens) can filter on the column instead of re-deriving the bucket
// from `last_prescribed_date` at render time.
//
// "Current" = the latest `last_prescribed_date` across the patient's active
// rows. Rows with NULL `last_prescribed_date` are kept in 'current' as a
// safe default — they have no signal saying they belong to an older visit.
import pool from "../../config/db.js";

export async function markMedicationVisitStatus(patientId, db = pool) {
  if (!patientId) return;
  await db.query(
    `WITH latest AS (
       SELECT MAX(last_prescribed_date::date) AS d
         FROM medications
        WHERE patient_id = $1 AND is_active = true
     )
     UPDATE medications m
        SET visit_status = CASE
              WHEN (SELECT d FROM latest) IS NULL THEN 'current'
              WHEN m.last_prescribed_date IS NULL
                OR m.last_prescribed_date::date = (SELECT d FROM latest) THEN 'current'
              ELSE 'previous'
            END,
            updated_at = NOW()
      WHERE m.patient_id = $1
        AND m.is_active = true
        AND m.visit_status IS DISTINCT FROM CASE
              WHEN (SELECT d FROM latest) IS NULL THEN 'current'
              WHEN m.last_prescribed_date IS NULL
                OR m.last_prescribed_date::date = (SELECT d FROM latest) THEN 'current'
              ELSE 'previous'
            END`,
    [patientId],
  );
}
