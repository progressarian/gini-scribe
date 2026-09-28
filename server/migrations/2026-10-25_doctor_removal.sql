ALTER TABLE doctors
  ADD COLUMN IF NOT EXISTS removed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS removed_by INTEGER REFERENCES doctors(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS removed_reason TEXT;

ALTER TABLE doctors DROP CONSTRAINT IF EXISTS doctors_removal_check;
ALTER TABLE doctors ADD CONSTRAINT doctors_removal_check
  CHECK ((removed_at IS NULL AND removed_by IS NULL AND removed_reason IS NULL)
      OR (removed_at IS NOT NULL AND is_active IS FALSE
          AND removed_reason IS NOT NULL AND removed_reason ~ '\S'));
