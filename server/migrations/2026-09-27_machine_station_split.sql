-- ============================================================
-- Echo Station — split 2D Echo out of the Machine Room.
-- 2026-09-27 · docs/gini-flow/45-ECHO-STATION-PLAN.md
--
-- Machine Room (36-MACHINE-TEST-STATION-PLAN.md) put all six machines behind
-- one screen and one role. Echo is now run by its own person, so which screen
-- a machine belongs to becomes admin data on flow_step_catalog, the same way
-- 36 Phase 0 made which STATION a test belongs to admin data on
-- giniflow_test_catalog.category instead of hardcoding it.
--
-- Every existing machine defaults to 'machine_room' — a no-op for ABI, VPT,
-- Fundus, TMT, ECG. Only Echo moves.
--
--   node migrations/_runOne.mjs migrations/2026-09-27_machine_station_split.sql
-- ============================================================

ALTER TABLE flow_step_catalog
  ADD COLUMN IF NOT EXISTS machine_station TEXT NOT NULL DEFAULT 'machine_room';

ALTER TABLE flow_step_catalog
  DROP CONSTRAINT IF EXISTS flow_step_catalog_machine_station_check;

ALTER TABLE flow_step_catalog
  ADD CONSTRAINT flow_step_catalog_machine_station_check
    CHECK (machine_station IN ('machine_room', 'echo'));

UPDATE flow_step_catalog SET machine_station = 'echo' WHERE id = 'echo';
