-- Activate the ABI and X-Ray stages. Unlike the blood draw these tests are never
-- in a journey template — they are added by hand at check-in — so there is no
-- template wiring here: attachBackgroundStages() in server/routes/flow.js hangs
-- the stages off the parent whenever the test is added.
UPDATE flow_step_catalog SET is_active = TRUE
 WHERE id IN ('abi_deliver','abi_process','abi_report',
              'xray_deliver','xray_process','xray_report');
