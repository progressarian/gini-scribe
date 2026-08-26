UPDATE flow_step_catalog
   SET name = 'Reports — delivered to Consultant'
 WHERE id = 'report_delivered';

UPDATE flow_visit_steps
   SET step_name = 'Reports — delivered to Consultant'
 WHERE step_catalog_id = 'report_delivered';

UPDATE flow_step_catalog
   SET name = 'Prescription — MO to prepare'
 WHERE id = 'rx_ready';

UPDATE flow_visit_steps
   SET step_name = 'Prescription — MO to prepare'
 WHERE step_catalog_id = 'rx_ready';
