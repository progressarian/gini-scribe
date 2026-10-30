CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_medications_appointment
  ON medications (appointment_id) WHERE appointment_id IS NOT NULL;
