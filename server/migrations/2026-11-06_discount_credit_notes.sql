ALTER TABLE bills
  ADD COLUMN IF NOT EXISTS credit_kind TEXT NOT NULL DEFAULT 'refund'
    CHECK (credit_kind IN ('refund', 'discount'));

ALTER TABLE bills
  DROP CONSTRAINT IF EXISTS bills_credit_kind_type_check;
ALTER TABLE bills
  ADD CONSTRAINT bills_credit_kind_type_check
    CHECK (credit_kind = 'refund' OR bill_type = 'credit_note');

ALTER TABLE bill_lines
  DROP CONSTRAINT IF EXISTS bill_lines_quantity_check;
ALTER TABLE bill_lines
  ADD CONSTRAINT bill_lines_quantity_check
    CHECK (quantity > 0 OR (quantity = 0 AND credited_line_id IS NOT NULL));
