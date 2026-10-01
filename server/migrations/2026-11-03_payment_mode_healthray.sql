ALTER TABLE payments
  DROP CONSTRAINT IF EXISTS payments_mode_check,
  ADD CONSTRAINT payments_mode_check CHECK (mode IN ('cash', 'card', 'upi', 'healthray'));

ALTER TABLE payments
  DROP CONSTRAINT IF EXISTS payments_reference_check,
  ADD CONSTRAINT payments_reference_check
    CHECK (mode IN ('cash', 'healthray') OR (reference IS NOT NULL AND reference ~ '\S'));

ALTER TABLE payments
  DROP CONSTRAINT IF EXISTS payments_healthray_no_shift_check,
  ADD CONSTRAINT payments_healthray_no_shift_check
    CHECK (mode <> 'healthray' OR shift_id IS NULL);
