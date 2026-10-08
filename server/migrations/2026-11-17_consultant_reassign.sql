ALTER TABLE appointments ADD COLUMN IF NOT EXISTS doctor_set_manually_at TIMESTAMPTZ;

ALTER TABLE bills DROP CONSTRAINT IF EXISTS bills_credit_kind_check;
ALTER TABLE bills
  ADD CONSTRAINT bills_credit_kind_check
    CHECK (credit_kind IN ('refund', 'discount', 'consultant_change'));

CREATE TABLE IF NOT EXISTS consultant_changes (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id           UUID NOT NULL REFERENCES giniflow_visits(id) ON DELETE RESTRICT,
  patient_id         INTEGER NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  from_doctor_id     INTEGER NOT NULL REFERENCES doctors(id),
  to_doctor_id       INTEGER NOT NULL REFERENCES doctors(id),
  status             TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'done', 'dismissed', 'void')),
  reassigned_by      INTEGER REFERENCES doctors(id),
  reassigned_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_by         INTEGER REFERENCES doctors(id),
  decided_at         TIMESTAMPTZ,
  note               TEXT CHECK (note IS NULL OR btrim(note) <> ''),
  credit_note_id     UUID REFERENCES bills(id) ON DELETE RESTRICT,
  new_bill_id        UUID REFERENCES bills(id) ON DELETE RESTRICT,
  charged            NUMERIC(12,2),
  new_fee            NUMERIC(12,2),
  kept_in_deposit    NUMERIC(12,2),
  refund_request_id  UUID REFERENCES billing_requests(id) ON DELETE RESTRICT,
  CHECK (from_doctor_id <> to_doctor_id),
  CHECK ((status = 'pending') = (decided_at IS NULL)),
  CHECK (status <> 'dismissed' OR note IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS consultant_changes_one_pending_key
  ON consultant_changes (visit_id) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS consultant_changes_pending_idx
  ON consultant_changes (reassigned_at) WHERE status = 'pending';

ALTER TABLE consultant_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE consultant_changes FORCE ROW LEVEL SECURITY;
REVOKE ALL ON consultant_changes FROM anon, authenticated;
