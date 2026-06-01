-- Call tracking columns on appointments
-- Lets the daily sheet record call outcomes without a separate table join.
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS call_status        TEXT DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS call_made_by       TEXT,
  ADD COLUMN IF NOT EXISTS call_date          DATE,
  ADD COLUMN IF NOT EXISTS call_notes         TEXT,
  ADD COLUMN IF NOT EXISTS call_reschedule_date DATE;

CREATE INDEX IF NOT EXISTS idx_appt_call_status ON appointments(call_status);
