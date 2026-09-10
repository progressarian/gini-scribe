-- ============================================================
-- Audit for scheme daily-cap overrides (33-PATIENT-SCHEME-PLAN.md §6).
-- 2026-09-16
--
-- An admin can book past a full scheme with force=true, reusing the escape
-- hatch bookingGuard.js already has. Every one of those is written down here.
--
-- Without this the cap is theatre: it will be forced — that is what the escape
-- hatch is for — and nobody will be able to say how often, for which scheme, or
-- by whom. The row records the count AT THE MOMENT of the override, not a live
-- one, because the interesting question afterwards is "how far past the ceiling
-- were we", and a later cancellation would erase the answer.
--
-- Idempotent.
-- ============================================================

CREATE TABLE IF NOT EXISTS scheme_cap_overrides (
  id                 SERIAL PRIMARY KEY,
  scheme_code        TEXT NOT NULL,
  appointment_date   DATE NOT NULL,
  booked_at_override INTEGER NOT NULL,
  cap_at_override    INTEGER NOT NULL,
  -- Nullable: the override is decided before the insert, and the booking can
  -- still fail for an unrelated reason. An override with no appointment is
  -- itself worth seeing.
  appointment_id     INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
  overridden_by      INTEGER REFERENCES doctors(id),
  -- Denormalised on purpose: the audit must still read years later even if the
  -- account is deleted.
  overridden_by_name TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- "How often was ECHS forced last month" is the question this table exists to
-- answer.
CREATE INDEX IF NOT EXISTS idx_scheme_cap_overrides_lookup
  ON scheme_cap_overrides (scheme_code, appointment_date DESC);
