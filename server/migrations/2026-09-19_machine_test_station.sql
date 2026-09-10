-- The lab and the machine room are two different stations, and a test belongs to
-- one of them (36-MACHINE-TEST-STATION-PLAN.md §7 Phase 0).
--
-- Today `ECG` sits in giniflow_test_catalog at ₹300, so ordering it raises a
-- giniflow_lab_orders row that lands in the blood collection room and tells a
-- phlebotomist to draw a sample. ABI, VPT, Fundus and TMT are not in the
-- catalogue at all, so they cannot be ordered through Gini Flow.
--
-- Which station a test belongs to is the floor's to set, not the code's: the
-- category lives beside the price on /admin/test-catalog, so an admin adds the
-- four missing machines and flips ECG without a migration or a deploy. This
-- migration only makes the column exist.
--
-- Both defaults are 'lab', which is what every existing row already is — so the
-- backfill is a no-op and no queue changes shape when this lands.
ALTER TABLE giniflow_test_catalog
  ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'lab';

ALTER TABLE giniflow_test_catalog
  DROP CONSTRAINT IF EXISTS giniflow_test_catalog_category_check;

ALTER TABLE giniflow_test_catalog
  ADD CONSTRAINT giniflow_test_catalog_category_check
  CHECK (category IN ('lab', 'machine'));

-- The order carries the station it belongs to, copied from the catalogue when it
-- is raised. On the order rather than looked up each time, because a test moved
-- between stations later must not drag yesterday's orders across with it.
ALTER TABLE giniflow_lab_orders
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'lab';

ALTER TABLE giniflow_lab_orders
  DROP CONSTRAINT IF EXISTS giniflow_lab_orders_kind_check;

ALTER TABLE giniflow_lab_orders
  ADD CONSTRAINT giniflow_lab_orders_kind_check
  CHECK (kind IN ('lab', 'machine'));

CREATE INDEX IF NOT EXISTS idx_giniflow_lab_orders_kind
  ON giniflow_lab_orders (kind);
