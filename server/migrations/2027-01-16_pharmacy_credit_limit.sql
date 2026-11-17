ALTER TABLE pharmacy_settings
  ADD COLUMN IF NOT EXISTS credit_limit NUMERIC(12, 2)
  CHECK (credit_limit IS NULL OR credit_limit >= 0);
