-- Triage board — docs/gini-flow/18-TRIAGE-BOARD-PLAN.md §8.
--
-- `category`, `assigned_sd_id`, `assigned_doctor_id` and `lifestyle_flagged`
-- already exist on giniflow_visits; nothing about the board needs a new table.
-- What is missing is the provenance of the category: the day's sweep re-runs
-- whenever a report lands, and it must never overwrite a judgement the
-- coordinator made by hand. `category_source` is that guard — the sweep writes
-- only rows where it is NULL or 'auto'.
--
-- Idempotent — safe to re-run.

ALTER TABLE giniflow_visits
  ADD COLUMN IF NOT EXISTS category_source TEXT,
  ADD COLUMN IF NOT EXISTS category_set_by INT REFERENCES doctors(id),
  ADD COLUMN IF NOT EXISTS category_set_at TIMESTAMPTZ;

COMMENT ON COLUMN giniflow_visits.category_source IS
  'auto | coordinator — who last set category. The auto sweep skips coordinator rows.';

-- The sweep's own filter: one day's rows that auto may still write.
CREATE INDEX IF NOT EXISTS idx_giniflow_visits_category_source
  ON giniflow_visits (visit_date, category_source);
