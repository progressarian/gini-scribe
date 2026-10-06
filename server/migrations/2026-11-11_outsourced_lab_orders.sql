ALTER TABLE giniflow_lab_orders
  ADD COLUMN IF NOT EXISTS is_outsourced BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_giniflow_lab_orders_outside_pending
  ON giniflow_lab_orders (sample_status)
  WHERE is_outsourced;

ALTER TABLE giniflow_lab_case_actions
  DROP CONSTRAINT IF EXISTS giniflow_lab_case_actions_action_check;

ALTER TABLE giniflow_lab_case_actions
  ADD CONSTRAINT giniflow_lab_case_actions_action_check
  CHECK (action = ANY (ARRAY[
    'chased', 'drawing_started', 'sample_taken', 'sample_sent', 'sample_received',
    'processing', 'results_ready', 'report_uploaded', 'sent_outside'
  ]));
