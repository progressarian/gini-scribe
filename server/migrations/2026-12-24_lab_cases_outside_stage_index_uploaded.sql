CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_lab_cases_outside_uploaded
  ON lab_cases (outside_uploaded_at) WHERE outside_stage = 'uploaded';
