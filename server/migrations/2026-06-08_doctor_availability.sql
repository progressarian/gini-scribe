-- ============================================================
-- Doctor availability — per-date marking model
-- 2026-06-08 (supersedes the weekly-schedule model)
--
-- A doctor's availability is now an explicit set of (date, slot) entries they
-- mark. No entry for a date+slot = not available. Replaces the recurring
-- weekly schedule + recurring breaks (a "break" is simply an unmarked slot).
-- Leave / emergency / clinic holiday / capacity still layer on top.
-- Additive + idempotent. Drops the now-unused weekly tables (they are empty).
-- ============================================================

-- ── Per-date availability (Layer 0 — base) ──────────────────
CREATE TABLE IF NOT EXISTS doctor_availability (
  id           SERIAL PRIMARY KEY,
  doctor_id    INTEGER NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  doctor_name  TEXT,
  avail_date   DATE NOT NULL,
  slot_label   TEXT NOT NULL REFERENCES slot_catalog(label),
  capacity     INTEGER NOT NULL DEFAULT 5 CHECK (capacity >= 0),
  created_by   TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (doctor_id, avail_date, slot_label)
);
CREATE INDEX IF NOT EXISTS idx_doctor_avail_date
  ON doctor_availability (doctor_id, avail_date);
CREATE INDEX IF NOT EXISTS idx_doctor_avail_date_slot
  ON doctor_availability (avail_date, slot_label);

-- ── Remove the superseded weekly-schedule model (empty tables) ──
DROP TABLE IF EXISTS doctor_recurring_breaks;
DROP TABLE IF EXISTS doctor_weekly_schedule;
