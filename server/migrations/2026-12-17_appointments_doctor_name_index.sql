CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_appointments_doctor_name
  ON appointments (doctor_name) WHERE doctor_name IS NOT NULL;
