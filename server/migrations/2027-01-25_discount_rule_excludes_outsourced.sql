SET LOCAL lock_timeout = '5s';

ALTER TABLE discount_rules ADD COLUMN IF NOT EXISTS excludes_outsourced BOOLEAN NOT NULL DEFAULT FALSE;
