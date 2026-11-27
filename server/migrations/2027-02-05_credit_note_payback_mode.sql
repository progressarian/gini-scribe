SET LOCAL lock_timeout = '5s';

ALTER TABLE bills
  ADD COLUMN IF NOT EXISTS payback_mode TEXT
    CHECK (payback_mode IN ('as_paid', 'cash', 'deposit'));

ALTER TABLE bills DROP CONSTRAINT IF EXISTS bills_payback_mode_kind_check;
ALTER TABLE bills ADD CONSTRAINT bills_payback_mode_kind_check
  CHECK (payback_mode IS NULL OR (bill_type = 'credit_note' AND credit_kind = 'discount'));
