CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_vitals_patient_recorded
  ON vitals (patient_id, recorded_at DESC);
