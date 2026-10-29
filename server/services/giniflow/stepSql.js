export const AUTO_LAB_BILLING_SQL = (step) =>
  `(${step}.source = 'auto' AND ${step}.step_catalog_id = 'lab_billing')`;

export const JOURNEY_STEPS_SQL = (v) => `
  SELECT json_agg(json_build_object(
           'name', s.step_name,
           'catalogId', s.step_catalog_id,
           'status', s.status,
           'chain', s.chain_status,
           'order', s.step_order,
           'background', COALESCE(c.is_background, FALSE),
           'test', s.step_catalog_id IN ('lab_billing', 'blood_sample', 'lab_processing_2', 'report_upload') OR COALESCE(c.machine, FALSE)
         ) ORDER BY s.step_order) AS steps
    FROM giniflow_visit_steps s
    LEFT JOIN flow_step_catalog c ON c.id = s.step_catalog_id
   WHERE s.visit_id = ${v}.id`;
