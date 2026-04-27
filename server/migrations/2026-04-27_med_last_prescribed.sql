-- Track the date a medication was last (re-)prescribed, independent of when
-- the patient first started it. The `started_date` column is pinned to the
-- earliest known start (so the UI can show "Since DD MMM YYYY"), which means
-- it cannot also serve as the "which visit was this on" signal.
--
-- Without this column, the visit page falls back to comparing started_date /
-- prescribed_date and incorrectly buckets re-prescribed long-running meds
-- under "Previous Visit Medications" whenever a newly-started drug exists
-- with a more recent started_date.
ALTER TABLE medications ADD COLUMN IF NOT EXISTS last_prescribed_date DATE;

-- Backfill: for existing rows seed last_prescribed_date with the best signal
-- we have today. Priority order:
--   1. Linked consultation visit_date (manual / scribe-authored meds).
--   2. updated_at::date for HealthRay-sourced rows — syncMedications stamps
--      updated_at = NOW() every time a prescription re-touches the row, so
--      this is effectively the last sync date.
--   3. started_date as a final fallback.
-- Subsequent HealthRay syncs will overwrite this with the actual prescription
-- (apptDate) going forward.
UPDATE medications m
   SET last_prescribed_date = COALESCE(c.visit_date, m.started_date)
  FROM consultations c
 WHERE m.consultation_id = c.id
   AND m.last_prescribed_date IS NULL;

UPDATE medications
   SET last_prescribed_date = updated_at::date
 WHERE last_prescribed_date IS NULL
   AND source = 'healthray'
   AND updated_at IS NOT NULL;

UPDATE medications
   SET last_prescribed_date = started_date
 WHERE last_prescribed_date IS NULL
   AND started_date IS NOT NULL;
