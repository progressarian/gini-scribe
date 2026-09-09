CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_appt_file_no_date
  ON appointments (file_no, appointment_date DESC)
  WHERE file_no IS NOT NULL;
