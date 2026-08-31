-- ============================================================
-- Gini Flow — one representation of "blocked".
-- 2026-08-31
--
-- Blocked was expressible two ways: the `blocked_reports` chain status, and a
-- non-null `blocked_reason` on a visit whose status said something else. The
-- board counted one and rendered the other, so a patient could be blocked on the
-- card and not in the stats (audit GF-18).
--
-- The status is now authoritative and the reason is its required text: a visit is
-- blocked exactly when current_status = 'blocked_reports', and that status always
-- carries a reason a coordinator can act on.
--
--   node migrations/_runOne.mjs migrations/2026-08-31_giniflow_blocked_invariant.sql
-- ============================================================

UPDATE giniflow_visits
   SET blocked_reason = NULL
 WHERE current_status <> 'blocked_reports' AND blocked_reason IS NOT NULL;

ALTER TABLE giniflow_visits DROP CONSTRAINT IF EXISTS giniflow_visits_blocked_invariant;

ALTER TABLE giniflow_visits ADD CONSTRAINT giniflow_visits_blocked_invariant
  CHECK ((current_status = 'blocked_reports') = (blocked_reason IS NOT NULL));
