SET LOCAL lock_timeout = '5s';

ALTER TABLE pharmacy_medicines DROP COLUMN IF EXISTS allow_loose_sale;
