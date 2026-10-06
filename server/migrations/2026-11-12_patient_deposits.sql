CREATE TABLE IF NOT EXISTS deposit_accounts (
  patient_id  INT PRIMARY KEY REFERENCES patients(id) ON DELETE RESTRICT,
  balance     NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE payments ALTER COLUMN bill_id DROP NOT NULL;

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS deposit_patient_id INT REFERENCES deposit_accounts(patient_id) ON DELETE RESTRICT;

ALTER TABLE payments
  DROP CONSTRAINT IF EXISTS payments_bill_or_deposit_check,
  ADD CONSTRAINT payments_bill_or_deposit_check
    CHECK ((bill_id IS NULL) = (deposit_patient_id IS NOT NULL));

CREATE INDEX IF NOT EXISTS payments_deposit_patient_idx
  ON payments (deposit_patient_id) WHERE deposit_patient_id IS NOT NULL;

ALTER TABLE payments
  DROP CONSTRAINT IF EXISTS payments_mode_check,
  ADD CONSTRAINT payments_mode_check CHECK (mode IN ('cash', 'card', 'upi', 'healthray', 'deposit'));

ALTER TABLE payments
  DROP CONSTRAINT IF EXISTS payments_reference_check,
  ADD CONSTRAINT payments_reference_check
    CHECK (mode IN ('cash', 'healthray', 'deposit') OR (reference IS NOT NULL AND reference ~ '\S'));

ALTER TABLE payments
  DROP CONSTRAINT IF EXISTS payments_deposit_no_shift_check,
  ADD CONSTRAINT payments_deposit_no_shift_check
    CHECK (mode <> 'deposit' OR shift_id IS NULL);

ALTER TABLE payments
  DROP CONSTRAINT IF EXISTS payments_deposit_money_mode_check,
  ADD CONSTRAINT payments_deposit_money_mode_check
    CHECK (bill_id IS NOT NULL OR mode IN ('cash', 'card', 'upi'));

CREATE TABLE IF NOT EXISTS deposit_entries (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id          INT NOT NULL REFERENCES deposit_accounts(patient_id) ON DELETE RESTRICT,
  kind                TEXT NOT NULL CHECK (kind IN ('received', 'applied', 'restored',
                                                    'transfer_out', 'transfer_in', 'to_ipd',
                                                    'refunded')),
  amount              NUMERIC(12,2) NOT NULL CHECK (amount <> 0),
  balance_after       NUMERIC(12,2) NOT NULL CHECK (balance_after >= 0),
  payment_id          UUID REFERENCES payments(id) ON DELETE RESTRICT,
  bill_id             UUID REFERENCES bills(id) ON DELETE RESTRICT,
  note                TEXT CHECK (note ~ '\S'),
  created_by          INT REFERENCES doctors(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT deposit_entries_sign_check
    CHECK ((kind IN ('received', 'restored', 'transfer_in')) = (amount > 0)),
  CONSTRAINT deposit_entries_payment_check
    CHECK (kind NOT IN ('received', 'applied', 'restored', 'refunded') OR payment_id IS NOT NULL),
  CONSTRAINT deposit_entries_bill_check
    CHECK (kind NOT IN ('applied', 'restored') OR bill_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS deposit_entries_patient_idx
  ON deposit_entries (patient_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS deposit_entries_payment_key
  ON deposit_entries (payment_id) WHERE payment_id IS NOT NULL;

CREATE OR REPLACE FUNCTION deposit_entries_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'deposit_entries is append-only: rows cannot be changed or deleted'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE OR REPLACE TRIGGER deposit_entries_append_only
  BEFORE UPDATE OR DELETE ON deposit_entries
  FOR EACH ROW EXECUTE FUNCTION deposit_entries_append_only();

CREATE OR REPLACE FUNCTION payments_direction_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  kind TEXT;
BEGIN
  IF NEW.bill_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT bill_type INTO kind FROM bills WHERE id = NEW.bill_id;
  IF FOUND AND (NEW.direction = 'out') <> (kind = 'credit_note') THEN
    RAISE EXCEPTION 'Money comes in on an invoice and goes back out only on a credit note'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'payments_direction_bill_check';
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE billing_requests
  DROP CONSTRAINT IF EXISTS billing_requests_requested_mode_check,
  ADD CONSTRAINT billing_requests_requested_mode_check
    CHECK (requested_mode IN ('as_paid', 'cash', 'card', 'upi', 'deposit'));

ALTER TABLE billing_requests
  DROP CONSTRAINT IF EXISTS billing_requests_approved_mode_check,
  ADD CONSTRAINT billing_requests_approved_mode_check
    CHECK (approved_mode IN ('as_paid', 'cash', 'card', 'upi', 'deposit'));

ALTER TABLE deposit_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE deposit_accounts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON deposit_accounts FROM anon, authenticated;

ALTER TABLE deposit_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE deposit_entries FORCE ROW LEVEL SECURITY;
REVOKE ALL ON deposit_entries FROM anon, authenticated;
