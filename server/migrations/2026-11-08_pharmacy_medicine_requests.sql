CREATE TABLE IF NOT EXISTS pharmacy_medicine_requests (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  medicine_key  TEXT NOT NULL CHECK (medicine_key ~ '\S'),
  medicine_name TEXT NOT NULL,
  visit_id      UUID REFERENCES giniflow_visits(id) ON DELETE SET NULL,
  patient_id    INT REFERENCES patients(id) ON DELETE SET NULL,
  requested_by  INT REFERENCES doctors(id) ON DELETE SET NULL,
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS pharmacy_medicine_requests_visit_key
  ON pharmacy_medicine_requests (visit_id, medicine_key) WHERE visit_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS pharmacy_medicine_requests_requested_at
  ON pharmacy_medicine_requests (requested_at);

ALTER TABLE pharmacy_medicine_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE pharmacy_medicine_requests FORCE ROW LEVEL SECURITY;
REVOKE ALL ON pharmacy_medicine_requests FROM anon, authenticated;
