-- ============================================================
-- Gini Flow — vitals recorded at the station.
-- 2026-08-31
--
-- Module-owned, NOT the shared clinical `vitals` table. Two reasons:
--
--   1. The old station module sets the precedent: it records station vitals in
--      its own step data and never writes `vitals`. That table is Scribe's
--      clinical record, written by the consult save, the HealthRay sync, /opd
--      and /visit. Adding a third writer while two floor modules run in parallel
--      invites the same patient being recorded twice with different numbers.
--   2. The separation rule: Gini Flow owns its own state.
--
-- Deliberately NOT the last word. When Gini Flow becomes the authoritative floor
-- system, a reading taken here should be promoted into `vitals` so it reaches
-- the patient's record and the doctor's consult view — see 06-PHASE-2-PLAN.md
-- question 12. Until then a station reading lives here and the clinical record
-- is unaffected.
--
-- Columns mirror `vitals` so that promotion is a straight copy, not a mapping.
--
--   node migrations/_runOne.mjs migrations/2026-08-31_giniflow_vitals.sql
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS giniflow_vitals (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id     UUID NOT NULL REFERENCES giniflow_visits(id) ON DELETE CASCADE,
  patient_id   INT  NOT NULL REFERENCES patients(id),
  weight       NUMERIC(6,2),
  height       NUMERIC(6,2),
  bmi          NUMERIC(5,2),
  bp_sys       INT,
  bp_dia       INT,
  pulse        INT,
  spo2         INT,
  temp         NUMERIC(5,2),
  source       TEXT NOT NULL DEFAULT 'manual',   -- manual | voice
  recorded_by  INT REFERENCES doctors(id),
  recorded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  promoted_at  TIMESTAMPTZ,                       -- set if/when copied into `vitals`
  meta         JSONB NOT NULL DEFAULT '{}'
);

-- One reading per visit is the normal case; a correction is a new row, and the
-- latest wins. Ordered by visit so the station and the timeline read the newest.
CREATE INDEX IF NOT EXISTS idx_giniflow_vitals_visit
  ON giniflow_vitals (visit_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_giniflow_vitals_patient
  ON giniflow_vitals (patient_id, recorded_at DESC);
