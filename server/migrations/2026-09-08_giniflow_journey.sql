-- ============================================================
-- Gini Flow — the journey reception builds when a patient arrives.
-- 2026-09-08 · docs/gini-flow/29-RECEPTION-JOURNEY-PLAN.md
--
-- "✓ Arrived" recorded nothing about what the patient was here for, so nothing
-- downstream could tell a 45-minute follow-up from a two-hour new case with an
-- ECG and an X-Ray. Reception now picks a visit type and confirms the journey
-- before the arrival completes.
--
-- The reference data is the one the /flow module already owns — visit types,
-- step catalog, per-type templates, staff — so there stays ONE catalog to edit.
-- What is new is the per-visit plan, which belongs to Gini Flow.
--
--   node migrations/_runOne.mjs migrations/2026-09-08_giniflow_journey.sql
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS giniflow_visit_steps (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id             UUID NOT NULL REFERENCES giniflow_visits(id) ON DELETE CASCADE,
  step_order           INT  NOT NULL,
  -- NULL for a step reception typed themselves; the catalog cannot hold every
  -- one-off a real day produces.
  step_catalog_id      TEXT REFERENCES flow_step_catalog(id),
  step_name            TEXT NOT NULL,
  planned_duration_min INT  NOT NULL DEFAULT 0,
  station              TEXT,
  assigned_role        TEXT,
  assigned_staff_id    TEXT,
  assigned_staff_name  TEXT,
  -- A SNAPSHOT of the catalog mapping, not a live join: re-mapping a step next
  -- month must not change how a journey already on the floor behaves.
  chain_status         TEXT,
  status               TEXT NOT NULL DEFAULT 'pending',
  started_at           TIMESTAMPTZ,
  completed_at         TIMESTAMPTZ,
  source               TEXT NOT NULL DEFAULT 'template',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT giniflow_visit_steps_status
    CHECK (status IN ('pending', 'in_progress', 'done', 'skipped')),
  CONSTRAINT giniflow_visit_steps_source
    CHECK (source IN ('template', 'added', 'custom', 'auto'))
);

-- Reordering renumbers rows, which trips a plain unique key mid-statement. The
-- older module hit this and needed a migration of its own to undo it
-- (2026-06-15_flow_step_order_deferrable.sql) — start where it ended up.
ALTER TABLE giniflow_visit_steps
  DROP CONSTRAINT IF EXISTS giniflow_visit_steps_order;
ALTER TABLE giniflow_visit_steps
  ADD CONSTRAINT giniflow_visit_steps_order UNIQUE (visit_id, step_order)
  DEFERRABLE INITIALLY IMMEDIATE;

CREATE INDEX IF NOT EXISTS idx_giniflow_visit_steps_visit
  ON giniflow_visit_steps (visit_id, step_order);

ALTER TABLE giniflow_visits
  ADD COLUMN IF NOT EXISTS visit_type_id     TEXT REFERENCES flow_visit_types(id),
  ADD COLUMN IF NOT EXISTS planned_total_min INT,
  ADD COLUMN IF NOT EXISTS visit_token       TEXT,
  ADD COLUMN IF NOT EXISTS whatsapp_sent     BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS checked_in_by     INT REFERENCES doctors(id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_giniflow_visits_token
  ON giniflow_visits (visit_token) WHERE visit_token IS NOT NULL;

-- ── The shared reference tables gain two facts, so nothing is named in code ──

-- Which board column a step corresponds to. NULL means the step has no column —
-- an ECG or an X-Ray is a real stop on the patient's journey that the chain was
-- never built to show, and pretending otherwise is what makes a board lie.
ALTER TABLE flow_step_catalog
  ADD COLUMN IF NOT EXISTS chain_status TEXT;

-- Confirmed with the floor, 2026-09-07. Every row stays editable afterwards.
UPDATE flow_step_catalog SET chain_status = v.status
  FROM (VALUES
    ('vitals',        'with_vitals'),
    ('mo_assessment', 'with_sd'),
    ('wait_sd',       'ready_for_doctor'),
    ('sd_consult',    'with_doctor'),
    ('wait_chief',    'ready_for_doctor'),
    ('chief_consult', 'with_doctor'),
    ('rx_ready',      'rx_pending'),
    ('rx_explain',    'with_rx'),
    ('pharmacy',      'dispensed')
  ) AS v(id, status)
 WHERE flow_step_catalog.id = v.id
   AND flow_step_catalog.chain_status IS DISTINCT FROM v.status;

-- Everything else stays NULL on purpose. `billing` has no board column, and
-- mapping it to pharmacy_pending would tick "billed" the moment a patient
-- reached the pharmacy queue. The lab_* and report_* steps are owned by the lab
-- track already — two systems ticking the same work is how they disagree.

-- Lets the screen SUGGEST a visit type without naming an id in code.
ALTER TABLE flow_visit_types
  ADD COLUMN IF NOT EXISTS for_followup BOOLEAN,
  ADD COLUMN IF NOT EXISTS for_walkin   BOOLEAN;

-- One row per (follow-up?, walk-in?) combination, so the suggestion is
-- unambiguous. The "+ Tests" and ONLINE variants are left unflagged: they are a
-- choice reception makes, not a default anything should be guessed into.
UPDATE flow_visit_types SET for_followup = v.fu, for_walkin = v.walk
  FROM (VALUES
    ('FU_APPT',  TRUE,  FALSE),
    ('FU_WALK',  TRUE,  TRUE),
    ('NEW_APPT', FALSE, FALSE),
    ('NEW_WALK', FALSE, TRUE)
  ) AS v(id, fu, walk)
 WHERE flow_visit_types.id = v.id
   AND flow_visit_types.for_followup IS NULL
   AND flow_visit_types.for_walkin IS NULL;
