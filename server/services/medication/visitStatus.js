// Stamp `visit_status` ('current' | 'previous') on every active medication row
// for a patient. Called from every write path that adds, edits, stops, or
// re-prescribes a medication, so readers (scribe UI, summary route, genie
// app screens) can filter on the column instead of re-deriving the bucket
// from `last_prescribed_date` at render time.
//
// "Current" = rows that share the latest `last_prescribed_date` AND were
// touched in the most recent write burst on that day (within
// CURRENT_BURST_MINUTES of the newest `updated_at`). The burst window
// catches the case where HealthRay delivers an old prescription first and
// the new one a few minutes later for the same appointment date — the
// older write cluster gets demoted to 'previous' even though both share
// the same `last_prescribed_date`.
//
// Rows with NULL `last_prescribed_date` stay 'current' as a safe default.
import pool from "../../config/db.js";

// Meds touched within this many minutes of the newest updated_at on the
// latest visit day count as part of the same prescription burst. Anything
// older is treated as a prior pass and demoted to 'previous'.
// In-app prescription edits land one med at a time but a full prescription
// is always done within ~10 minutes, so 10 keeps an in-progress visit's
// meds together while still splitting the HealthRay "old prescription, then
// new prescription" case where the two writes land further apart with the
// same last_prescribed_date.
const CURRENT_BURST_MINUTES = 10;

export async function markMedicationVisitStatus(patientId, db = pool) {
  if (!patientId) return;
  // Every active med is treated as part of the current visit. We no longer
  // demote active rows to 'previous' based on last_prescribed_date — that
  // bucketing was silently moving manually-added meds into "Previous visits"
  // when other rows had a newer last_prescribed_date.
  await db.query(
    `UPDATE medications
        SET visit_status = 'current'
      WHERE patient_id = $1
        AND is_active = true
        AND visit_status IS DISTINCT FROM 'current'`,
    [patientId],
  );
}
