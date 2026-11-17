CREATE TABLE IF NOT EXISTS pharmacy_credit_requests (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id          UUID NOT NULL REFERENCES pharmacy_bills(id) ON DELETE CASCADE,
  patient_id       INT NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  bill_amount      NUMERIC(12, 2) NOT NULL CHECK (bill_amount > 0),
  amount           NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  approved_amount  NUMERIC(12, 2) CHECK (approved_amount > 0),
  reason           TEXT NOT NULL CHECK (btrim(reason) <> ''),
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn', 'used')),
  requested_by     INT REFERENCES doctors(id) ON DELETE SET NULL,
  requested_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_by       INT REFERENCES doctors(id) ON DELETE SET NULL,
  decided_at       TIMESTAMPTZ,
  decision_note    TEXT,
  used_at          TIMESTAMPTZ,
  CONSTRAINT pharmacy_credit_requests_within_bill CHECK (amount <= bill_amount),
  CONSTRAINT pharmacy_credit_requests_approved_within
    CHECK (approved_amount IS NULL OR approved_amount <= amount),
  CONSTRAINT pharmacy_credit_requests_decided
    CHECK (status IN ('pending', 'withdrawn') OR decided_at IS NOT NULL),
  CONSTRAINT pharmacy_credit_requests_approved_amount
    CHECK ((status IN ('approved', 'used')) = (approved_amount IS NOT NULL)),
  CONSTRAINT pharmacy_credit_requests_rejected_note
    CHECK (status <> 'rejected' OR btrim(COALESCE(decision_note, '')) <> '')
);

CREATE UNIQUE INDEX IF NOT EXISTS pharmacy_credit_requests_open_key
  ON pharmacy_credit_requests (bill_id) WHERE status IN ('pending', 'approved');
CREATE INDEX IF NOT EXISTS pharmacy_credit_requests_status_idx
  ON pharmacy_credit_requests (status, requested_at);
CREATE INDEX IF NOT EXISTS pharmacy_credit_requests_patient_idx
  ON pharmacy_credit_requests (patient_id);

ALTER TABLE pharmacy_bills
  ADD COLUMN IF NOT EXISTS due_adjusted NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (due_adjusted >= 0);

ALTER TABLE pharmacy_bills DROP CONSTRAINT IF EXISTS pharmacy_bills_due_adjusted_credit_note;
ALTER TABLE pharmacy_bills ADD CONSTRAINT pharmacy_bills_due_adjusted_credit_note
  CHECK (due_adjusted = 0 OR bill_type = 'credit_note');

ALTER TABLE pharmacy_bills DROP CONSTRAINT IF EXISTS pharmacy_bills_paid;
ALTER TABLE pharmacy_bills ADD CONSTRAINT pharmacy_bills_paid
  CHECK (paid_amount + due_adjusted <= net_amount);

ALTER TABLE pharmacy_credit_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE pharmacy_credit_requests FORCE ROW LEVEL SECURITY;
REVOKE ALL ON pharmacy_credit_requests FROM anon, authenticated;
