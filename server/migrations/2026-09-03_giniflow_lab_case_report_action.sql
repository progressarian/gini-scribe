-- Admin may attach a report to a HealthRay-run case (see uploadLabCaseReport).
-- The action table's CHECK predates that, so it would reject the audit row the
-- upload writes. Widened rather than dropped: the point of the constraint is
-- that only known actions are recorded.
ALTER TABLE giniflow_lab_case_actions DROP CONSTRAINT IF EXISTS giniflow_lab_case_actions_action_check;
ALTER TABLE giniflow_lab_case_actions
  ADD CONSTRAINT giniflow_lab_case_actions_action_check
  CHECK (action IN ('chased', 'sample_taken', 'report_uploaded'));
