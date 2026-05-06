ALTER TABLE medications
  ADD COLUMN IF NOT EXISTS days_of_week INTEGER[];
