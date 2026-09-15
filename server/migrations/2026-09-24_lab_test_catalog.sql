-- ============================================================
-- Lab test catalogue: HealthRay's reports, tests, formulas and ranges.
-- 2026-09-24 · docs/gini-flow/44-LAB-TEST-CATALOG-PLAN.md
--
--   node migrations/_runOne.mjs migrations/2026-09-24_lab_test_catalog.sql
-- ============================================================

CREATE SEQUENCE IF NOT EXISTS lab_catalog_manual_id_seq START 900000000;

CREATE TABLE IF NOT EXISTS lab_report_catalog (
  id          BIGINT PRIMARY KEY DEFAULT nextval('lab_catalog_manual_id_seq'),
  name        TEXT NOT NULL,
  aliases     TEXT[] NOT NULL DEFAULT '{}',
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  source      TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('healthray', 'manual')),
  edited_at   TIMESTAMPTZ,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS lab_test_catalog (
  id              BIGINT PRIMARY KEY DEFAULT nextval('lab_catalog_manual_id_seq'),
  parent_test_id  BIGINT REFERENCES lab_test_catalog(id) ON DELETE SET NULL,
  sequence        INT,
  name            TEXT NOT NULL,
  unit            TEXT,
  input_type      TEXT NOT NULL DEFAULT 'numeric' CHECK (input_type IN ('numeric', 'text')),
  formula         TEXT,
  canonical_name  TEXT,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  source          TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('healthray', 'manual')),
  edited_at       TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS lab_report_tests (
  report_id  BIGINT NOT NULL REFERENCES lab_report_catalog(id) ON DELETE CASCADE,
  test_id    BIGINT NOT NULL REFERENCES lab_test_catalog(id) ON DELETE CASCADE,
  sequence   INT NOT NULL DEFAULT 0,
  PRIMARY KEY (report_id, test_id)
);

CREATE TABLE IF NOT EXISTS lab_test_ranges (
  id                BIGSERIAL PRIMARY KEY,
  test_id           BIGINT NOT NULL REFERENCES lab_test_catalog(id) ON DELETE CASCADE,
  gender            TEXT NOT NULL DEFAULT 'Both' CHECK (gender IN ('Both', 'Male', 'Female')),
  min_age_days      INT NOT NULL DEFAULT 0,
  max_age_days      INT NOT NULL DEFAULT 36500,
  min_value         NUMERIC,
  max_value         NUMERIC,
  min_critical      NUMERIC,
  max_critical      NUMERIC,
  text_range        TEXT,
  is_pregnant       BOOLEAN NOT NULL DEFAULT FALSE,
  healthray_ref_id  BIGINT UNIQUE,
  source            TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('healthray', 'manual')),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lab_report_tests_test ON lab_report_tests(test_id);
CREATE INDEX IF NOT EXISTS idx_lab_test_ranges_test ON lab_test_ranges(test_id);
CREATE INDEX IF NOT EXISTS idx_lab_test_catalog_parent ON lab_test_catalog(parent_test_id);
