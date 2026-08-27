-- A test added to a no-test visit pulls in the lab and report stages via
-- attach_when_any. mo_review was template-only, so those patients had their
-- report delivered to the MO with no review step behind it.
UPDATE flow_step_catalog
   SET attach_when_any = ARRAY['blood_sample','abi','x_ray']
 WHERE id = 'mo_review';
