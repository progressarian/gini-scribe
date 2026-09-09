-- The hospital's own cases reach us through `labSync`, and HealthRay tells us a
-- sample was drawn only when the RESULTS come back — `collected_on` arrives with
-- `raw_detail_json`, which `markLabCaseSynced` writes once results are parseable,
-- hours after the tube left the patient. `phlebotomy_status` is the only live
-- field and the hospital's phlebotomists do not fill it in: on 02, 06, 07 and 09
-- September it read "Completed" on zero cases out of 107, every one of which was
-- actually drawn.
--
-- So the floor had no way to say what it had done. On 09 September nineteen of
-- twenty-four cases had a collection recorded here by the technician and every
-- one of them still displayed "Collect now", because only `sample_taken` existed
-- and nothing read it. The lab's whole morning was invisible on the lab's own
-- screen.
--
-- These two verbs complete the chain the Gini-ordered queue already has
-- (`SAMPLE_FLOW`): collected → processing → results ready. They record what the
-- lab did, they never reach HealthRay, and HealthRay's own timestamps still win
-- wherever it is further ahead.
ALTER TABLE giniflow_lab_case_actions
  DROP CONSTRAINT IF EXISTS giniflow_lab_case_actions_action_check;

ALTER TABLE giniflow_lab_case_actions
  ADD CONSTRAINT giniflow_lab_case_actions_action_check
  CHECK (action IN ('chased', 'sample_taken', 'processing', 'results_ready', 'report_uploaded'));
