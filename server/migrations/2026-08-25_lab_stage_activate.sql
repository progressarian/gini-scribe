-- Activate the blood lab stages: three background steps inserted straight after
-- Blood Sample, carrying the same condition_key so a visit with no tests gains
-- nothing.
--
-- flow_step_templates has UNIQUE (visit_type_id, step_order) and the constraint
-- is not deferrable, so orders are scaled out of the way, the new rows dropped
-- into the gap, then everything renumbered 1..N per visit type. ABI and X-Ray
-- stages stay inactive until those tests are wired the same way.

BEGIN;

UPDATE flow_step_templates
   SET step_order = (step_order + 1000) * 10
 WHERE visit_type_id IN (
   SELECT DISTINCT visit_type_id FROM flow_step_templates WHERE step_catalog_id = 'blood_sample'
 );

INSERT INTO flow_step_templates
  (visit_type_id, step_catalog_id, step_order, is_default, is_optional, condition_key)
SELECT t.visit_type_id, stage.cid, t.step_order + stage.pos, TRUE, FALSE, t.condition_key
  FROM flow_step_templates t
  CROSS JOIN (VALUES ('blood_deliver', 1), ('blood_process', 2), ('blood_report', 3))
       AS stage(cid, pos)
 WHERE t.step_catalog_id = 'blood_sample'
   AND NOT EXISTS (
     SELECT 1 FROM flow_step_templates x
      WHERE x.visit_type_id = t.visit_type_id AND x.step_catalog_id = stage.cid
   );

WITH ordered AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY visit_type_id ORDER BY step_order) AS rn
    FROM flow_step_templates
)
UPDATE flow_step_templates t
   SET step_order = -ordered.rn
  FROM ordered WHERE ordered.id = t.id;
UPDATE flow_step_templates SET step_order = -step_order WHERE step_order < 0;

UPDATE flow_step_catalog SET is_active = TRUE
 WHERE id IN ('blood_deliver', 'blood_process', 'blood_report');

COMMIT;
