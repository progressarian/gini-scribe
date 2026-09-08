-- ============================================================
-- Gini Flow — "Lab Billing", the counter a patient pays at before the lab
-- draws anything. 2026-09-09 · docs/gini-flow/34-LAB-BILLING-STEP-PLAN.md
--
-- The existing `billing` step is untouched: it sits between rx_explain and
-- pharmacy and is the medicines bill at the end of the visit. This is the other
-- counter, at the start.
--
-- No chain_status. The board has no column for it, and mapping it to one would
-- tick "billed" the moment a patient reached some queue that has nothing to do
-- with the money.
--
--   node migrations/_runOne.mjs migrations/2026-09-09_lab_billing_step.sql
-- ============================================================

INSERT INTO flow_step_catalog
  (id, name, default_duration_min, station, assigned_role, is_background, chain_status, is_active)
VALUES
  ('lab_billing', 'Lab Billing', 5, 'Billing Counter', 'billing', FALSE, NULL, TRUE)
ON CONFLICT (id) DO UPDATE
  SET name = EXCLUDED.name,
      station = EXCLUDED.station,
      assigned_role = EXCLUDED.assigned_role,
      is_background = EXCLUDED.is_background,
      is_active = TRUE;

-- In front of the sample, in every type that carries tests, under the same
-- condition the lab steps already carry: a journey with no tests must not grow
-- a counter nobody will work.
DO $$
DECLARE
  t RECORD;
  at_order INT;
BEGIN
  FOR t IN
    SELECT DISTINCT visit_type_id
      FROM flow_step_templates
     WHERE step_catalog_id = 'blood_sample'
  LOOP
    IF EXISTS (SELECT 1 FROM flow_step_templates
                WHERE visit_type_id = t.visit_type_id AND step_catalog_id = 'lab_billing') THEN
      CONTINUE;
    END IF;

    SELECT step_order INTO at_order
      FROM flow_step_templates
     WHERE visit_type_id = t.visit_type_id AND step_catalog_id = 'blood_sample';

    -- UNIQUE (visit_type_id, step_order) is not deferrable, and a plain
    -- `step_order + 1` collides with the row above it mid-statement. Out of the
    -- way first, then back down one lower than they started.
    UPDATE flow_step_templates
       SET step_order = step_order + 1001
     WHERE visit_type_id = t.visit_type_id AND step_order >= at_order;

    UPDATE flow_step_templates
       SET step_order = step_order - 1000
     WHERE visit_type_id = t.visit_type_id AND step_order > 1000;

    INSERT INTO flow_step_templates
      (visit_type_id, step_catalog_id, step_order, is_default, is_optional, condition_key)
    VALUES
      (t.visit_type_id, 'lab_billing', at_order, TRUE, FALSE, 'needs_tests');
  END LOOP;
END $$;
