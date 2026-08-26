UPDATE flow_step_catalog SET station = 'Assistant Station'
 WHERE station = 'Reports Desk';

UPDATE flow_visit_steps SET station = 'Assistant Station'
 WHERE station = 'Reports Desk';
