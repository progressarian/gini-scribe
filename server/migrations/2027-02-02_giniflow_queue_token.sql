ALTER TABLE doctors
  ADD COLUMN IF NOT EXISTS token_queue BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE giniflow_visits
  ADD COLUMN IF NOT EXISTS token_no     INT,
  ADD COLUMN IF NOT EXISTS token_set_by INT REFERENCES doctors(id),
  ADD COLUMN IF NOT EXISTS token_set_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'giniflow_visits_token_no_range'
  ) THEN
    ALTER TABLE giniflow_visits
      ADD CONSTRAINT giniflow_visits_token_no_range CHECK (token_no BETWEEN 1 AND 9999);
  END IF;
END $$;
