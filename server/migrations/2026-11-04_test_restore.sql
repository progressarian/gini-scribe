-- ============================================================
-- Gini Flow — restore a mistakenly cancelled test (doc 58).
-- 2026-11-04
--
--   node migrations/_runOne.mjs migrations/2026-11-04_test_restore.sql
-- ============================================================

ALTER TABLE giniflow_test_cancellations
  ADD COLUMN IF NOT EXISTS restored_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS restored_by INTEGER REFERENCES doctors(id),
  ADD COLUMN IF NOT EXISTS restored_role TEXT;

CREATE INDEX IF NOT EXISTS idx_giniflow_test_cancellations_day
  ON giniflow_test_cancellations (visit_date, kind);
