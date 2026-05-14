-- 2026-05-14 — FOLLOW UP WITH (free-text prep instructions for the next visit)
--
-- Captured on the prescription by the doctor (e.g. "Fasting sample at 8:30am.
-- Bring HbA1c, FBG, Lipids. Omit antidiabetic for 24 hrs.") so the patient
-- knows how to prepare for their upcoming appointment.
--
-- Lives in two places:
--   1. consultations.con_data.follow_up_with — JSON key, source of truth for
--      the visit-level write/edit (see PATCH /api/visit/:id/follow-up-with).
--   2. appointments.follow_up_with — denormalised onto the patient's
--      upcoming appointment row so the MyHealth Genie patient app (which
--      reads scribe's appointments table directly via giniSupabase →
--      vuukipgdegewpwucdgxa) can render it on the Care → Appts card
--      without a join into JSONB.
--
-- Run against the scribe Postgres (Supabase project vuukipgdegewpwucdgxa).
-- Idempotent — safe to re-run.

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS follow_up_with TEXT;

COMMENT ON COLUMN appointments.follow_up_with IS
  'Doctor-authored free-text patient prep instructions for THIS appointment. '
  'Sourced from consultations.con_data.follow_up_with on the most recent prior '
  'consultation. Shown on Genie Care → Appts card and printed on the previous '
  'visit''s prescription PDF.';
