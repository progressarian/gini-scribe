ALTER TABLE pharmacy_bill_lines
  ADD COLUMN IF NOT EXISTS discount_pct NUMERIC(5, 2) NOT NULL DEFAULT 0
    CHECK (discount_pct >= 0 AND discount_pct <= 100),
  ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(12, 2) NOT NULL DEFAULT 0
    CHECK (discount_amount >= 0),
  ADD COLUMN IF NOT EXISTS bill_discount NUMERIC(12, 2) NOT NULL DEFAULT 0
    CHECK (bill_discount >= 0);

ALTER TABLE pharmacy_bills
  ADD COLUMN IF NOT EXISTS discount_kind TEXT CHECK (discount_kind IN ('percent', 'amount')),
  ADD COLUMN IF NOT EXISTS discount_value NUMERIC(12, 2) CHECK (discount_value > 0),
  ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(12, 2) NOT NULL DEFAULT 0
    CHECK (discount_amount >= 0),
  ADD COLUMN IF NOT EXISTS discount_by INT REFERENCES doctors(id) ON DELETE SET NULL;

ALTER TABLE pharmacy_bills DROP CONSTRAINT IF EXISTS pharmacy_bills_discount_pair;
ALTER TABLE pharmacy_bills ADD CONSTRAINT pharmacy_bills_discount_pair
  CHECK ((discount_kind IS NULL) = (discount_value IS NULL)
         AND (discount_kind <> 'percent' OR discount_value <= 100));

ALTER TABLE pharmacy_settings
  ADD COLUMN IF NOT EXISTS max_discount_pct NUMERIC(5, 2)
    CHECK (max_discount_pct IS NULL OR (max_discount_pct >= 0 AND max_discount_pct <= 100));
