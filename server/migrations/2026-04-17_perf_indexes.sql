-- Performance indexes for hot read paths.
-- Run manually against prod. CONCURRENTLY avoids blocking writes; each statement
-- must run outside a transaction block (psql: use \i or run one statement at a time).
--
-- Rationale (see /home/sahil/.claude/plans/could-you-please-check-rosy-music.md):
--  * visit.js, opd.js, and active-visits.js filter lab_results/diagnoses/medications/
--    consultations/appointments by patient_id + date or + is_active on every page
--    load. Without these indexes Postgres does sequential scans.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_lab_results_patient_date
  ON lab_results (patient_id, test_date DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_lab_results_patient_canonical_date
  ON lab_results (patient_id, canonical_name, test_date DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_diagnoses_patient_active
  ON diagnoses (patient_id, is_active);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_medications_patient_active
  ON medications (patient_id, is_active);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_consultations_patient_date
  ON consultations (patient_id, visit_date DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_appointments_patient_date
  ON appointments (patient_id, appointment_date DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_appointments_date
  ON appointments (appointment_date);

-- active_visits is filtered by (doctor_id, status='in-progress') on every OPD
-- request. Partial index is tiny (only in-progress rows) and makes the lookup O(log n).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_active_visits_doctor_status
  ON active_visits (doctor_id, status) WHERE status = 'in-progress';

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_lab_cases_patient
  ON lab_cases (patient_id, results_synced, case_date);
