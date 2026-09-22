CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_appointments_healthray_updated_at
  ON appointments (updated_at DESC)
  WHERE healthray_id IS NOT NULL;
