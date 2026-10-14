DELETE FROM flow_step_templates WHERE step_catalog_id = 'rx_ready';

DELETE FROM giniflow_visit_steps s
 USING giniflow_visits v
 WHERE v.id = s.visit_id
   AND s.step_catalog_id = 'rx_ready'
   AND s.status IN ('pending', 'in_progress')
   AND v.visit_date >= (NOW() AT TIME ZONE 'Asia/Kolkata')::date;
