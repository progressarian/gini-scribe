-- Reception's record of a home sample: what the home collection staff reported
-- (docs/gini-flow/78-RECEPTION-HOME-SAMPLE-PLAN.md §5.1).
--
-- Insert-only: the newest row per visit is the current answer, the older rows
-- are its history. No bill, payment or lab table is touched by this record.
--
--   node migrations/_runOne.mjs migrations/2026-12-04_home_sample_records.sql

CREATE TABLE IF NOT EXISTS giniflow_home_samples (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id UUID NOT NULL REFERENCES giniflow_visits(id) ON DELETE CASCADE,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  visit_date DATE NOT NULL,
  sample TEXT NOT NULL CHECK (sample IN ('collected', 'not_collected')),
  collected_at TIMESTAMPTZ,
  collected_by TEXT,
  payment TEXT CHECK (payment IN ('paid', 'pending')),
  amount NUMERIC(10, 2),
  mode TEXT CHECK (mode IN ('cash', 'upi', 'card')),
  note TEXT,
  entered_by INTEGER REFERENCES doctors(id),
  entered_role TEXT,
  entered_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_giniflow_home_samples_visit
  ON giniflow_home_samples (visit_id, entered_at DESC);

CREATE INDEX IF NOT EXISTS idx_giniflow_home_samples_day
  ON giniflow_home_samples (visit_date);
