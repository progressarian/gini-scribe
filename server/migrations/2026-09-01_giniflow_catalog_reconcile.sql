-- ============================================================
-- Gini Flow — reconcile the test catalogue with the panels.
-- 2026-09-01
--
-- The panels (from gini-doctor-final.html s-tests) and the catalogue (from
-- gini-stations.html s-reception) were seeded from different prototypes and did
-- not agree: 14 of the panels' test names had no catalogue row.
--
-- The service now refuses to order an unpriced test, so before this migration
-- tapping "Lipid panel" — whose four tests were ALL missing — failed outright,
-- and before that guard existed it silently created an order for ₹0.
--
-- ⚠️ These prices are placeholders, like every other row in this table. The
-- catalogue is still stamped `prototype_placeholder` and reception still warns
-- about it. Replace the lot with the hospital's tariff before collecting.
--
--   node migrations/_runOne.mjs migrations/2026-09-01_giniflow_catalog_reconcile.sql
-- ============================================================

INSERT INTO giniflow_test_catalog (test_name, price) VALUES
  ('Post-meal', 80),
  ('HOMA-IR', 600),
  ('Total cholesterol', 150),
  ('LDL', 150),
  ('HDL', 150),
  ('TG', 150),
  ('eGFR', 120),
  ('FT3', 350),
  ('FT4', 350),
  ('ECG', 300),
  ('NT-proBNP', 1800),
  ('hs-CRP', 600),
  ('Vit B12', 900),
  ('Fasting Insulin', 700)
ON CONFLICT (test_name) DO NOTHING;
