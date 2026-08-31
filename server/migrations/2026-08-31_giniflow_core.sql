-- ============================================================
-- Gini Flow — the spine: one visit per patient per day + the event log.
-- 2026-08-31
--
-- Every timer, colour, average and report in the system derives from
-- giniflow_visit_events. Nothing is stored pre-computed, so the whole board is
-- reconstructible from the log after any crash, reload or device change.
--
-- ⚠️ These tables are NOT the older flow_visits / flow_visit_steps / flow_events.
-- Gini Flow is a separate system that does not read, write or share tables with
-- that module; the old one is retired as a unit later. Only patients, doctors
-- and appointments are shared, because those are the hospital's data rather than
-- either module's. See docs/gini-flow/00-OVERVIEW.md §2.3.
--
-- Status vocabulary lives in shared/giniflowStatus.js — the single definition of
-- the chain, imported by both the server and the client. Statuses are stored as
-- plain TEXT with no CHECK constraint on purpose: the chain will grow as the
-- station screens land, and a CHECK would mean a migration per addition.
--
--   node migrations/_runOne.mjs migrations/2026-08-31_giniflow_core.sql
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()

-- ── One row per patient per OPD day ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS giniflow_visits (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id         INT  NOT NULL REFERENCES patients(id),
  visit_date         DATE NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Kolkata')::date,
  appointment_id     INT  REFERENCES appointments(id),
  appointment_time   TIME,
  current_status     TEXT NOT NULL DEFAULT 'booked',
  results_status     TEXT NOT NULL DEFAULT 'none',
  category           TEXT,
  blocked_reason     TEXT,
  assigned_sd_id     INT  REFERENCES doctors(id),
  assigned_doctor_id INT  REFERENCES doctors(id),
  lifestyle_flagged  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- The core invariant from the brief: ONE visit record per patient per day.
  -- Enforced here rather than in application code — the older module shipped
  -- without it and needed two later migrations to add it back.
  CONSTRAINT giniflow_visits_one_per_patient_day UNIQUE (patient_id, visit_date)
);

-- The board's only hot query: today's visits, grouped by column.
CREATE INDEX IF NOT EXISTS idx_giniflow_visits_day_status
  ON giniflow_visits (visit_date, current_status);

CREATE INDEX IF NOT EXISTS idx_giniflow_visits_patient
  ON giniflow_visits (patient_id);

-- ── The append-only timestamped log ────────────────────────────────────────
-- Never UPDATE a row here. A correction is a new event. Time-at-station is the
-- occurred_at difference between consecutive rows.
CREATE TABLE IF NOT EXISTS giniflow_visit_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id    UUID NOT NULL REFERENCES giniflow_visits(id) ON DELETE CASCADE,
  status      TEXT NOT NULL,
  actor_role  TEXT NOT NULL DEFAULT 'system',
  actor_id    INT  REFERENCES doctors(id),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  meta        JSONB NOT NULL DEFAULT '{}'
);

-- Every timeline read and every duration is ordered by this.
CREATE INDEX IF NOT EXISTS idx_giniflow_events_visit_time
  ON giniflow_visit_events (visit_id, occurred_at);
