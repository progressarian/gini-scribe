INSERT INTO flow_step_catalog
  (id, name, default_duration_min, station, assigned_role, display_order,
   is_active, is_background, parent_step_catalog_id, attach_when_any)
VALUES
  ('rx_ready', 'Prescription — ready', 5, 'Doctor Room', 'mo', 33, TRUE, TRUE, NULL, NULL)
ON CONFLICT (id) DO UPDATE
  SET name = EXCLUDED.name,
      station = EXCLUDED.station,
      assigned_role = EXCLUDED.assigned_role,
      display_order = EXCLUDED.display_order,
      is_active = EXCLUDED.is_active,
      is_background = EXCLUDED.is_background;

DO $$
DECLARE
  v text;
  base int;
BEGIN
  FOR v IN SELECT DISTINCT visit_type_id FROM flow_step_templates
            WHERE step_catalog_id = 'rx_explain'
  LOOP
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM flow_step_templates
       WHERE visit_type_id = v AND step_catalog_id = 'rx_ready'
    );
    SELECT step_order INTO base FROM flow_step_templates
     WHERE visit_type_id = v AND step_catalog_id = 'rx_explain';

    UPDATE flow_step_templates SET step_order = step_order + 10000
     WHERE visit_type_id = v AND step_order >= base;

    INSERT INTO flow_step_templates (visit_type_id, step_catalog_id, step_order)
    VALUES (v, 'rx_ready', base);

    UPDATE flow_step_templates SET step_order = step_order - 10000 + 1
     WHERE visit_type_id = v AND step_order > 10000;
  END LOOP;
END $$;
