-- Firebase Cloud Messaging tokens for patient devices. Used by
-- server/services/pushNotifier.js to deliver dose-change decisions (and any
-- future patient-targeted pushes). Firebase admin creds are wired later via
-- env FIREBASE_SERVICE_ACCOUNT (JSON) — without it the notifier no-ops, so
-- this table can be populated safely before push is "live".
--
-- Re-runnable.

DROP TABLE IF EXISTS patient_push_tokens;

CREATE TABLE patient_push_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  fcm_token TEXT NOT NULL,
  platform TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (patient_id, fcm_token)
);

CREATE INDEX idx_patient_push_tokens_patient
  ON patient_push_tokens (patient_id);
