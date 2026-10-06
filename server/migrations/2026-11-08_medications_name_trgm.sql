CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_medications_name_trgm
  ON medications USING gin (name gin_trgm_ops);
