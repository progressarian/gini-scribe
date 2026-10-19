INSERT INTO flow_step_catalog (id, name, default_duration_min, station, assigned_role)
VALUES
  ('check_in',         'Check-in',       2,  'Reception', 'reception'),
  ('lab_processing_2', 'Lab Processing', 60, 'Lab',       'lab_tech'),
  ('report_upload',    'Report Upload',  5,  'Lab',       'lab_tech')
ON CONFLICT (id) DO NOTHING;
