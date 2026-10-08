ALTER TABLE doctors ADD COLUMN IF NOT EXISTS vitals_rest BOOLEAN NOT NULL DEFAULT true;

UPDATE doctors SET vitals_rest = false WHERE id = 3 AND name = 'Dr. Rahul Katyal';
