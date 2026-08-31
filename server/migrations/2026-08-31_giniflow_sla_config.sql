-- ============================================================
-- Gini Flow — editable time budgets (SLA) behind every timer colour.
-- 2026-08-31
--
-- Cards turn amber at 80% of budget and red past 100%; the same three-way rule
-- drives the station-performance footer and the timeline modal's duration pills.
-- The Flow Manager edits these rows from the Time-budgets drawer, so they are
-- data, not constants — nothing may hardcode a budget.
--
-- Seed values are from the developer brief §3 and the SLA drawer in
-- docs/gini-flow-manager.html (they agree).
--
-- `category_overrides` ships empty and unused: per-category budgets (a red
-- patient gets a longer doctor budget, a green one can be SD-closed with zero
-- doctor time) are a later build. Shipping the column now avoids a migration then.
--
-- Part of the giniflow_* module, which is deliberately separate from the older
-- flow_* module. See docs/gini-flow/00-OVERVIEW.md §2.3.
--
--   node migrations/_runOne.mjs migrations/2026-08-31_giniflow_sla_config.sql
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()

CREATE TABLE IF NOT EXISTS giniflow_sla_config (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  station            TEXT NOT NULL UNIQUE,
  label              TEXT NOT NULL,
  description        TEXT,
  budget_minutes     INT  NOT NULL CHECK (budget_minutes > 0),
  category_overrides JSONB,
  display_order      INT  NOT NULL,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by         TEXT
);

INSERT INTO giniflow_sla_config (station, label, description, budget_minutes, display_order) VALUES
  ('checkin_to_vitals',  'Check-in → Vitals',      'Wait after check-in before vitals begin',      10, 1),
  ('vitals',             'Vitals station',         'BP, weight, height entry time',                 5, 2),
  ('wait_sd',            'Wait for SD / MO',       'After vitals, before SD sees patient',          10, 3),
  ('sd',                 'SD / MO station',        'Workup + plan drafting',                        15, 4),
  ('wait_doctor',        'Wait for doctor',        'After SD ready, before doctor sees',            15, 5),
  ('doctor',             'Doctor station',         'Consultation + prescription',                   20, 6),
  ('pharmacy',           'Pharmacy',               'Dispensing + counselling',                      10, 7),
  ('lab_total',          'Lab: sample → upload',   'Parallel track · collection to report upload',  45, 8),
  ('reception_payment',  'Reception: payment clear','Test order to payment received',               10, 9),
  ('total_journey',      'Total journey target',   'Check-in to exit — the headline number',        90, 10)
ON CONFLICT (station) DO NOTHING;
