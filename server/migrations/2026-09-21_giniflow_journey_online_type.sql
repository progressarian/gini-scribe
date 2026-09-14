-- ============================================================
-- Gini Flow — a booking HealthRay calls Tele/Online gets the Online journey.
-- 2026-09-21 · docs/gini-flow/29-RECEPTION-JOURNEY-PLAN.md
--
-- ONLINE (one Chief Consultation, 60 min) existed with no flags, so nothing
-- ever suggested it: a Tele booking fell through to its visit history and was
-- handed the full in-person F/U Appt journey — vitals, chief assessment,
-- consultant, pharmacy. A fourth axis, beside for_followup/for_walkin/for_tests.
--
--   node migrations/_runOne.mjs migrations/2026-09-21_giniflow_journey_online_type.sql
-- ============================================================

ALTER TABLE flow_visit_types
  ADD COLUMN IF NOT EXISTS for_online BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE flow_visit_types
   SET for_online = TRUE
 WHERE id = 'ONLINE'
   AND for_online IS NOT TRUE;
