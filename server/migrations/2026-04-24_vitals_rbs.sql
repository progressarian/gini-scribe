-- Adds random blood sugar + meal context to scribe's vitals table so doctor
-- entries on /visit push to Genie vitals.rbs (and pull-back stays lossless).
ALTER TABLE vitals ADD COLUMN IF NOT EXISTS rbs NUMERIC;
ALTER TABLE vitals ADD COLUMN IF NOT EXISTS meal_type TEXT;
