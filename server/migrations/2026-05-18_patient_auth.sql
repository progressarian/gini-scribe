-- Patient-side auth: phone + OTP-bootstrap + password.
--
-- Adds a `kind` column to auth_sessions so the same revocation table can
-- track both doctor and patient sessions; adds password + OTP columns
-- to the patients table.

CREATE TABLE IF NOT EXISTS auth_sessions (
  id         SERIAL PRIMARY KEY,
  kind       TEXT NOT NULL DEFAULT 'doctor',
  doctor_id  INTEGER REFERENCES doctors(id),
  patient_id INTEGER REFERENCES patients(id),
  token      TEXT UNIQUE NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CHECK ((kind = 'doctor'  AND doctor_id  IS NOT NULL)
      OR (kind = 'patient' AND patient_id IS NOT NULL))
);

-- For databases where auth_sessions already exists (created by hand on
-- prod), bring it up to the new shape.
ALTER TABLE auth_sessions ADD COLUMN IF NOT EXISTS kind       TEXT NOT NULL DEFAULT 'doctor';
ALTER TABLE auth_sessions ADD COLUMN IF NOT EXISTS patient_id INTEGER REFERENCES patients(id);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_token   ON auth_sessions(token);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions(expires_at);

ALTER TABLE patients ADD COLUMN IF NOT EXISTS password_hash                 TEXT;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS otp_code                      TEXT;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS otp_expires_at                TIMESTAMPTZ;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS otp_attempts                  SMALLINT DEFAULT 0;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS otp_last_sent_at              TIMESTAMPTZ;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS verification_token            TEXT;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS verification_token_expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_patients_phone ON patients(phone);
