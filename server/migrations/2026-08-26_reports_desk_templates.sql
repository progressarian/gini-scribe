DO $$
DECLARE
  v text;
  base int;
BEGIN
  FOR v IN SELECT DISTINCT visit_type_id FROM flow_step_templates
            WHERE step_catalog_id = 'lab_reports'
  LOOP
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM flow_step_templates
       WHERE visit_type_id = v AND step_catalog_id = 'report_printed'
    );
    SELECT step_order INTO base FROM flow_step_templates
     WHERE visit_type_id = v AND step_catalog_id = 'lab_reports';

    UPDATE flow_step_templates SET step_order = step_order + 10000
     WHERE visit_type_id = v AND step_order > base;

    INSERT INTO flow_step_templates (visit_type_id, step_catalog_id, step_order)
    VALUES (v, 'report_printed', base + 1),
           (v, 'report_delivered', base + 2);

    UPDATE flow_step_templates SET step_order = step_order - 10000 + 2
     WHERE visit_type_id = v AND step_order > 10000;
  END LOOP;
END $$;
