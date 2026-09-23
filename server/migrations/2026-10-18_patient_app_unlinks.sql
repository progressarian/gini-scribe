CREATE TABLE IF NOT EXISTS patient_app_unlinks (
  id             SERIAL PRIMARY KEY,
  phone_last10   TEXT        NOT NULL,
  patient_id     INTEGER     REFERENCES patients(id) ON DELETE CASCADE,
  app_patient_id TEXT,
  reason         TEXT        NOT NULL,
  requested_by   TEXT        NOT NULL,
  unlinked_by    INTEGER     REFERENCES doctors(id),
  unlinked_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  relinked_by    INTEGER     REFERENCES doctors(id),
  relinked_at    TIMESTAMPTZ,
  CONSTRAINT patient_app_unlinks_one_target
    CHECK ((patient_id IS NULL) <> (app_patient_id IS NULL)),
  CONSTRAINT patient_app_unlinks_phone_digits
    CHECK (phone_last10 ~ '^[0-9]{10}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_patient_app_unlinks_active_hospital
  ON patient_app_unlinks (phone_last10, patient_id)
  WHERE relinked_at IS NULL AND patient_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_patient_app_unlinks_active_app
  ON patient_app_unlinks (phone_last10, app_patient_id)
  WHERE relinked_at IS NULL AND app_patient_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_patient_app_unlinks_patient
  ON patient_app_unlinks (patient_id, unlinked_at DESC);
