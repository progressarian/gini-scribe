-- Prescription Explain station — the nurse desk between the consult and the pharmacy.
--
-- Restores flow_step_catalog.rx_explain ("Prescription Explain", 5 min, Nursing
-- Station, role nurse) into Gini Flow. See docs/gini-flow/26-RX-EXPLAIN-STATION-PLAN.md.
--
-- Two budgets, matching the queue/station pair the chain uses elsewhere:
--   wait_rx    — consult finished, waiting to be called in
--   rx_explain — at the desk, prescription being explained (5 min, from the old catalog)
--
-- Idempotent: safe to re-run.

INSERT INTO giniflow_sla_config (station, label, description, budget_minutes, display_order)
VALUES
  ('wait_rx', 'Wait for Prescription Explain', 'After the consult, before the nurse calls them in', 10, 7),
  ('rx_explain', 'Prescription Explain station', 'Prescription explained to the patient', 5, 8)
ON CONFLICT (station) DO NOTHING;

UPDATE giniflow_sla_config SET display_order = 9 WHERE station = 'pharmacy';
UPDATE giniflow_sla_config SET display_order = 10 WHERE station = 'lab_total';
UPDATE giniflow_sla_config SET display_order = 11 WHERE station = 'reception_payment';
UPDATE giniflow_sla_config SET display_order = 12 WHERE station = 'total_journey';
