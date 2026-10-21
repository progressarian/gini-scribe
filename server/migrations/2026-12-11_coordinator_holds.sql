-- A referred patient sees the Care Coordinator before Prescription Explain
-- (docs/gini-flow/84-REFERRAL-COORDINATOR-BEFORE-RX-PLAN.md).
--
-- One hold per visit. Opens when the visit has a referral from any source and
-- closes only by the coordinator's decision, an admin skip, or the referral
-- going away. Additive only.
--
--   node migrations/_runOne.mjs migrations/2026-12-11_coordinator_holds.sql

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS giniflow_coordinator_holds (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id    UUID NOT NULL UNIQUE REFERENCES giniflow_visits(id) ON DELETE CASCADE,
  patient_id  INT  NOT NULL REFERENCES patients(id),
  visit_date  DATE NOT NULL,
  sources     TEXT[] NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'waiting'
              CHECK (status IN ('waiting', 'done', 'skipped')),
  decision    TEXT
              CHECK (decision IS NULL OR decision IN
                     ('booked_ghm', 'booked_outside', 'declined', 'not_available', 'call_later')),
  note        TEXT,
  skip_reason TEXT,
  opened_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  done_at     TIMESTAMPTZ,
  done_by     INT REFERENCES doctors(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (status <> 'done' OR decision IS NOT NULL),
  CHECK (status <> 'skipped' OR skip_reason IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS giniflow_coordinator_holds_day_idx
  ON giniflow_coordinator_holds (visit_date, status);

INSERT INTO flow_step_catalog (id, name, default_duration_min, station, assigned_role)
VALUES ('care_coordinator', 'Care Coordinator', 10, 'Care Coordinator', 'care_coordinator')
ON CONFLICT (id) DO NOTHING;

COMMIT;
