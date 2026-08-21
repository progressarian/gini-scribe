ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS patient_category TEXT;

CREATE INDEX IF NOT EXISTS idx_appointments_category_date
  ON appointments (appointment_date, patient_category)
  WHERE patient_category IS NOT NULL;
