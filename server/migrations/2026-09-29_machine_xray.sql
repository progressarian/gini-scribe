-- ============================================================
-- X-Ray Station — onboard X-ray as a catalogued machine and split it into
-- its own station, plus a reusable "must finish before" primitive so Echo
-- can require X-ray done first.
-- 2026-09-29 · docs/gini-flow/46-XRAY-STATION-PLAN.md
--
-- X-ray has real clinical volume (79 documents in the last 30 days) but zero
-- presence in Gini Flow's ordering/billing system: flow_step_catalog.x_ray
-- exists but machine=false and has never had a single giniflow_visit_steps
-- row placed against it — the same dormant state Echo was in before
-- 36-MACHINE-TEST-STATION-PLAN.md, except X-ray was deliberately kept out at
-- the time ("X-Ray is out — it stays wherever radiology runs it today",
-- repeated in 2026-09-20_machine_step_catalog.sql). This reverses that call,
-- the same way Echo's own exclusion got reversed later.
--
--   node migrations/_runOne.mjs migrations/2026-09-29_machine_xray.sql
-- ============================================================

-- 1. Widen the machine_station CHECK (2026-09-27_machine_station_split.sql)
--    to allow a third station.
ALTER TABLE flow_step_catalog
  DROP CONSTRAINT IF EXISTS flow_step_catalog_machine_station_check;

ALTER TABLE flow_step_catalog
  ADD CONSTRAINT flow_step_catalog_machine_station_check
    CHECK (machine_station IN ('machine_room', 'echo', 'xray'));

-- 2. A machine can require another machine done first, generically — set
--    once here (Echo requires X-ray), enforced in assertReadyToStart
--    (server/services/giniflow/machineStation.js). No FK: matched by
--    convention against another catalogue row's id, the same way
--    order_test_name matches a test_catalog row by name rather than a hard
--    reference, so a future admin rename doesn't need a migration to fix.
ALTER TABLE flow_step_catalog
  ADD COLUMN IF NOT EXISTS machine_requires_before TEXT;

-- 3. Flip the dormant x_ray row on: catalogued as a machine, its own station.
UPDATE flow_step_catalog
   SET machine = TRUE,
       machine_station = 'xray',
       machine_short_name = 'X-Ray',
       machine_full_name = 'X-Ray',
       machine_icon = '🩻',
       order_test_name = 'X-Ray',
       bill_names = ARRAY['X-Ray', 'X-ray'],
       report_doc_types = ARRAY['xray'],
       hands_over = FALSE
 WHERE id = 'x_ray';

-- 4. Echo requires X-ray done first.
UPDATE flow_step_catalog
   SET machine_requires_before = 'x_ray'
 WHERE id = 'echo';

-- 5. Priced placeholder, same shape as Echo's (2026-09-22_machine_echo.sql)
--    — an admin sets the real figure on /settings/tests before the station
--    goes live; until then the queue is empty by design, nothing guessed.
INSERT INTO giniflow_test_catalog (test_name, category, price, is_active, source)
VALUES ('X-Ray', 'machine', 500, TRUE, 'prototype_placeholder')
ON CONFLICT (test_name) DO UPDATE
  SET category = 'machine',
      is_active = TRUE,
      updated_at = NOW();
