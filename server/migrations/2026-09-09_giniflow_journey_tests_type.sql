-- ============================================================
-- Gini Flow — a booking that is only here to give samples.
-- 2026-09-09 · docs/gini-flow/29-RECEPTION-JOURNEY-PLAN.md
--
-- HealthRay labels five of today's ninety bookings "Investigation": the patient
-- comes to give blood and leave, and GHM books them against Dr. Hospital Admin.
-- Suggesting the full consultation journey for them wastes the desk's time and
-- promises the patient an hour they will not spend here.
--
-- FU_APPT_TESTS already exists for exactly this. It stayed unflagged because a
-- follow-up who happens to need tests is reception's choice — what makes it a
-- suggestion is the booking saying so itself. So the flag is a third axis, not
-- a replacement: (follow-up?, walk-in?, tests-only?) picks one type.
--
--   node migrations/_runOne.mjs migrations/2026-09-09_giniflow_journey_tests_type.sql
-- ============================================================

ALTER TABLE flow_visit_types
  ADD COLUMN IF NOT EXISTS for_tests BOOLEAN;

-- Every already-flagged type is a non-tests one; without this they would all
-- match a tests-only booking equally and the pick would be arbitrary.
UPDATE flow_visit_types
   SET for_tests = FALSE
 WHERE for_tests IS NULL
   AND (for_followup IS NOT NULL OR for_walkin IS NOT NULL);

UPDATE flow_visit_types
   SET for_followup = TRUE, for_walkin = FALSE, for_tests = TRUE
 WHERE id = 'FU_APPT_TESTS'
   AND for_tests IS NOT TRUE;
