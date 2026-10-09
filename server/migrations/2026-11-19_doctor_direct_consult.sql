ALTER TABLE doctors ADD COLUMN IF NOT EXISTS direct_consult BOOLEAN NOT NULL DEFAULT false;

UPDATE doctors SET direct_consult = true WHERE id = 3 AND name = 'Dr. Rahul Katyal';
