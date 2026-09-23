DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'discount_rules'::regclass
       AND conname = 'discount_rules_bill_fixed_price_check'
  ) THEN
    ALTER TABLE discount_rules
      ADD CONSTRAINT discount_rules_bill_fixed_price_check
      CHECK (kind <> 'fixed_price' OR applies_per <> 'bill');
  END IF;
END $$;
