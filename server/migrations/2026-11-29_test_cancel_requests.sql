ALTER TABLE billing_requests
  ADD COLUMN IF NOT EXISTS cancel_target JSONB,
  ADD COLUMN IF NOT EXISTS cancel_key TEXT,
  ADD COLUMN IF NOT EXISTS cancel_reason_code TEXT,
  ADD COLUMN IF NOT EXISTS paid_amount NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS charge_type TEXT,
  ADD COLUMN IF NOT EXISTS charge_value NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS charge_amount NUMERIC(12,2);

ALTER TABLE billing_requests
  DROP CONSTRAINT IF EXISTS billing_requests_kind_check,
  ADD CONSTRAINT billing_requests_kind_check
    CHECK (kind IN ('new_item', 'repeat_item', 'refund', 'deposit_refund', 'test_cancel'));

ALTER TABLE billing_requests
  DROP CONSTRAINT IF EXISTS billing_requests_status_check,
  ADD CONSTRAINT billing_requests_status_check
    CHECK (status IN ('pending', 'approved', 'rejected', 'used', 'withdrawn'));

ALTER TABLE billing_requests
  DROP CONSTRAINT IF EXISTS billing_requests_refund_only_check,
  ADD CONSTRAINT billing_requests_refund_only_check
    CHECK (kind IN ('refund', 'deposit_refund')
           OR (kind = 'test_cancel' AND refund_lines IS NULL AND mode_reason IS NULL)
           OR (refund_lines IS NULL AND requested_mode IS NULL
               AND approved_mode IS NULL AND mode_reason IS NULL AND credit_note_id IS NULL));

ALTER TABLE billing_requests
  DROP CONSTRAINT IF EXISTS billing_requests_test_cancel_check,
  ADD CONSTRAINT billing_requests_test_cancel_check
    CHECK ((kind = 'test_cancel') = (cancel_target IS NOT NULL)
           AND (kind = 'test_cancel') = (cancel_key IS NOT NULL)
           AND (kind = 'test_cancel') = (cancel_reason_code IS NOT NULL)
           AND (kind <> 'test_cancel' OR (visit_id IS NOT NULL AND patient_id IS NOT NULL
                                          AND service_item_id IS NULL AND proposed_name IS NULL))
           AND (kind = 'test_cancel' OR (paid_amount IS NULL AND charge_type IS NULL
                                         AND charge_value IS NULL AND charge_amount IS NULL)));

ALTER TABLE billing_requests
  DROP CONSTRAINT IF EXISTS billing_requests_cancel_reason_check,
  ADD CONSTRAINT billing_requests_cancel_reason_check
    CHECK (cancel_reason_code IS NULL OR cancel_reason_code IN
           ('patient_left', 'doctor_withdrew', 'wrong_test', 'duplicate', 'sample_unusable', 'other'));

ALTER TABLE billing_requests
  DROP CONSTRAINT IF EXISTS billing_requests_charge_check,
  ADD CONSTRAINT billing_requests_charge_check
    CHECK ((charge_type IS NULL OR charge_type IN ('percent', 'fixed'))
           AND (charge_value IS NULL OR charge_value >= 0)
           AND (charge_type <> 'percent' OR charge_value <= 100)
           AND (charge_amount IS NULL OR (charge_amount >= 0 AND paid_amount IS NOT NULL
                                          AND charge_amount <= paid_amount))
           AND (paid_amount IS NULL OR paid_amount >= 0)
           AND ((status = 'approved' AND kind = 'test_cancel')
                = (kind = 'test_cancel' AND charge_amount IS NOT NULL)));

CREATE UNIQUE INDEX IF NOT EXISTS billing_requests_pending_cancel_key
  ON billing_requests (cancel_key)
  WHERE kind = 'test_cancel' AND status = 'pending';

ALTER TABLE bills
  DROP CONSTRAINT IF EXISTS bills_credit_kind_check,
  ADD CONSTRAINT bills_credit_kind_check
    CHECK (credit_kind IN ('refund', 'discount', 'consultant_change', 'cancel_charge'));

ALTER TABLE billing_settings
  ADD COLUMN IF NOT EXISTS cancel_charge_type TEXT NOT NULL DEFAULT 'percent'
    CHECK (cancel_charge_type IN ('percent', 'fixed')),
  ADD COLUMN IF NOT EXISTS cancel_charge_pct NUMERIC(5,2) NOT NULL DEFAULT 10
    CHECK (cancel_charge_pct >= 0 AND cancel_charge_pct <= 100),
  ADD COLUMN IF NOT EXISTS cancel_charge_amount NUMERIC(12,2) NOT NULL DEFAULT 50
    CHECK (cancel_charge_amount >= 0 AND cancel_charge_amount <= 100000);
