-- Access/refresh token auth. Additive — doesn't touch auth_sessions, which
-- keeps gating access tokens on every request exactly as before (see
-- docs/ACCESS_REFRESH_TOKEN_AUTH_PLAN.md §2a for why that stays).
--
-- Refresh tokens are opaque random strings, never JWTs, stored only as a
-- sha256 hash. family_id is constant across one login's rotation chain so
-- reuse of an already-rotated token can revoke the whole chain at once.

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id           SERIAL PRIMARY KEY,
  kind         TEXT NOT NULL DEFAULT 'doctor',      -- 'doctor' | 'patient'
  doctor_id    INTEGER REFERENCES doctors(id),
  patient_db   TEXT,                                -- 'hospital' | 'app', patient sessions only
  patient_ref  TEXT,                                -- patients.id or app-db uuid, as text
  token_hash   TEXT UNIQUE NOT NULL,                 -- sha256(raw refresh token), hex
  family_id    TEXT NOT NULL,                        -- constant across one login's rotation chain
  revoked_at   TIMESTAMPTZ,                          -- set on rotation, logout, or reuse-detection
  expires_at   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  user_agent   TEXT,
  ip           TEXT,
  CHECK ((kind = 'doctor'  AND doctor_id   IS NOT NULL)
      OR (kind = 'patient' AND patient_ref IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash    ON refresh_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_family  ON refresh_tokens(family_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires ON refresh_tokens(expires_at);
