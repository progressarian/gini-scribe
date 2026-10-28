import pool from "../config/db.js";
export async function invalidateAppointmentSummaries(appointmentId) {
  const aid = Number(appointmentId);
  if (!aid) return;
  try {
    await pool.query(
      `UPDATE appointments
         SET ai_summary = NULL,
             ai_summary_generated_at = NULL,
             post_visit_summary = NULL,
             post_visit_summary_generated_at = NULL
       WHERE id = $1`,
      [aid],
    );
  } catch (err) {
    console.error("[summaryCache] invalidateAppointment failed:", err?.message || err);
  }
}
export async function invalidatePatientSummaries(patientId) {
  const pid = Number(patientId);
  if (!pid) return;
  try {
    await pool.query(
      `UPDATE appointments
         SET ai_summary = NULL,
             ai_summary_generated_at = NULL,
             post_visit_summary = NULL,
             post_visit_summary_generated_at = NULL
       WHERE id = (
         SELECT id FROM appointments
          WHERE patient_id = $1
          ORDER BY appointment_date DESC NULLS LAST, id DESC
          LIMIT 1
       )
         AND (ai_summary IS NOT NULL OR post_visit_summary IS NOT NULL)`,
      [pid],
    );
  } catch (err) {
    console.error("[summaryCache] invalidate failed:", err?.message || err);
  }
}
