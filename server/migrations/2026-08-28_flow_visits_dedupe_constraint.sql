-- Closes a TOCTOU race in POST /api/flow/checkin: the duplicate-visit guard
-- there is a plain SELECT-then-INSERT with no lock, so two near-simultaneous
-- check-in requests for the same patient (double-click, two receptionists)
-- could both pass the check and create two active flow_visits rows for the
-- same patient on the same day. These partial unique indexes make Postgres
-- itself reject the second insert, matching the same statuses the app-level
-- dup check already treats as "counts as checked in" (a deliberately
-- cancelled visit does not block a fresh check-in).

CREATE UNIQUE INDEX IF NOT EXISTS uq_flow_visits_patient_active_day
  ON flow_visits (patient_id, visit_date)
  WHERE status IN ('in_progress', 'waiting', 'paused', 'completed');

CREATE UNIQUE INDEX IF NOT EXISTS uq_flow_visits_appointment_active
  ON flow_visits (appointment_id)
  WHERE appointment_id IS NOT NULL
    AND status IN ('in_progress', 'waiting', 'paused', 'completed');
