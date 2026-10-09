ALTER TABLE doctors ADD COLUMN IF NOT EXISTS chief_step BOOLEAN NOT NULL DEFAULT false;

UPDATE doctors SET chief_step = true WHERE is_chief AND is_active;
