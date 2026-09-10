-- Two rungs the lab ladder never had: the handoff between the collection bench
-- and the analyzer bench (docs/gini-flow/35-LAB-TWO-ROOM-SPLIT-PLAN.md §2.3).
--
-- Until now a tube went from `sample_taken` straight to `processing`, so a
-- sample drawn at 09:10 and still sitting in a rack in the collection room at
-- 11:40 was indistinguishable from one on the analyzer. Nobody owned the gap,
-- and nothing on any screen could show it.
--
-- `sample_sent` is the collection room's last act; `sample_received` is the lab
-- room's first. Both are the floor's own record — nothing reaches HealthRay,
-- which stamps its four clocks at sign-out and can never speak to either step.
ALTER TABLE giniflow_lab_case_actions
  DROP CONSTRAINT IF EXISTS giniflow_lab_case_actions_action_check;

ALTER TABLE giniflow_lab_case_actions
  ADD CONSTRAINT giniflow_lab_case_actions_action_check
  CHECK (action IN ('chased', 'sample_taken', 'sample_sent', 'sample_received',
                    'processing', 'results_ready', 'report_uploaded'));
