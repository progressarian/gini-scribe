ALTER TABLE bill_line_discounts
  DROP CONSTRAINT IF EXISTS bill_line_discounts_method_check;
ALTER TABLE bill_line_discounts
  ADD CONSTRAINT bill_line_discounts_method_check CHECK (method IN ('auto', 'code', 'manual'));

ALTER TABLE bill_lines
  ADD COLUMN IF NOT EXISTS manual_discount_kind TEXT
    CHECK (manual_discount_kind IN ('percent', 'flat')),
  ADD COLUMN IF NOT EXISTS manual_discount_value NUMERIC(12,2)
    CHECK (manual_discount_value > 0),
  ADD COLUMN IF NOT EXISTS manual_discount_reason TEXT,
  ADD COLUMN IF NOT EXISTS manual_discount_by INT REFERENCES doctors(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS manual_discount_at TIMESTAMPTZ;

ALTER TABLE bill_lines
  DROP CONSTRAINT IF EXISTS bill_lines_manual_discount_pair_check;
ALTER TABLE bill_lines
  ADD CONSTRAINT bill_lines_manual_discount_pair_check
    CHECK ((manual_discount_kind IS NULL) = (manual_discount_value IS NULL));

ALTER TABLE bills
  ADD COLUMN IF NOT EXISTS manual_discount_kind TEXT
    CHECK (manual_discount_kind IN ('percent', 'flat')),
  ADD COLUMN IF NOT EXISTS manual_discount_value NUMERIC(12,2)
    CHECK (manual_discount_value > 0),
  ADD COLUMN IF NOT EXISTS manual_discount_reason TEXT,
  ADD COLUMN IF NOT EXISTS manual_discount_by INT REFERENCES doctors(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS manual_discount_at TIMESTAMPTZ;

ALTER TABLE bills
  DROP CONSTRAINT IF EXISTS bills_manual_discount_pair_check;
ALTER TABLE bills
  ADD CONSTRAINT bills_manual_discount_pair_check
    CHECK ((manual_discount_kind IS NULL) = (manual_discount_value IS NULL));
