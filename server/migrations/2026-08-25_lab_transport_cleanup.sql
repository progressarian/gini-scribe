-- The Lab Transport desk is gone: HealthRay has no "delivered to lab" signal,
-- so there was nothing for it to record. Any stage rows left on a visit are
-- deactivated rather than deleted, since flow_visit_steps references them.
UPDATE flow_step_catalog SET is_active = FALSE
 WHERE id IN ('blood_deliver','abi_deliver','xray_deliver','blood_report',
              'blood_process','abi_process','abi_report','xray_process','xray_report');
