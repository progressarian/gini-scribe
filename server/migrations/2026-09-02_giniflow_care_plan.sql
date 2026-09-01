-- ============================================================
-- Gini Flow — the consultant's care plan.
-- 2026-09-02
--
-- docs/gini-flow/13-CONSULTANT-STATION-PLAN.md §8. One row per visit, the same
-- shape giniflow_sd_notes takes for the MO's plan: a UNIQUE visit_id so the
-- screen can upsert on every keystroke-batch without accumulating drafts.
--
-- `goals` is JSONB rather than four columns because the goals a consultant sets
-- are per-patient — HbA1c and FBS for one, eGFR and K+ for another — and the
-- next visit's "in control / worse" classifier reads them by test name:
--   [{ "test": "HbA1c", "target": "<7.0", "unit": "%" }, …]
--
-- next_visit_interval is the chip the prototype shows ("~3 months") and is kept
-- alongside the date rather than derived from it: the doctor's intent and the
-- booked date are different facts, and a date that later moves must not silently
-- rewrite what was said in the room.
--
--   node migrations/_runOne.mjs migrations/2026-09-02_giniflow_care_plan.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS giniflow_care_plans (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id            UUID NOT NULL UNIQUE REFERENCES giniflow_visits(id) ON DELETE CASCADE,
  treatment           TEXT,
  lifestyle           TEXT,
  internal_note       TEXT,
  next_visit_date     DATE,
  next_visit_interval TEXT,
  goals               JSONB NOT NULL DEFAULT '[]'::jsonb,
  source              TEXT NOT NULL DEFAULT 'typed',   -- typed | voice
  authored_by         INT REFERENCES doctors(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
