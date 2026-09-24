ALTER TABLE giniflow_vitals
  ADD COLUMN IF NOT EXISTS bp_standing_sys INT,
  ADD COLUMN IF NOT EXISTS bp_standing_dia INT,
  ADD COLUMN IF NOT EXISTS waist NUMERIC(5,1);
