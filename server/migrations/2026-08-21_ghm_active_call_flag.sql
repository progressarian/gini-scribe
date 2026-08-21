ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS calling_by      TEXT,
  ADD COLUMN IF NOT EXISTS calling_by_id   INTEGER,
  ADD COLUMN IF NOT EXISTS calling_since   TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_appointments_calling_since
  ON appointments (calling_since)
  WHERE calling_since IS NOT NULL;
