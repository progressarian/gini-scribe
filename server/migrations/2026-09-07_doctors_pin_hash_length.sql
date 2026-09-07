-- doctors.pin was varchar(10), sized for the legacy plain-text PIN. A bcrypt
-- hash is 60 characters, so every hashed insert failed with 22001 — including
-- POST /api/doctors, which has hashed since it was written.
--
-- Widening a varchar is a catalog-only change in Postgres (no table rewrite,
-- no lock beyond the DDL itself). Existing plain-text PINs are untouched and
-- still accepted: server/routes/auth.js falls back to a literal compare for
-- any value that doesn't start with "$2".
ALTER TABLE doctors ALTER COLUMN pin TYPE VARCHAR(255);
