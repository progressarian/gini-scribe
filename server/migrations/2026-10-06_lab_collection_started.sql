-- Lab 1 gets a "Start collection" step, so a patient at the bench holds the
-- other test stations off until the sample is collected
-- (docs/gini-flow/50-STATION-CALL-IN-PLAN.md, Phase 1).
--
-- Gini Flow orders need nothing: giniflow_lab_orders.sample_status has no
-- CHECK, and the new status `drawing` comes from shared/labStages.js.
-- HealthRay cases record the floor's steps in giniflow_lab_case_actions, whose
-- action list IS constrained — widened here by one value, nothing removed.
--
--   node migrations/_runOne.mjs migrations/2026-10-06_lab_collection_started.sql

ALTER TABLE giniflow_lab_case_actions
  DROP CONSTRAINT IF EXISTS giniflow_lab_case_actions_action_check;

ALTER TABLE giniflow_lab_case_actions
  ADD CONSTRAINT giniflow_lab_case_actions_action_check
  CHECK (action = ANY (ARRAY[
    'chased', 'drawing_started', 'sample_taken', 'sample_sent', 'sample_received',
    'processing', 'results_ready', 'report_uploaded'
  ]));

-- A coordinator releasing a patient stuck at a station writes who, when and
-- why. Orders keep the reason on their own event row; HealthRay cases have no
-- event row to carry it, so the coordinator's log gains a note.
ALTER TABLE giniflow_triage_events
  ADD COLUMN IF NOT EXISTS note TEXT;
