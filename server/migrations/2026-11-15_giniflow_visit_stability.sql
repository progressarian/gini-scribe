ALTER TABLE giniflow_visits
  ADD COLUMN IF NOT EXISTS stability TEXT,
  ADD COLUMN IF NOT EXISTS stability_reasons JSONB,
  ADD COLUMN IF NOT EXISTS stability_at TIMESTAMPTZ;

ALTER TABLE giniflow_visits DROP CONSTRAINT IF EXISTS giniflow_visits_stability_check;
ALTER TABLE giniflow_visits
  ADD CONSTRAINT giniflow_visits_stability_check
  CHECK (stability IS NULL OR stability IN ('stable', 'unstable', 'first', 'no_reports'));
