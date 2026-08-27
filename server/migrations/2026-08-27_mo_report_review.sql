INSERT INTO flow_step_catalog
  (id, name, default_duration_min, station, assigned_role, display_order,
   is_active, is_background, parent_step_catalog_id, attach_when_any)
VALUES
  ('mo_review', 'MO Reviews Reports', 10, 'Doctor Room', 'mo', 34, TRUE, TRUE, NULL, NULL)
ON CONFLICT (id) DO UPDATE
  SET name = EXCLUDED.name, station = EXCLUDED.station,
      assigned_role = EXCLUDED.assigned_role, display_order = EXCLUDED.display_order,
      is_active = EXCLUDED.is_active, is_background = EXCLUDED.is_background;

UPDATE flow_step_catalog SET name = 'Reports — delivered to Doctor' WHERE id = 'report_delivered';
UPDATE flow_step_catalog SET name = 'Wait for Consultant'           WHERE id = 'wait_sd';

UPDATE flow_visit_steps SET step_name = 'Reports — delivered to Doctor'
 WHERE step_catalog_id = 'report_delivered';
UPDATE flow_visit_steps SET step_name = 'Wait for Consultant'
 WHERE step_catalog_id = 'wait_sd';

-- Re-lay every template that has a report handover: drop rx_ready from wherever it
-- sits, then insert mo_review + rx_ready immediately after report_delivered.
-- UNIQUE (visit_type_id, step_order) is NOT deferrable, so park everything out of
-- the way first and renumber 1..N in one pass.
DO $$
DECLARE
  v text;
  base int;
  r record;
  n int;
BEGIN
  FOR v IN SELECT DISTINCT visit_type_id FROM flow_step_templates
            WHERE step_catalog_id = 'report_delivered'
  LOOP
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM flow_step_templates
       WHERE visit_type_id = v AND step_catalog_id = 'mo_review');

    DELETE FROM flow_step_templates WHERE visit_type_id = v AND step_catalog_id = 'rx_ready';
    SELECT step_order INTO base FROM flow_step_templates
     WHERE visit_type_id = v AND step_catalog_id = 'report_delivered';

    UPDATE flow_step_templates SET step_order = step_order + 10000 WHERE visit_type_id = v;

    n := 0;
    FOR r IN SELECT id, step_catalog_id FROM flow_step_templates
              WHERE visit_type_id = v ORDER BY step_order
    LOOP
      n := n + 1;
      UPDATE flow_step_templates SET step_order = n WHERE id = r.id;
      IF r.step_catalog_id = 'report_delivered' THEN
        INSERT INTO flow_step_templates (visit_type_id, step_catalog_id, step_order)
        VALUES (v, 'mo_review', n + 1), (v, 'rx_ready', n + 2);
        n := n + 2;
      END IF;
    END LOOP;
  END LOOP;
END $$;
