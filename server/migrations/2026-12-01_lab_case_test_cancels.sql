-- ============================================================
-- Gini Flow — cancel one test of a HealthRay lab case (doc 77).
-- 2026-12-01
--
--   node migrations/_runOne.mjs migrations/2026-12-01_lab_case_test_cancels.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS giniflow_lab_case_test_cancels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_no TEXT NOT NULL,
  test_name TEXT NOT NULL,
  reason TEXT NOT NULL,
  note TEXT,
  request_id UUID REFERENCES billing_requests(id),
  actor_id INTEGER REFERENCES doctors(id),
  actor_role TEXT,
  cancelled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (case_no, test_name)
);

CREATE INDEX IF NOT EXISTS idx_giniflow_lab_case_test_cancels_case
  ON giniflow_lab_case_test_cancels (case_no);
