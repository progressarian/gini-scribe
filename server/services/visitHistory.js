import pool from "../config/db.js";

// A patient's visit history as the /visit History tab defines it: their
// consultations, plus HealthRay appointments for days that produced no
// consultation, newest first, one row per visit_date+status.
//
// The GHM patient-record popup listed raw `appointments` rows instead, so the
// two screens disagreed — the popup showed booking rows the History tab folds
// away and missed visits that exist only as consultations.
//
// Slot and MO are not consultation columns, so each row picks them up from an
// appointment on the same day when there is one; that keeps the popup's table
// (Date / Slot / Doctor / MO / Type) filled in.
export async function fetchVisitHistory(patientId) {
  const { rows } = await pool.query(
    `WITH cons AS (
       SELECT id, visit_date, visit_type, mo_name, con_name, status, created_at,
              'consultation' AS source_type
       FROM consultations WHERE patient_id = $1
     ),
     appts AS (
       SELECT id, appointment_date AS visit_date, visit_type,
              assigned_mo AS mo_name, doctor_name AS con_name, status, created_at,
              'appointment' AS source_type
       FROM appointments
       WHERE patient_id = $1 AND healthray_id IS NOT NULL AND appointment_date IS NOT NULL
     ),
     deduped AS (
       SELECT * FROM cons
       UNION ALL
       SELECT a.* FROM appts a
       WHERE NOT EXISTS (SELECT 1 FROM cons c WHERE c.visit_date::date = a.visit_date::date)
     )
     SELECT d.id,
            d.visit_date,
            d.visit_type,
            d.status,
            d.source_type,
            d.con_name AS doctor_name,
            COALESCE(
              d.mo_name,
              (SELECT NULLIF(TRIM(a.assigned_mo), '') FROM appointments a
                WHERE a.patient_id = $1 AND a.appointment_date = d.visit_date::date
                  AND NULLIF(TRIM(a.assigned_mo), '') IS NOT NULL
                ORDER BY a.id LIMIT 1)
            ) AS assigned_mo,
            (SELECT a.time_slot FROM appointments a
              WHERE a.patient_id = $1 AND a.appointment_date = d.visit_date::date
                AND a.time_slot IS NOT NULL
              ORDER BY a.id LIMIT 1) AS time_slot
       FROM deduped d
      ORDER BY d.visit_date DESC, d.created_at DESC`,
    [patientId],
  );

  const seen = new Set();
  return rows
    .filter((c) => {
      const key = `${c.visit_date}|${c.status}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((c) => ({ ...c, appointment_date: c.visit_date }));
}
