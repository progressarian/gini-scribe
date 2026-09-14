-- ============================================================
-- Machine Room — 2D Echo, the sixth machine test.
-- 2026-09-22 · docs/gini-flow/36-MACHINE-TEST-STATION-PLAN.md
--
-- HealthRay bills 2D Echo under RADIOLOGY beside TMT and ECG (Gurtej Singh,
-- OPD/2627-13949: ECG ₹200 · 2D Echo ₹2,200 · TMT ₹1,600). With no Echo in the
-- machine room the line matched nothing, so the patient's journey never showed
-- it and nobody was asked to take the payment or run the test.
--
-- The step mirrors the other five machine steps. The catalogue price is the
-- figure on that bill and carries the same placeholder flag as the rest of the
-- machine rate card until the real tariff replaces it.
--
--   node migrations/_runOne.mjs migrations/2026-09-22_machine_echo.sql
-- ============================================================

INSERT INTO flow_step_catalog
  (id, name, default_duration_min, station, assigned_role, is_background, chain_status, is_active)
VALUES
  ('echo', '2D Echo', 20, 'Machine Room', 'machine_tech', FALSE, NULL, TRUE)
ON CONFLICT (id) DO UPDATE
  SET name = EXCLUDED.name,
      station = EXCLUDED.station,
      assigned_role = EXCLUDED.assigned_role,
      is_background = FALSE,
      is_active = TRUE;

INSERT INTO giniflow_test_catalog (test_name, category, price, is_active, source)
VALUES ('2D Echo', 'machine', 2200, TRUE, 'prototype_placeholder')
ON CONFLICT (test_name) DO UPDATE
  SET category = 'machine',
      is_active = TRUE,
      updated_at = NOW();
