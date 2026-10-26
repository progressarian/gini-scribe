ALTER TABLE doctors ADD COLUMN IF NOT EXISTS new_patient_workup BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE doctors ADD COLUMN IF NOT EXISTS assists_doctor_id INTEGER REFERENCES doctors(id);

ALTER TABLE doctors DROP CONSTRAINT IF EXISTS doctors_assists_not_self;
ALTER TABLE doctors ADD CONSTRAINT doctors_assists_not_self
  CHECK (assists_doctor_id IS NULL OR assists_doctor_id <> id);

CREATE TABLE IF NOT EXISTS new_patient_workups (
  id                     SERIAL PRIMARY KEY,
  appointment_id         INTEGER NOT NULL UNIQUE REFERENCES appointments(id),
  patient_id             INTEGER NOT NULL REFERENCES patients(id),
  history                JSONB NOT NULL DEFAULT '{}'::jsonb,
  exam                   JSONB NOT NULL DEFAULT '{}'::jsonb,
  prepared_by_doctor_id  INTEGER REFERENCES doctors(id),
  updated_by_doctor_id   INTEGER REFERENCES doctors(id),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_new_patient_workups_patient
  ON new_patient_workups (patient_id, created_at);

ALTER TABLE new_patient_workups ENABLE ROW LEVEL SECURITY;
ALTER TABLE new_patient_workups FORCE ROW LEVEL SECURITY;
REVOKE ALL ON new_patient_workups FROM anon, authenticated;
