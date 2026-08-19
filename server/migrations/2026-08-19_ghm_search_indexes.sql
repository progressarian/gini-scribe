
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_appt_preferred_date
  ON appointments (preferred_date)
  WHERE preferred_date IS NOT NULL;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_appt_patient_name_trgm
  ON appointments USING gin (patient_name gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_appt_file_no_trgm
  ON appointments USING gin (file_no gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_appt_phone_trgm
  ON appointments USING gin (phone gin_trgm_ops);
