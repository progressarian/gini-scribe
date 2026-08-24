CREATE TABLE IF NOT EXISTS corporate_companies (
  id            SERIAL PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  contact_email TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT corporate_companies_slug_format CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$')
);

CREATE TABLE IF NOT EXISTS corporate_packages (
  id          SERIAL PRIMARY KEY,
  company_id  INTEGER NOT NULL REFERENCES corporate_companies(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT corporate_packages_company_name_uniq UNIQUE (company_id, name)
);

CREATE TABLE IF NOT EXISTS corporate_package_tests (
  id              SERIAL PRIMARY KEY,
  package_id      INTEGER NOT NULL REFERENCES corporate_packages(id) ON DELETE CASCADE,
  test_name       TEXT NOT NULL,
  precaution_note TEXT,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT corporate_package_tests_package_name_uniq UNIQUE (package_id, test_name)
);

CREATE INDEX IF NOT EXISTS idx_corporate_packages_company
  ON corporate_packages (company_id)
  WHERE is_active;

CREATE INDEX IF NOT EXISTS idx_corporate_package_tests_package
  ON corporate_package_tests (package_id, sort_order);

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS corporate_company_id INTEGER REFERENCES corporate_companies(id),
  ADD COLUMN IF NOT EXISTS corporate_package_id INTEGER REFERENCES corporate_packages(id),
  ADD COLUMN IF NOT EXISTS corporate_email TEXT;

CREATE INDEX IF NOT EXISTS idx_appointments_corporate_date
  ON appointments (appointment_date, corporate_company_id)
  WHERE corporate_company_id IS NOT NULL;
