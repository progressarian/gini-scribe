-- Replace the hand-clicked delivery stages with one derived "Lab — reports"
-- step per visit.
--
-- HealthRay knows two states, not four: a case exists (ordered) and its results
-- have synced. There is no "delivered to lab" or "processing" signal anywhere,
-- so those stages could only ever be someone pressing a button. X-Ray and ABI
-- are not lab_cases at all — they arrive as documents keyed on doc_type — so
-- per-test lab stages were never going to close for them either.
--
-- What remains is a single background step that holds the consultation gate and
-- gives the override (skip) a home. The detail of WHICH tests a patient has is
-- read live from lab_cases + documents, not modelled as steps.

BEGIN;

-- A background step can attach to any of several parent tests, not just one.
ALTER TABLE flow_step_catalog
  ADD COLUMN IF NOT EXISTS attach_when_any TEXT[];

DELETE FROM flow_step_templates
 WHERE step_catalog_id IN ('blood_deliver', 'abi_deliver', 'xray_deliver');

DELETE FROM flow_step_catalog c
 WHERE c.id IN ('blood_deliver', 'abi_deliver', 'xray_deliver')
   AND NOT EXISTS (SELECT 1 FROM flow_visit_steps s WHERE s.step_catalog_id = c.id);

INSERT INTO flow_step_catalog
  (id, name, default_duration_min, station, assigned_role, display_order, is_active,
   is_background, attach_when_any)
VALUES
  ('lab_reports', 'Lab — reports', 80, 'Lab', 'lab_tech', 30, TRUE, TRUE,
   ARRAY['blood_sample','abi','x_ray'])
ON CONFLICT (id) DO UPDATE
  SET is_active = TRUE, is_background = TRUE,
      attach_when_any = EXCLUDED.attach_when_any,
      default_duration_min = EXCLUDED.default_duration_min;

-- Sits right after the blood draw on the three journeys that carry one.
INSERT INTO flow_step_templates
  (visit_type_id, step_catalog_id, step_order, is_default, is_optional, condition_key)
SELECT t.visit_type_id, 'lab_reports', t.step_order + 1, TRUE, FALSE, t.condition_key
  FROM flow_step_templates t
 WHERE t.step_catalog_id = 'blood_sample'
   AND NOT EXISTS (SELECT 1 FROM flow_step_templates x
                    WHERE x.visit_type_id = t.visit_type_id AND x.step_catalog_id = 'lab_reports');

WITH ordered AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY visit_type_id ORDER BY step_order) AS rn
    FROM flow_step_templates
)
UPDATE flow_step_templates t SET step_order = -ordered.rn
  FROM ordered WHERE ordered.id = t.id;
UPDATE flow_step_templates SET step_order = -step_order WHERE step_order < 0;

COMMIT;
