BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS voided_by INT REFERENCES doctors(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS void_reason TEXT CHECK (void_reason ~ '\S');

ALTER TABLE payments
  DROP CONSTRAINT IF EXISTS payments_void_check,
  ADD CONSTRAINT payments_void_check
    CHECK ((voided_at IS NULL) = (void_reason IS NULL)
           AND (voided_at IS NULL OR (bill_id IS NULL AND direction = 'in')));

ALTER TABLE deposit_entries
  DROP CONSTRAINT IF EXISTS deposit_entries_kind_check,
  ADD CONSTRAINT deposit_entries_kind_check
    CHECK (kind IN ('received', 'applied', 'restored', 'transfer_out', 'transfer_in',
                    'to_ipd', 'refunded', 'voided'));

ALTER TABLE deposit_entries
  DROP CONSTRAINT IF EXISTS deposit_entries_voided_check,
  ADD CONSTRAINT deposit_entries_voided_check
    CHECK (kind <> 'voided' OR (counter_entry_id IS NOT NULL AND note IS NOT NULL));

CREATE UNIQUE INDEX IF NOT EXISTS deposit_entries_one_void_key
  ON deposit_entries (counter_entry_id) WHERE kind = 'voided';

COMMIT;
