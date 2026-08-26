INSERT INTO flow_step_catalog
  (id, name, default_duration_min, station, assigned_role, display_order,
   is_active, is_background, attach_when_any)
VALUES
  ('report_printed', 'Reports — printed', 10, 'Reports Desk', 'report_desk', 31,
   TRUE, TRUE, ARRAY['blood_sample','abi','x_ray']),
  ('report_delivered', 'Reports — delivered to Doctor', 10, 'Reports Desk', 'report_desk', 32,
   TRUE, TRUE, ARRAY['blood_sample','abi','x_ray'])
ON CONFLICT (id) DO UPDATE
  SET name = EXCLUDED.name,
      station = EXCLUDED.station,
      assigned_role = EXCLUDED.assigned_role,
      display_order = EXCLUDED.display_order,
      is_active = EXCLUDED.is_active,
      is_background = EXCLUDED.is_background,
      attach_when_any = EXCLUDED.attach_when_any;
