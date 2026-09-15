CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_lab_results_panel_name_trgm
  ON lab_results USING gin (panel_name gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_lab_results_test_name_trgm
  ON lab_results USING gin (test_name gin_trgm_ops);
