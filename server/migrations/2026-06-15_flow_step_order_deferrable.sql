-- ============================================================
-- Make flow_visit_steps (visit_id, step_order) uniqueness DEFERRABLE
-- 2026-06-15
--
-- The add-step / remove-step reorder shifts step_order with
-- `UPDATE ... SET step_order = step_order + 1`. Postgres checks a normal UNIQUE
-- constraint row-by-row (immediately), so shifting rows up transiently collides
-- (e.g. 4→5 while 5 still exists) and aborts. DEFERRABLE INITIALLY DEFERRED
-- moves the check to COMMIT, by which point all step_orders are unique again.
--
-- Safe: flow_visit_steps never uses ON CONFLICT on this key (check-in does plain
-- INSERTs), so deferring it has no other effect. Idempotent.
-- ============================================================

ALTER TABLE flow_visit_steps
  DROP CONSTRAINT IF EXISTS flow_visit_steps_visit_id_step_order_key;

ALTER TABLE flow_visit_steps
  ADD CONSTRAINT flow_visit_steps_visit_id_step_order_key
  UNIQUE (visit_id, step_order) DEFERRABLE INITIALLY DEFERRED;
