CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_lab_cases_outside_pending
  ON lab_cases (outside_stage) WHERE outside_stage IN ('collected', 'sent');
