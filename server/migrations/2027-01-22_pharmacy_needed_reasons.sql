ALTER TABLE pharmacy_bill_med_outcomes ADD COLUMN IF NOT EXISTS note TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pharmacy_bill_med_outcomes_note_length'
  ) THEN
    ALTER TABLE pharmacy_bill_med_outcomes
      ADD CONSTRAINT pharmacy_bill_med_outcomes_note_length
      CHECK (note IS NULL OR char_length(note) <= 300);
  END IF;
END $$;

ALTER TABLE pharmacy_medicine_requests ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'counter';
ALTER TABLE pharmacy_medicine_requests ADD COLUMN IF NOT EXISTS reason TEXT;
ALTER TABLE pharmacy_medicine_requests ADD COLUMN IF NOT EXISTS note TEXT;
ALTER TABLE pharmacy_medicine_requests ADD COLUMN IF NOT EXISTS qty_units INT;
ALTER TABLE pharmacy_medicine_requests ADD COLUMN IF NOT EXISTS needed_on DATE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pharmacy_medicine_requests_source'
  ) THEN
    ALTER TABLE pharmacy_medicine_requests
      ADD CONSTRAINT pharmacy_medicine_requests_source CHECK (source IN ('counter', 'import'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pharmacy_medicine_requests_reason'
  ) THEN
    ALTER TABLE pharmacy_medicine_requests
      ADD CONSTRAINT pharmacy_medicine_requests_reason
      CHECK (reason IS NULL OR reason ~ '^[a-z_]{2,40}$');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pharmacy_medicine_requests_details'
  ) THEN
    ALTER TABLE pharmacy_medicine_requests
      ADD CONSTRAINT pharmacy_medicine_requests_details
      CHECK ((note IS NULL OR char_length(note) <= 300) AND (qty_units IS NULL OR qty_units > 0));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS pharmacy_medicine_requests_import
  ON pharmacy_medicine_requests (medicine_key, needed_on) WHERE source = 'import';

CREATE INDEX IF NOT EXISTS idx_medcoll_not_given_date
  ON medicine_collections (collected_date) WHERE status IN ('not_given', 'partial');
