-- ============================================================
-- Which fields of a report the bench must fill in, vs which stay
-- reachable through "+ More" — editable per report/test later in the
-- 44-LAB-TEST-CATALOG-PLAN.md S8 settings editor.
-- 2026-09-26
--
--   node migrations/_runOne.mjs migrations/2026-09-26_lab_report_tests_required.sql
-- ============================================================

ALTER TABLE lab_report_tests
  ADD COLUMN IF NOT EXISTS is_required BOOLEAN NOT NULL DEFAULT TRUE;

UPDATE lab_report_tests rt
   SET is_required = FALSE
  FROM lab_test_catalog t
 WHERE t.id = rt.test_id
   AND (t.formula IS NOT NULL OR t.input_type = 'group');
