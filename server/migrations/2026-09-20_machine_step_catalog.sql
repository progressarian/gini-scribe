-- These five have sat in `flow_step_catalog` since the flow module was written,
-- assigned to station "Lab" and never once placed on a visit. They are not lab
-- work: nothing is drawn, and the patient sits at a machine rather than handing
-- something over. Naming the right station is what lets the journey the patient
-- is shown agree with the screen the technician works.
--
-- `x_ray` is deliberately left where it is — out of scope, and radiology's.
UPDATE flow_step_catalog
   SET station = 'Machine Room', assigned_role = 'machine_tech'
 WHERE id IN ('abi', 'vpt', 'fundus', 'tmt', 'ecg');
