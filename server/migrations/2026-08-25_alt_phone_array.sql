-- alt_phone becomes a list: a patient can hand out a spouse's number, an
-- attendant's, a second mobile. The single-value column is converted in place,
-- so numbers already captured survive as one-element arrays.

DROP INDEX IF EXISTS idx_patients_alt_phone;

ALTER TABLE patients
  ALTER COLUMN alt_phone TYPE TEXT[]
  USING CASE
    WHEN alt_phone IS NULL OR btrim(alt_phone) = '' THEN NULL
    ELSE ARRAY[btrim(alt_phone)]
  END;

ALTER TABLE appointments
  ALTER COLUMN alt_phone TYPE TEXT[]
  USING CASE
    WHEN alt_phone IS NULL OR btrim(alt_phone) = '' THEN NULL
    ELSE ARRAY[btrim(alt_phone)]
  END;

CREATE INDEX IF NOT EXISTS idx_patients_alt_phone ON patients USING gin (alt_phone);
CREATE INDEX IF NOT EXISTS idx_appointments_alt_phone ON appointments USING gin (alt_phone);
