-- ============================================================
-- Doctor profile: clock-time working hours + lunch (replaces slot lists)
-- 2026-06-09
--
-- The profile now holds free-text working hours and lunch as TIME ranges
-- (so a doctor types their hours; works for day or night shifts) instead of
-- picking from the fixed slot catalog. A slot is bookable if it falls inside
-- [work_start, work_end] and outside [lunch_start, lunch_end].
-- NULL work hours = available all day (all slots). NULL lunch = no break.
-- Idempotent. doctor_profile is new + (effectively) empty.
-- ============================================================

ALTER TABLE doctor_profile
  DROP COLUMN IF EXISTS working_slots,
  DROP COLUMN IF EXISTS lunch_slots,
  ADD COLUMN IF NOT EXISTS work_start  TIME,
  ADD COLUMN IF NOT EXISTS work_end    TIME,
  ADD COLUMN IF NOT EXISTS lunch_start TIME,
  ADD COLUMN IF NOT EXISTS lunch_end   TIME;
