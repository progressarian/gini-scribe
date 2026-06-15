-- ============================================================
-- Configurable "chief" flag on doctors
-- 2026-06-15
--
-- The clinic's flow has a Chief consultation step (escalation doctor). There is
-- no role that marks a chief — every senior doctor is role='consultant' — so we
-- add an editable flag instead of hardcoding a name in app logic. The flow
-- check-in derives a patient's chief from this flag (+ their visit history).
--
-- Seeded for the clinic's current chief as a sensible default; admins can change
-- who is/isn't a chief (it's just data). Idempotent.
-- ============================================================

ALTER TABLE doctors ADD COLUMN IF NOT EXISTS is_chief BOOLEAN DEFAULT false;

-- Default config: mark the current chief consultant. Editable later.
UPDATE doctors SET is_chief = true WHERE name ILIKE '%bhansali%' AND is_active;
