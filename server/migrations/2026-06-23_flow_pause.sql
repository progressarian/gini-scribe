-- Pause/resume for in-flight patient-flow visits.
--
-- Builds on the deferred-start feature. The ▶ Stop control is now conditional:
--   • If no journey step has started/completed yet, Stop resets the visit back
--     to 'waiting' at 0 (handled in app code — no schema needed).
--   • If the journey HAS begun (a step is in_progress or completed), Stop now
--     PAUSES instead: the visit freezes with its elapsed time preserved, and
--     reception presses ▶ Resume to continue where it left off.
--
-- Freeze/resume mechanics: while paused, classifyVisit()/classifyStep() clamp
-- "now" to `paused_at` so the clock stops. On resume we shift timer_started_at,
-- estimated_completion, and the active step's started_at forward by the paused
-- duration — keeping every timestamp real, so step-timing math elsewhere is
-- untouched.
--
-- Apply:  node migrations/_runOne.mjs migrations/2026-06-23_flow_pause.sql

ALTER TABLE flow_visits
  ADD COLUMN IF NOT EXISTS paused_at TIMESTAMPTZ;

-- Widen the status check to allow the new paused state.
ALTER TABLE flow_visits DROP CONSTRAINT IF EXISTS flow_visits_status_check;
ALTER TABLE flow_visits
  ADD CONSTRAINT flow_visits_status_check
  CHECK (status IN ('in_progress','completed','cancelled','waiting','paused'));
