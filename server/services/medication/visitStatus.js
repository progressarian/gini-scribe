import pool from "../../config/db.js";
const CURRENT_BURST_MINUTES = 10;

export async function markMedicationVisitStatus(patientId, db = pool) {
  if (!patientId) return;
  await db.query(
    `UPDATE medications
        SET visit_status = 'current'
      WHERE patient_id = $1
        AND is_active = true
        AND visit_status IS DISTINCT FROM 'current'`,
    [patientId],
  );
}
