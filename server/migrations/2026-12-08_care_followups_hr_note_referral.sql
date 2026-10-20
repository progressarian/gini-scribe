-- Referrals written in the doctor's HealthRay note ("Advised consult with
-- rheumatologist for hip pain") become care follow-ups too
-- (docs/gini-flow/81-CARE-COORDINATOR-FOLLOWUPS-PLAN.md, "HealthRay note referrals").
--
-- Only widens the allowed sources. Existing rows already satisfy the new check.
--
--   node migrations/_runOne.mjs migrations/2026-12-08_care_followups_hr_note_referral.sql

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE care_followups DROP CONSTRAINT IF EXISTS care_followups_source_check;
ALTER TABLE care_followups
  ADD CONSTRAINT care_followups_source_check
  CHECK (source IN ('gf_referral', 'rx_referral', 'next_visit_order', 'hr_follow_up', 'hr_note_referral'))
  NOT VALID;
ALTER TABLE care_followups VALIDATE CONSTRAINT care_followups_source_check;

COMMIT;
