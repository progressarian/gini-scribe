CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_appointments_phone_last10
  ON appointments (RIGHT(phone, 10));
