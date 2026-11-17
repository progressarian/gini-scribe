ALTER TABLE pharmacy_payments ALTER COLUMN bill_id DROP NOT NULL;
ALTER TABLE pharmacy_payments ADD COLUMN IF NOT EXISTS patient_id INT REFERENCES patients(id) ON DELETE RESTRICT;

UPDATE pharmacy_payments p SET patient_id = b.patient_id
  FROM pharmacy_bills b
 WHERE b.id = p.bill_id AND p.patient_id IS NULL;

ALTER TABLE pharmacy_payments DROP CONSTRAINT IF EXISTS pharmacy_payments_owner;
ALTER TABLE pharmacy_payments ADD CONSTRAINT pharmacy_payments_owner
  CHECK (bill_id IS NOT NULL OR patient_id IS NOT NULL);

ALTER TABLE pharmacy_payments DROP CONSTRAINT IF EXISTS pharmacy_payments_mode_check;
ALTER TABLE pharmacy_payments ADD CONSTRAINT pharmacy_payments_mode_check
  CHECK (mode IN ('cash', 'card', 'upi', 'neft', 'deposit'));

ALTER TABLE pharmacy_payments DROP CONSTRAINT IF EXISTS pharmacy_payments_reference;
ALTER TABLE pharmacy_payments ADD CONSTRAINT pharmacy_payments_reference
  CHECK (mode IN ('cash', 'deposit') OR (reference IS NOT NULL AND reference ~ '\S'));

ALTER TABLE pharmacy_payments DROP CONSTRAINT IF EXISTS pharmacy_payments_deposit_on_bill;
ALTER TABLE pharmacy_payments ADD CONSTRAINT pharmacy_payments_deposit_on_bill
  CHECK (mode <> 'deposit' OR (bill_id IS NOT NULL AND shift_id IS NULL));

CREATE INDEX IF NOT EXISTS pharmacy_payments_patient_idx ON pharmacy_payments (patient_id);

CREATE SEQUENCE IF NOT EXISTS pharmacy_account_entry_no_seq;

CREATE TABLE IF NOT EXISTS pharmacy_account_entries (
  id          BIGSERIAL PRIMARY KEY,
  entry_no    TEXT NOT NULL DEFAULT ('PAE' || lpad(nextval('pharmacy_account_entry_no_seq')::text, 6, '0')),
  patient_id  INT NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  kind        TEXT NOT NULL CHECK (kind IN ('deposit', 'deposit_refund', 'deposit_used',
                                            'write_off', 'voucher_credit', 'voucher_debit')),
  amount      NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  bill_id     UUID REFERENCES pharmacy_bills(id) ON DELETE RESTRICT,
  payment_id  UUID REFERENCES pharmacy_payments(id) ON DELETE RESTRICT,
  reason      TEXT,
  created_by  INT REFERENCES doctors(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pharmacy_account_entries_bill CHECK (
    (kind IN ('write_off', 'deposit_used')) = (bill_id IS NOT NULL)),
  CONSTRAINT pharmacy_account_entries_payment CHECK (
    (kind IN ('deposit', 'deposit_refund', 'deposit_used')) = (payment_id IS NOT NULL)),
  CONSTRAINT pharmacy_account_entries_reason CHECK (
    kind NOT IN ('write_off', 'voucher_credit', 'voucher_debit', 'deposit_refund')
    OR btrim(COALESCE(reason, '')) <> '')
);

CREATE UNIQUE INDEX IF NOT EXISTS pharmacy_account_entries_no_key ON pharmacy_account_entries (entry_no);
CREATE INDEX IF NOT EXISTS pharmacy_account_entries_patient_idx
  ON pharmacy_account_entries (patient_id, created_at);
CREATE INDEX IF NOT EXISTS pharmacy_account_entries_bill_idx
  ON pharmacy_account_entries (bill_id) WHERE bill_id IS NOT NULL;

ALTER TABLE pharmacy_account_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE pharmacy_account_entries FORCE ROW LEVEL SECURITY;
REVOKE ALL ON pharmacy_account_entries FROM anon, authenticated;
