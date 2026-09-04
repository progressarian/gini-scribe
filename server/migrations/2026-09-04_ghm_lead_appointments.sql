-- A caller must be able to ring a patient who has no appointment at all — to
-- book their first one, or to record that they could not be reached and did not
-- want one. Every call column lives on `appointments`, so those calls had
-- nowhere to go and the sheet 404'd on them.
--
-- A lead is an appointments row with NO date: a call record, not a booking.
-- `appointment_date IS NULL` is the marker (there were zero dateless rows
-- before this migration), and `status = 'lead'` makes it readable in the table.
-- The day lists all key on a date, so a lead can never appear on Today,
-- Tomorrow or Follow-up — only in Patient Lookup, where the caller found them.
ALTER TABLE appointments ALTER COLUMN appointment_date DROP NOT NULL;

-- One lead per patient, ever. Repeat calls reuse the same row rather than
-- leaving a trail of empty appointments behind them.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_appt_lead_per_patient
  ON appointments (patient_id)
  WHERE appointment_date IS NULL;
