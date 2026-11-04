ALTER TABLE cash_shifts
  ADD COLUMN IF NOT EXISTS handover JSONB,
  ADD COLUMN IF NOT EXISTS denominations JSONB,
  ADD COLUMN IF NOT EXISTS not_counted BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE cash_shifts DROP CONSTRAINT IF EXISTS cash_shifts_difference_check;

ALTER TABLE cash_shifts
  ADD CONSTRAINT cash_shifts_difference_check
  CHECK (
    closed_at IS NULL
    OR (expected_cash IS NOT NULL AND (
         (NOT not_counted AND counted_cash IS NOT NULL
            AND difference = counted_cash - expected_cash)
         OR (not_counted AND counted_cash IS NULL AND difference IS NULL)
       ))
  );

ALTER TABLE cash_shifts DROP CONSTRAINT IF EXISTS cash_shifts_not_counted_check;

ALTER TABLE cash_shifts
  ADD CONSTRAINT cash_shifts_not_counted_check CHECK (closed_at IS NOT NULL OR NOT not_counted);
