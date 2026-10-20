-- Where today's lab sample is taken, as set by reception (Bill tab) or the lab
-- collection station (docs/gini-flow/78-RECEPTION-HOME-SAMPLE-PLAN.md §11).
--
-- Additive only. NULL means nobody set it on the floor, and the booking tick
-- or the patient-app request decides, exactly as before.
--
-- giniflow_visits is read by every live screen, so the change waits at most
-- 5 seconds for its lock instead of queueing behind the floor, and the check
-- is added NOT VALID (no table scan under the lock) then validated separately.
-- If it prints a lock timeout, run it again.
--
--   node migrations/_runOne.mjs migrations/2026-12-05_visit_lab_site.sql

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE giniflow_visits
  ADD COLUMN IF NOT EXISTS lab_site TEXT,
  ADD COLUMN IF NOT EXISTS lab_site_by INTEGER REFERENCES doctors(id),
  ADD COLUMN IF NOT EXISTS lab_site_at TIMESTAMPTZ;

ALTER TABLE giniflow_visits
  DROP CONSTRAINT IF EXISTS giniflow_visits_lab_site_check;

ALTER TABLE giniflow_visits
  ADD CONSTRAINT giniflow_visits_lab_site_check
  CHECK (lab_site IS NULL OR lab_site IN ('home', 'ghm')) NOT VALID;

COMMIT;

ALTER TABLE giniflow_visits VALIDATE CONSTRAINT giniflow_visits_lab_site_check;
