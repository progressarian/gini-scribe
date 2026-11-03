ALTER TABLE payments ADD COLUMN IF NOT EXISTS upi_app TEXT;

ALTER TABLE payments
  DROP CONSTRAINT IF EXISTS payments_mode_check,
  ADD CONSTRAINT payments_mode_check
    CHECK (mode IN ('cash', 'card', 'upi', 'neft', 'healthray', 'deposit', 'prepaid'));

ALTER TABLE payments
  DROP CONSTRAINT IF EXISTS payments_deposit_money_mode_check,
  ADD CONSTRAINT payments_deposit_money_mode_check
    CHECK (bill_id IS NOT NULL OR mode IN ('cash', 'card', 'upi', 'neft'));

ALTER TABLE payments
  DROP CONSTRAINT IF EXISTS payments_paid_via_check,
  ADD CONSTRAINT payments_paid_via_check
    CHECK (paid_via IS NULL OR (mode = 'healthray' AND paid_via IN ('cash', 'card', 'upi', 'neft')));

ALTER TABLE payments
  DROP CONSTRAINT IF EXISTS payments_upi_app_check,
  ADD CONSTRAINT payments_upi_app_check
    CHECK (upi_app IS NULL
           OR (upi_app IN ('bharatpe', 'paytm', 'other')
               AND (mode = 'upi' OR (mode = 'healthray' AND paid_via = 'upi'))));
