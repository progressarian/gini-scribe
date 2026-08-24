ALTER TABLE patients
  ADD COLUMN IF NOT EXISTS alt_phone TEXT;

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS alt_phone TEXT;

CREATE INDEX IF NOT EXISTS idx_patients_alt_phone ON patients(alt_phone) WHERE alt_phone IS NOT NULL;
