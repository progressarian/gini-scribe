CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_medications_consultation_id
  ON medications (consultation_id);
