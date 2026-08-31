-- ============================================================
-- Gini Flow — the lab test catalogue reception collects against.
-- 2026-08-31
--
-- Reception's screen shows a per-test price and a total. Nothing in this
-- database has ever held a price: `lab_test_requests` has no price column and
-- neither does anything else. So the catalogue is new.
--
-- ⚠️ THE SEEDED PRICES ARE THE PROTOTYPE'S, NOT THE HOSPITAL'S. They come from
-- docs/Flow-Manage/gini-stations.html and exist so the screen is usable and
-- testable. They must be replaced with the real price list before reception
-- collects a single rupee against them — see 06-PHASE-2-PLAN.md question 3.
--
-- Price is ALSO stored per order line (giniflow_lab_order_tests.price), which is
-- what reception actually charges: a catalogue change must never silently
-- re-price an order a patient was already quoted.
--
--   node migrations/_runOne.mjs migrations/2026-08-31_giniflow_test_catalog.sql
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS giniflow_test_catalog (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  test_name  TEXT NOT NULL UNIQUE,
  price      NUMERIC(10,2) NOT NULL,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  -- Until the hospital's own list replaces these, every row says where it came
  -- from, so nobody mistakes a mockup figure for a real tariff.
  source     TEXT NOT NULL DEFAULT 'prototype_placeholder',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO giniflow_test_catalog (test_name, price) VALUES
  ('HbA1c', 250), ('FBS', 80), ('Lipid panel', 350), ('Creatinine', 120),
  ('UACR', 200), ('TSH', 280), ('LFT', 350), ('CBC', 200), ('Vit D', 900),
  ('KFT', 700), ('Urine R/M', 300), ('Vitamin D', 1200)
ON CONFLICT (test_name) DO NOTHING;
