-- ============================================================
-- A catalogue row that only carries sub-tests is a heading, not an input.
-- 2026-09-25 · docs/gini-flow/44-LAB-TEST-CATALOG-PLAN.md
--
--   node migrations/_runOne.mjs migrations/2026-09-25_lab_test_group_type.sql
-- ============================================================

ALTER TABLE lab_test_catalog
  DROP CONSTRAINT IF EXISTS lab_test_catalog_input_type_check;

ALTER TABLE lab_test_catalog
  ADD CONSTRAINT lab_test_catalog_input_type_check
  CHECK (input_type IN ('numeric', 'text', 'group'));
