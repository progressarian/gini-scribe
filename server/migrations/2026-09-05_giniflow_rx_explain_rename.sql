-- The station is called "Prescription Explain" on the floor, not "Rx explain".
-- The station keys (wait_rx, rx_explain) are unchanged — only what staff read.

UPDATE giniflow_sla_config SET label = 'Wait for Prescription Explain' WHERE station = 'wait_rx';
UPDATE giniflow_sla_config SET label = 'Prescription Explain station' WHERE station = 'rx_explain';
