-- Call attempt history — one row per call made to a patient for an appointment.
-- The appointment keeps its single "latest status" summary columns
-- (call_status, call_made_by, call_date, call_notes, call_reschedule_date);
-- this table records every individual attempt so history is never overwritten.

CREATE TABLE IF NOT EXISTS call_attempts (
  id               SERIAL PRIMARY KEY,
  appointment_id   INTEGER NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  patient_id       INTEGER REFERENCES patients(id),
  attempt_no       INTEGER NOT NULL DEFAULT 1,
  outcome          TEXT,            -- called / not_picked / busy / switched_off / wrong_number / rescheduled / call_later
  called_by        TEXT,
  called_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  duration_mins    NUMERIC,
  notes            TEXT,
  reschedule_date  DATE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_call_attempts_appt    ON call_attempts (appointment_id);
CREATE INDEX IF NOT EXISTS idx_call_attempts_patient ON call_attempts (patient_id);
CREATE INDEX IF NOT EXISTS idx_call_attempts_when    ON call_attempts (called_at);
