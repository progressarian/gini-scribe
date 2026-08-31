-- ============================================================
-- Gini Flow — mark seeded demo rows so cleanup can never touch a real visit.
-- 2026-08-31
--
-- cleanDemoDay() previously deleted every giniflow_visits row for the IST day.
-- That is harmless only while the table has no real rows, and stops being
-- harmless the moment check-in ships — at which point the smoke script, which
-- calls it first thing, would wipe the live floor. The flag makes the delete
-- narrow instead of date-wide.
--
-- Demo patients get the same treatment: the seeder creates its own rather than
-- writing fabricated categories, vitals and blocked reasons against real people.
--
--   node migrations/_runOne.mjs migrations/2026-08-31_giniflow_demo_flag.sql
-- ============================================================

ALTER TABLE giniflow_visits ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_giniflow_visits_demo
  ON giniflow_visits (visit_date) WHERE is_demo;
