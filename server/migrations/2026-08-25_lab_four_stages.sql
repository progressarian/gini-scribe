-- Lab as four stages, per the hospital's own workflow:
--   sample collection → delivered to lab → lab processing → reports available
--
-- Collection stays the patient-facing step. The other three are background
-- stages: they run while the patient waits, are timed individually so
-- turnaround can be measured per stage, and any one open holds the
-- consultation gate.
--
-- Delivered and processing are staff-clicked — HealthRay has no signal for
-- them. Reports closes on its own when results sync, or by hand.
--
-- flow_step_templates has UNIQUE (visit_type_id, step_order) and it is not
-- deferrable, so orders are scaled out of the way, the new rows dropped into the
-- gap, then everything renumbered 1..N.

BEGIN;

INSERT INTO flow_step_catalog
  (id, name, default_duration_min, station, assigned_role, display_order, is_active,
   is_background, attach_when_any)
VALUES
  ('lab_delivered',  'Lab — delivered to lab', 10, 'Lab', 'lab_tech', 28, TRUE, TRUE,
   ARRAY['blood_sample','abi','x_ray']),
  ('lab_processing', 'Lab — processing',       45, 'Lab', 'lab_tech', 29, TRUE, TRUE,
   ARRAY['blood_sample','abi','x_ray'])
ON CONFLICT (id) DO UPDATE
  SET is_active = TRUE, is_background = TRUE,
      attach_when_any = EXCLUDED.attach_when_any,
      display_order = EXCLUDED.display_order,
      default_duration_min = EXCLUDED.default_duration_min;

UPDATE flow_step_catalog
   SET name = 'Lab — reports available', display_order = 30
 WHERE id = 'lab_reports';

UPDATE flow_step_templates
   SET step_order = (step_order + 1000) * 10
 WHERE visit_type_id IN (
   SELECT DISTINCT visit_type_id FROM flow_step_templates WHERE step_catalog_id = 'lab_reports'
 );

INSERT INTO flow_step_templates
  (visit_type_id, step_catalog_id, step_order, is_default, is_optional, condition_key)
SELECT t.visit_type_id, stage.cid, t.step_order - stage.back, TRUE, FALSE, t.condition_key
  FROM flow_step_templates t
  CROSS JOIN (VALUES ('lab_delivered', 2), ('lab_processing', 1)) AS stage(cid, back)
 WHERE t.step_catalog_id = 'lab_reports'
   AND NOT EXISTS (SELECT 1 FROM flow_step_templates x
                    WHERE x.visit_type_id = t.visit_type_id AND x.step_catalog_id = stage.cid);

WITH ordered AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY visit_type_id ORDER BY step_order) AS rn
    FROM flow_step_templates
)
UPDATE flow_step_templates t SET step_order = -ordered.rn
  FROM ordered WHERE ordered.id = t.id;
UPDATE flow_step_templates SET step_order = -step_order WHERE step_order < 0;

COMMIT;
