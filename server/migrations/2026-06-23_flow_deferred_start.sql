-- Deferred-start ("start timer later") for patient-flow check-ins.
--
-- Real-life: a patient is registered at reception but then waits for the
-- doctor to arrive (or wants their slot moved). We don't want the visit timer
-- running during that limbo. So a check-in can be parked in a new 'waiting'
-- status with the clock stopped, and reception presses ▶ Start when the visit
-- actually begins (▶ Stop resets it back to 'waiting' at 0).
--
-- The authoritative clock is now `timer_started_at` (NULL while waiting);
-- classifyVisit() falls back to `checkin_time` for legacy rows that predate
-- this column, so existing in-progress visits keep timing correctly.
--
-- Apply:  node migrations/_runOne.mjs migrations/2026-06-23_flow_deferred_start.sql

ALTER TABLE flow_visits
  ADD COLUMN IF NOT EXISTS timer_started_at TIMESTAMPTZ;

-- Backfill: every existing visit's timer started at its check-in time, so the
-- elapsed math is unchanged for visits created before this migration.
UPDATE flow_visits SET timer_started_at = checkin_time WHERE timer_started_at IS NULL;

-- Widen the status check to allow the new parked state.
ALTER TABLE flow_visits DROP CONSTRAINT IF EXISTS flow_visits_status_check;
ALTER TABLE flow_visits
  ADD CONSTRAINT flow_visits_status_check
  CHECK (status IN ('in_progress','completed','cancelled','waiting'));
