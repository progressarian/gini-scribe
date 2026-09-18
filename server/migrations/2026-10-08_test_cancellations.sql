CREATE TABLE IF NOT EXISTS giniflow_test_cancellations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seq BIGSERIAL NOT NULL,
  visit_id UUID REFERENCES giniflow_visits(id) ON DELETE CASCADE,
  patient_id INTEGER REFERENCES patients(id),
  visit_date DATE NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('lab', 'machine', 'healthray_case', 'charge')),
  order_id UUID,
  case_no TEXT,
  charge_id UUID,
  test_name TEXT NOT NULL,
  machine_id TEXT,
  price NUMERIC(10, 2),
  payment_status TEXT,
  amount_paid NUMERIC(10, 2),
  amount_claimed NUMERIC(10, 2),
  refund_amount NUMERIC(10, 2),
  bill_line JSONB,
  reason TEXT NOT NULL,
  note TEXT,
  source TEXT NOT NULL CHECK (source IN ('station', 'reception', 'healthray')),
  actor_id INTEGER REFERENCES doctors(id),
  actor_role TEXT,
  cancelled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  snapshot JSONB
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_giniflow_test_cancellations_seq
  ON giniflow_test_cancellations (seq);
CREATE INDEX IF NOT EXISTS idx_giniflow_test_cancellations_visit
  ON giniflow_test_cancellations (visit_id);
CREATE INDEX IF NOT EXISTS idx_giniflow_test_cancellations_patient_day
  ON giniflow_test_cancellations (patient_id, visit_date);

ALTER TABLE giniflow_lab_case_actions
  DROP CONSTRAINT IF EXISTS giniflow_lab_case_actions_action_check;

ALTER TABLE giniflow_lab_case_actions
  ADD CONSTRAINT giniflow_lab_case_actions_action_check
  CHECK (action = ANY (ARRAY[
    'chased', 'drawing_started', 'sample_taken', 'sample_sent', 'sample_received',
    'processing', 'results_ready', 'report_uploaded', 'cancelled'
  ]));
