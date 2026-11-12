-- Adds the follow-up status 'pending': the patient said they will book later.
-- Only widens the status check; existing rows already satisfy it.
--
--   node migrations/_runOne.mjs migrations/2026-12-30_care_followups_pending.sql

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE care_followups DROP CONSTRAINT IF EXISTS care_followups_status_check;
ALTER TABLE care_followups
  ADD CONSTRAINT care_followups_status_check
  CHECK (status IN ('open', 'pending', 'booked', 'booked_outside', 'done', 'not_available', 'declined', 'closed'))
  NOT VALID;
ALTER TABLE care_followups VALIDATE CONSTRAINT care_followups_status_check;

COMMIT;
