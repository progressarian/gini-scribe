SET LOCAL lock_timeout = '5s';

ALTER TABLE bills ADD COLUMN IF NOT EXISTS replaced_by_bill_id UUID REFERENCES bills(id);
