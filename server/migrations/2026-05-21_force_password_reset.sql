-- Staff-initiated password resets generate a temporary password and flip
-- this flag; the app routes the patient to a forced "set a new password"
-- screen on next login. Cleared whenever a password is set or changed by
-- the patient themselves.

ALTER TABLE patients ADD COLUMN IF NOT EXISTS force_password_reset BOOLEAN NOT NULL DEFAULT FALSE;
