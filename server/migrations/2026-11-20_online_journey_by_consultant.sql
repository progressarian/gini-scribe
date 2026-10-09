-- ============================================================
-- Gini Flow — the Online journey sees the Chief Endocrinologist or the consultant.
--
-- ONLINE carried one Chief Consultation step, which the board files under
-- "With consultant". Dr. Bhansali's online patients therefore never reached the
-- Chief Endocrinologist column, and every other consultant's were given a
-- "chief" step. The type now carries both doctor stops; check-in keeps the
-- Chief Endocrinologist one when the consultant has the Chief step and the
-- consultant one otherwise.
--
--   node migrations/_runOne.mjs migrations/2026-11-20_online_journey_by_consultant.sql
-- ============================================================

BEGIN;

UPDATE flow_step_templates
   SET step_order = step_order + 100
 WHERE visit_type_id = 'ONLINE'
   AND EXISTS (SELECT 1 FROM flow_step_templates c
                WHERE c.visit_type_id = 'ONLINE' AND c.step_catalog_id = 'chief_consult');

INSERT INTO flow_step_templates (visit_type_id, step_catalog_id, step_order, override_duration_min)
SELECT 'ONLINE', s.catalog_id, s.slot, c.override_duration_min
  FROM flow_step_templates c
 CROSS JOIN (VALUES ('sd_consult', 201), ('mo_assessment', 202)) AS s(catalog_id, slot)
 WHERE c.visit_type_id = 'ONLINE' AND c.step_catalog_id = 'chief_consult'
   AND NOT EXISTS (SELECT 1 FROM flow_step_templates x
                    WHERE x.visit_type_id = 'ONLINE' AND x.step_catalog_id = s.catalog_id);

DELETE FROM flow_step_templates
 WHERE visit_type_id = 'ONLINE' AND step_catalog_id = 'chief_consult';

WITH ordered AS (
  SELECT id,
         ROW_NUMBER() OVER (
           ORDER BY CASE step_catalog_id WHEN 'billing' THEN 0 WHEN 'sd_consult' THEN 1
                                         WHEN 'mo_assessment' THEN 2 ELSE 3 END,
                    step_order) AS n
    FROM flow_step_templates
   WHERE visit_type_id = 'ONLINE'
)
UPDATE flow_step_templates t SET step_order = o.n + 1000 FROM ordered o WHERE t.id = o.id;

UPDATE flow_step_templates SET step_order = step_order - 1000
 WHERE visit_type_id = 'ONLINE' AND step_order > 1000;

COMMIT;
