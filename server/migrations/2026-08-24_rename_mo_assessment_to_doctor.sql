-- Rename the "MO Assessment" journey step to "Doctor Assessment".
--
-- Both the catalog row AND every existing flow_visit_steps row are renamed:
-- the bottleneck report in GET /api/flow/reports groups by s.step_name, so
-- leaving history on the old label would split one step into two rows there.
-- step_catalog_id ('mo_assessment') is deliberately unchanged — journey
-- templates and per-step analytics key on it, and it is not shown to users.

BEGIN;

UPDATE flow_step_catalog
   SET name = 'Doctor Assessment'
 WHERE id = 'mo_assessment' AND name = 'MO Assessment';

UPDATE flow_visit_steps
   SET step_name = 'Doctor Assessment'
 WHERE step_catalog_id = 'mo_assessment' AND step_name = 'MO Assessment';

COMMIT;
