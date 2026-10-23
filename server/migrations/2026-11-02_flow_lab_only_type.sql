ALTER TABLE flow_visit_types
  ADD COLUMN IF NOT EXISTS for_lab_only BOOLEAN NOT NULL DEFAULT FALSE;

INSERT INTO flow_visit_types
  (id, label, max_time_min, color, is_flexible, is_active,
   for_followup, for_walkin, for_tests, for_online, for_lab_only)
VALUES ('LAB_ONLY', 'Lab only', 77, 'sk', FALSE, TRUE, NULL, NULL, FALSE, FALSE, TRUE)
ON CONFLICT (id) DO UPDATE SET for_lab_only = TRUE;

INSERT INTO flow_step_templates (visit_type_id, step_catalog_id, step_order, is_default)
SELECT 'LAB_ONLY', seed.step, seed.n, TRUE
  FROM (VALUES ('lab_billing', 1), ('check_in', 2), ('blood_sample', 3),
               ('lab_processing_2', 4), ('report_upload', 5)) AS seed(step, n)
  JOIN flow_step_catalog c ON c.id = seed.step
 WHERE NOT EXISTS (SELECT 1 FROM flow_step_templates t WHERE t.visit_type_id = 'LAB_ONLY');
