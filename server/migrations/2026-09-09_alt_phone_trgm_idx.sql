CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_appt_alt_phone_text_trgm
  ON appointments USING gin (alt_phone_text(alt_phone) gin_trgm_ops);
