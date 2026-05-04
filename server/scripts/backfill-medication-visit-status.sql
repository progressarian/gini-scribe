-- Backfill medication.visit_status for stale same-healthrayId rows.
--
-- Background: when HealthRay re-extracts the same prescription (same
-- healthray_id) with a different med list, the rows dropped from the newer
-- extraction keep `notes = 'healthray:<id>'` and the same last_prescribed_date
-- as the rows that survived. The runtime fix in syncMedications uses the
-- sync-start timestamp to demote them, but historical rows in the DB are
-- still mis-tagged as 'current'. This script fixes them in bulk.
--
-- Logic per (patient_id, notes) group, restricted to source='healthray' and
-- notes LIKE 'healthray:%':
--   - Find max(updated_at) within the group.
--   - Any active row whose updated_at is more than 5 seconds older than that
--     max is from a stale earlier extraction → set visit_status = 'previous'.
--
-- Safe to run multiple times — the WHERE clause skips rows already marked
-- 'previous'. Wrap in a transaction so a bad run can be rolled back.

BEGIN;

WITH hr_latest AS (
  SELECT patient_id, notes, MAX(updated_at) AS max_updated
    FROM medications
   WHERE is_active = true
     AND source = 'healthray'
     AND notes LIKE 'healthray:%'
   GROUP BY patient_id, notes
),
stale AS (
  SELECT m.id
    FROM medications m
    JOIN hr_latest h
      ON h.patient_id = m.patient_id
     AND h.notes = m.notes
   WHERE m.is_active = true
     AND m.source = 'healthray'
     AND m.notes LIKE 'healthray:%'
     AND m.updated_at < h.max_updated - INTERVAL '5 seconds'
     AND m.visit_status IS DISTINCT FROM 'previous'
)
UPDATE medications
   SET visit_status = 'previous',
       updated_at = NOW()
 WHERE id IN (SELECT id FROM stale);

-- Inspect the affected counts before committing.
-- Run this select inside the same transaction to preview:
--   SELECT patient_id, COUNT(*) FROM medications
--    WHERE visit_status = 'previous' GROUP BY patient_id ORDER BY 2 DESC LIMIT 20;

COMMIT;
