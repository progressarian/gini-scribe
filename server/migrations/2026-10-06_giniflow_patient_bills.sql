CREATE TABLE IF NOT EXISTS giniflow_patient_bills (
  patient_id  INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  bill_date   DATE NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('billed', 'no_bill')),
  items       JSONB NOT NULL DEFAULT '[]'::jsonb,
  invoice_no  TEXT,
  read_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (patient_id, bill_date)
);

ALTER TABLE giniflow_patient_bills ENABLE ROW LEVEL SECURITY;
ALTER TABLE giniflow_patient_bills FORCE ROW LEVEL SECURITY;
REVOKE ALL ON giniflow_patient_bills FROM anon, authenticated;
