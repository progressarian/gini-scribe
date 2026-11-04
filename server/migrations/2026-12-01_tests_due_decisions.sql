CREATE TABLE IF NOT EXISTS giniflow_tests_due_decisions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id     UUID NOT NULL REFERENCES giniflow_visits(id) ON DELETE CASCADE,
  patient_id   INTEGER NOT NULL REFERENCES patients(id),
  test_key     TEXT NOT NULL CHECK (test_key IN ('abi', 'vpt', 'fundus', 'echo')),
  last_done    DATE NOT NULL,
  decision     TEXT NOT NULL CHECK (decision IN ('ordered', 'declined')),
  urgency      TEXT CHECK (urgency IN ('today', 'tomorrow', 'next_visit')),
  lab_order_id UUID REFERENCES giniflow_lab_orders(id) ON DELETE SET NULL,
  decided_by   INTEGER REFERENCES doctors(id),
  station      TEXT NOT NULL CHECK (station IN ('doctor', 'mo')),
  decided_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (visit_id, test_key),
  CHECK ((decision = 'ordered') = (urgency IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_tests_due_decisions_patient
  ON giniflow_tests_due_decisions (patient_id, decided_at DESC);
