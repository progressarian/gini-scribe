-- Whether Scribe has read the HealthRay notes it holds for an appointment
-- (docs/RX_WAIT_FOR_HEALTHRAY_NOTES_PLAN.md §4.1). The Scribe prescription is
-- only built, and only printed at the Rx desk, once the current notes are read.
--
-- Additive only, no backfill. Appointments on or before the day this runs with
-- no marker count as read (app_kv 'rx_notes_gate_since'), so nothing on the
-- floor waits the day it ships.
--
-- appointments is read by every live screen, so the change waits at most
-- 5 seconds for its lock. If it prints a lock timeout, run it again.
--
--   node migrations/_runOne.mjs migrations/2026-12-25_appointments_notes_read.sql

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS notes_read_hash TEXT,
  ADD COLUMN IF NOT EXISTS notes_read_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS notes_read_status TEXT;

ALTER TABLE appointments
  DROP CONSTRAINT IF EXISTS appointments_notes_read_status_check;

ALTER TABLE appointments
  ADD CONSTRAINT appointments_notes_read_status_check
  CHECK (notes_read_status IS NULL
         OR notes_read_status IN ('read', 'skipped_date_mismatch', 'empty', 'failed')) NOT VALID;

INSERT INTO app_kv (key, value, updated_at)
VALUES ('rx_notes_gate_since', to_jsonb(((NOW() AT TIME ZONE 'Asia/Kolkata')::date)::text), NOW())
ON CONFLICT (key) DO NOTHING;

COMMIT;
