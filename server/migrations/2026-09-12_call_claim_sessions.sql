-- ============================================================
-- Calling-flag sessions: who pressed "Calling", and for how long.
-- 2026-09-12
--
-- The claim on appointments (calling_by / calling_by_id / calling_since) is
-- live state only: it holds one row at a time and is overwritten by the next
-- claim, so the moment an agent releases the flag every trace that they ever
-- held it is gone. Nothing records who worked which patient, and there is no
-- way to answer "how long was that call" after the fact.
--
-- This is deliberately NOT call_attempts. An attempt has an outcome and feeds
-- attempt_no and the per-patient attempt counts the calling rounds are driven
-- by; pressing the flag is not an outcome, and auto-writing attempts on every
-- press would inflate those counts for calls that never connected.
--
-- ended_reason distinguishes a real release from the 10-minute TTL lapsing:
-- an expired session's duration is a floor, not a measurement, because the
-- agent may have closed the tab mid-call. The UI renders those as "10m+".
--
-- Idempotent.
-- ============================================================

CREATE TABLE IF NOT EXISTS call_claim_sessions (
  id             SERIAL PRIMARY KEY,
  appointment_id INTEGER NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  patient_id     INTEGER REFERENCES patients(id) ON DELETE SET NULL,
  called_by      TEXT,
  called_by_id   INTEGER,
  started_at     TIMESTAMPTZ NOT NULL,
  ended_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  duration_secs  INTEGER,
  ended_reason   TEXT NOT NULL DEFAULT 'released',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_call_claim_sessions_appt
  ON call_claim_sessions (appointment_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_call_claim_sessions_who
  ON call_claim_sessions (called_by_id, started_at DESC);
