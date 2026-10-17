-- Home collection: where a sample was taken, and when (docs/HOME_COLLECTION_PLAN.md §1).
--
-- Additive only. Both columns are filled on the `sample_taken` row of a
-- home-collection patient and stay NULL everywhere else, so existing rows and
-- screens are untouched. Scribe floor orders need no column: the
-- `sample_collected` event's meta carries { site, collectedAt }.
--
--   node migrations/_runOne.mjs migrations/2026-12-03_home_collection_site.sql

ALTER TABLE giniflow_lab_case_actions
  ADD COLUMN IF NOT EXISTS collected_at_site TEXT,
  ADD COLUMN IF NOT EXISTS collected_at TIMESTAMPTZ;

ALTER TABLE giniflow_lab_case_actions
  DROP CONSTRAINT IF EXISTS giniflow_lab_case_actions_site_check;

ALTER TABLE giniflow_lab_case_actions
  ADD CONSTRAINT giniflow_lab_case_actions_site_check
  CHECK (collected_at_site IS NULL OR collected_at_site IN ('ghm', 'home'));

CREATE INDEX IF NOT EXISTS idx_giniflow_lab_case_actions_taken
  ON giniflow_lab_case_actions (created_at)
  WHERE action = 'sample_taken';

CREATE INDEX IF NOT EXISTS idx_giniflow_lab_order_events_site
  ON giniflow_lab_order_events ((meta->>'site'), occurred_at)
  WHERE status = 'sample_collected';
