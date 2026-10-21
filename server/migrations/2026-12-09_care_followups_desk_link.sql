-- The Referrals desk and Care Follow-ups share one referral
-- (docs/gini-flow/83-REFERRALS-DESK-FOLLOWUPS-LINK-PLAN.md).
--
-- Adds the follow-up status 'booked_outside' (the desk recorded an outside
-- specialist's appointment) and the history kind 'desk' (a change made on the
-- Referrals desk). Only widens two checks; existing rows already satisfy them.
--
--   node migrations/_runOne.mjs migrations/2026-12-09_care_followups_desk_link.sql

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE care_followups DROP CONSTRAINT IF EXISTS care_followups_status_check;
ALTER TABLE care_followups
  ADD CONSTRAINT care_followups_status_check
  CHECK (status IN ('open', 'booked', 'booked_outside', 'done', 'not_available', 'declined', 'closed'))
  NOT VALID;
ALTER TABLE care_followups VALIDATE CONSTRAINT care_followups_status_check;

ALTER TABLE care_followup_events DROP CONSTRAINT IF EXISTS care_followup_events_kind_check;
ALTER TABLE care_followup_events
  ADD CONSTRAINT care_followup_events_kind_check
  CHECK (kind IN ('call', 'status', 'note', 'booked', 'auto', 'desk'))
  NOT VALID;
ALTER TABLE care_followup_events VALIDATE CONSTRAINT care_followup_events_kind_check;

COMMIT;
