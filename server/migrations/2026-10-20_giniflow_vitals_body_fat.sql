ALTER TABLE giniflow_vitals
  ADD COLUMN IF NOT EXISTS body_fat NUMERIC(4,1);
