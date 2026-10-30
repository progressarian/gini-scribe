SET LOCAL lock_timeout = '5s';

ALTER TABLE lab_cases
  ADD COLUMN IF NOT EXISTS outside_stage TEXT,
  ADD COLUMN IF NOT EXISTS outside_uploaded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS outside_stage_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lab_cases_outside_stage_check') THEN
    ALTER TABLE lab_cases ADD CONSTRAINT lab_cases_outside_stage_check
      CHECK (outside_stage IN ('collected', 'sent', 'uploaded'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS giniflow_outside_stage_queue (
  id BIGSERIAL PRIMARY KEY,
  case_no TEXT,
  patient_id INT,
  day DATE,
  every_case BOOLEAN NOT NULL DEFAULT FALSE,
  queued_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION giniflow_queue_outside_case() RETURNS trigger AS $$
BEGIN
  INSERT INTO giniflow_outside_stage_queue (case_no)
  VALUES (CASE WHEN TG_OP = 'DELETE' THEN OLD.case_no ELSE NEW.case_no END);
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION giniflow_queue_outside_bill() RETURNS trigger AS $$
BEGIN
  INSERT INTO giniflow_outside_stage_queue (patient_id, day) VALUES (NEW.patient_id, NEW.bill_date);
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION giniflow_queue_outside_visit() RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    INSERT INTO giniflow_outside_stage_queue (patient_id, day)
    SELECT v.patient_id, v.visit_date FROM giniflow_visits v WHERE v.id = OLD.visit_id;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    INSERT INTO giniflow_outside_stage_queue (patient_id, day)
    SELECT v.patient_id, v.visit_date FROM giniflow_visits v WHERE v.id = NEW.visit_id;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION giniflow_queue_outside_every_case() RETURNS trigger AS $$
BEGIN
  INSERT INTO giniflow_outside_stage_queue (every_case) VALUES (TRUE);
  RETURN NULL;
END $$ LANGUAGE plpgsql;
