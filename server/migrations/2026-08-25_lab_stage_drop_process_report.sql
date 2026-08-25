-- Drop the "lab processing" and "reports available" stages, keeping only
-- collection → delivered to lab.
--
-- The background-step machinery stays: the delivery stage still runs in parallel
-- with the patient, still sits on the Lab track, and still holds the
-- consultation gate. What changes is what the gate MEANS — it now releases when
-- the sample reaches the lab, not when results come back.
--
-- Guarded: the catalog rows are only removed if no visit ever used them, since
-- flow_visit_steps.step_catalog_id references them.

BEGIN;

DELETE FROM flow_step_templates
 WHERE step_catalog_id IN ('blood_process','blood_report',
                           'abi_process','abi_report',
                           'xray_process','xray_report');

WITH ordered AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY visit_type_id ORDER BY step_order) AS rn
    FROM flow_step_templates
)
UPDATE flow_step_templates t SET step_order = -ordered.rn
  FROM ordered WHERE ordered.id = t.id;
UPDATE flow_step_templates SET step_order = -step_order WHERE step_order < 0;

DELETE FROM flow_step_catalog c
 WHERE c.id IN ('blood_process','blood_report',
                'abi_process','abi_report',
                'xray_process','xray_report')
   AND NOT EXISTS (SELECT 1 FROM flow_visit_steps s WHERE s.step_catalog_id = c.id);

COMMIT;
