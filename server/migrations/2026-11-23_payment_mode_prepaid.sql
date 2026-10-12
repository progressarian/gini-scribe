ALTER TABLE payments
  DROP CONSTRAINT IF EXISTS payments_mode_check,
  ADD CONSTRAINT payments_mode_check
    CHECK (mode IN ('cash', 'card', 'upi', 'healthray', 'deposit', 'prepaid'));

ALTER TABLE payments
  DROP CONSTRAINT IF EXISTS payments_reference_check,
  ADD CONSTRAINT payments_reference_check
    CHECK (mode IN ('cash', 'healthray', 'deposit', 'prepaid') OR (reference IS NOT NULL AND reference ~ '\S'));

ALTER TABLE payments
  DROP CONSTRAINT IF EXISTS payments_prepaid_no_shift_check,
  ADD CONSTRAINT payments_prepaid_no_shift_check
    CHECK (mode <> 'prepaid' OR shift_id IS NULL);
