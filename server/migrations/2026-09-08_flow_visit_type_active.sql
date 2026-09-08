-- ============================================================
-- Retire a visit type without deleting it.
-- 2026-09-08
--
-- The admin panel offered a "Flexible" checkbox that nothing read: is_flexible
-- was seeded in 2026-06-15_flow_management.sql for a per-day benchmark override
-- (that plan's open item 9) which was never built, so ticking it changed
-- nothing. It is replaced in the UI by is_active, which mirrors the step
-- catalog's own Active column and actually gates what reception is offered.
--
-- Deleting a type is not the same thing: the id is referenced by existing
-- giniflow_visits rows, so removing one rewrites history. Deactivating keeps
-- every past visit readable and only stops the type being chosen again.
--
-- is_flexible is left in place rather than dropped — it holds no meaning now,
-- but a DROP COLUMN on a live table buys nothing and the per-day override may
-- still be built against it.
--
-- Idempotent.
-- ============================================================

ALTER TABLE flow_visit_types
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

-- Every existing type stays selectable: this migration changes what an admin
-- CAN do, not what the floor is doing today.
UPDATE flow_visit_types SET is_active = TRUE WHERE is_active IS NULL;
