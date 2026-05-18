-- Allow multiple patients to share the same phone number
-- (e.g. family members using one contact number).
-- Drops the unique index on patients.phone and replaces it with a plain index.

DROP INDEX IF EXISTS idx_patients_phone;

ALTER TABLE patients DROP CONSTRAINT IF EXISTS patients_phone_key;

CREATE INDEX IF NOT EXISTS idx_patients_phone ON patients(phone) WHERE phone IS NOT NULL;
