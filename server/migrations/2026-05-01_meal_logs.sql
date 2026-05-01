-- 2026-05-01: meal_logs table for gini patients using the patient app.
--
-- Context: when the dual-DB routing went live, gini-flagged patients
-- read/write all of their data in the gini DB (this Postgres). The Genie DB
-- has a meal_logs table; we mirror its shape here so gini patients have a
-- self-contained store and we never need to do cross-DB writes.

CREATE TABLE IF NOT EXISTS meal_logs (
  id              BIGSERIAL PRIMARY KEY,
  patient_id      INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  meal_type       TEXT,                 -- 'breakfast' | 'lunch' | 'snack' | 'dinner'
  description     TEXT,
  logged_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  calories        REAL,
  protein_g       REAL,
  carbs_g         REAL,
  fat_g           REAL,
  fiber_g         REAL,
  sugar_g         REAL,
  sodium_mg       REAL,
  source          TEXT DEFAULT 'patient_app',
  source_id       TEXT,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_meal_logs_patient_logged
  ON meal_logs (patient_id, logged_at DESC);

-- Idempotency for imports from the Genie DB (genie row.id → source_id).
CREATE UNIQUE INDEX IF NOT EXISTS uq_meal_logs_source
  ON meal_logs (source, source_id)
  WHERE source_id IS NOT NULL;
