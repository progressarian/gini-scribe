CREATE SEQUENCE IF NOT EXISTS deposit_slip_seq;

ALTER TABLE deposit_entries
  ADD COLUMN IF NOT EXISTS slip_no TEXT,
  ADD COLUMN IF NOT EXISTS counter_entry_id UUID REFERENCES deposit_entries(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS other_patient_id INT REFERENCES patients(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS relationship TEXT CHECK (relationship ~ '\S'),
  ADD COLUMN IF NOT EXISTS consent_document_id INT REFERENCES documents(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS ipd_number TEXT CHECK (ipd_number ~ '\S'),
  ADD COLUMN IF NOT EXISTS request_id UUID REFERENCES billing_requests(id) ON DELETE RESTRICT;

ALTER TABLE deposit_entries
  DROP CONSTRAINT IF EXISTS deposit_entries_transfer_check,
  ADD CONSTRAINT deposit_entries_transfer_check
    CHECK (kind NOT IN ('transfer_out', 'transfer_in')
           OR (other_patient_id IS NOT NULL AND other_patient_id <> patient_id
               AND slip_no IS NOT NULL AND relationship IS NOT NULL AND note IS NOT NULL));

ALTER TABLE deposit_entries
  DROP CONSTRAINT IF EXISTS deposit_entries_transfer_out_check,
  ADD CONSTRAINT deposit_entries_transfer_out_check
    CHECK (kind <> 'transfer_out' OR consent_document_id IS NOT NULL);

ALTER TABLE deposit_entries
  DROP CONSTRAINT IF EXISTS deposit_entries_transfer_in_check,
  ADD CONSTRAINT deposit_entries_transfer_in_check
    CHECK (kind <> 'transfer_in' OR counter_entry_id IS NOT NULL);

ALTER TABLE deposit_entries
  DROP CONSTRAINT IF EXISTS deposit_entries_ipd_check,
  ADD CONSTRAINT deposit_entries_ipd_check
    CHECK (kind <> 'to_ipd' OR (ipd_number IS NOT NULL AND slip_no IS NOT NULL AND note IS NOT NULL));

ALTER TABLE deposit_entries
  DROP CONSTRAINT IF EXISTS deposit_entries_refunded_check,
  ADD CONSTRAINT deposit_entries_refunded_check
    CHECK (kind <> 'refunded' OR request_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS deposit_entries_slip_idx
  ON deposit_entries (slip_no) WHERE slip_no IS NOT NULL;

ALTER TABLE billing_requests
  ADD COLUMN IF NOT EXISTS amount NUMERIC(12,2) CHECK (amount > 0);

ALTER TABLE billing_requests
  DROP CONSTRAINT IF EXISTS billing_requests_kind_check,
  ADD CONSTRAINT billing_requests_kind_check
    CHECK (kind IN ('new_item', 'repeat_item', 'refund', 'deposit_refund'));

ALTER TABLE billing_requests
  DROP CONSTRAINT IF EXISTS billing_requests_refund_only_check,
  ADD CONSTRAINT billing_requests_refund_only_check
    CHECK (kind IN ('refund', 'deposit_refund')
           OR (refund_lines IS NULL AND requested_mode IS NULL
               AND approved_mode IS NULL AND mode_reason IS NULL AND credit_note_id IS NULL));

ALTER TABLE billing_requests
  DROP CONSTRAINT IF EXISTS billing_requests_deposit_refund_check,
  ADD CONSTRAINT billing_requests_deposit_refund_check
    CHECK (kind <> 'deposit_refund'
           OR (patient_id IS NOT NULL AND amount IS NOT NULL AND bill_id IS NULL
               AND visit_id IS NULL AND refund_lines IS NULL AND credit_note_id IS NULL
               AND service_item_id IS NULL AND proposed_name IS NULL
               AND requested_mode IN ('cash', 'card', 'upi')
               AND (approved_mode IS NULL OR approved_mode IN ('cash', 'card', 'upi'))
               AND ((status IN ('approved', 'used')) = (approved_mode IS NOT NULL))));

ALTER TABLE billing_requests
  DROP CONSTRAINT IF EXISTS billing_requests_amount_check,
  ADD CONSTRAINT billing_requests_amount_check
    CHECK (amount IS NULL OR kind = 'deposit_refund');

CREATE UNIQUE INDEX IF NOT EXISTS billing_requests_open_deposit_refund_key
  ON billing_requests (patient_id)
  WHERE kind = 'deposit_refund' AND status IN ('pending', 'approved');
