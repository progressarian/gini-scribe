-- Rename the "MO Room" station label to "Doctor Room", following the rename of
-- the MO Assessment step to Doctor Assessment.
--
-- Catalog row AND every existing flow_visit_steps row: the coordinator's
-- station-occupancy panel buckets live steps by step.station, and the step
-- chips show it, so a half-rename would show two rooms for the same desk.

BEGIN;

UPDATE flow_step_catalog
   SET station = 'Doctor Room'
 WHERE station = 'MO Room';

UPDATE flow_visit_steps
   SET station = 'Doctor Room'
 WHERE station = 'MO Room';

COMMIT;
