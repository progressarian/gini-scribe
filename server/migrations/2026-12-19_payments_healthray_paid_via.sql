ALTER TABLE payments ADD COLUMN IF NOT EXISTS paid_via TEXT;

ALTER TABLE payments
  DROP CONSTRAINT IF EXISTS payments_paid_via_check,
  ADD CONSTRAINT payments_paid_via_check
    CHECK (paid_via IS NULL OR (mode = 'healthray' AND paid_via IN ('cash', 'card', 'upi')));
