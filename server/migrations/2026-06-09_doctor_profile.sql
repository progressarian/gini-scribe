-- ============================================================
-- Doctor working profile — "available by default" model
-- 2026-06-09 (supersedes per-date doctor_availability)
--
-- A doctor is available by default every working day, all slots. The profile
-- only customizes exceptions to that default:
--   off_weekdays  : weekdays the doctor does NOT work (default {0} = Sunday)
--   working_slots : NULL = all slots; else the subset they work
--   lunch_slots   : recurring daily break slots (e.g. {'1 PM to 2 PM'})
-- Date-specific leave/holiday/break stay in doctor_unavailability.
-- Additive + idempotent. Drops the now-unused per-date table.
-- ============================================================

CREATE TABLE IF NOT EXISTS doctor_profile (
  doctor_id      INTEGER PRIMARY KEY REFERENCES doctors(id) ON DELETE CASCADE,
  off_weekdays   SMALLINT[] NOT NULL DEFAULT '{0}', -- 0=Sun..6=Sat; Sunday off
  working_slots  TEXT[],                            -- NULL = all slots
  lunch_slots    TEXT[],                            -- recurring daily break
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

-- The per-date marking model is replaced by the implicit default + profile.
DROP TABLE IF EXISTS doctor_availability;
