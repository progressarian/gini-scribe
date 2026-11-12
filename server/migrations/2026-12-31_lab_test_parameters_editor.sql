SET LOCAL lock_timeout = '5s';

ALTER TABLE giniflow_test_catalog
  ADD COLUMN IF NOT EXISTS lab_report_id BIGINT REFERENCES lab_report_catalog(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS results_as_file BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS giniflow_test_catalog_lab_report_idx
  ON giniflow_test_catalog (lab_report_id);

ALTER TABLE lab_test_catalog
  ADD COLUMN IF NOT EXISTS options TEXT[],
  ADD COLUMN IF NOT EXISTS decimals SMALLINT,
  ADD COLUMN IF NOT EXISTS no_unit BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE lab_test_catalog DROP CONSTRAINT IF EXISTS lab_test_catalog_input_type_check;
ALTER TABLE lab_test_catalog
  ADD CONSTRAINT lab_test_catalog_input_type_check
  CHECK (input_type IN ('numeric', 'text', 'group', 'select'))
  NOT VALID;
ALTER TABLE lab_test_catalog VALIDATE CONSTRAINT lab_test_catalog_input_type_check;

ALTER TABLE lab_test_catalog DROP CONSTRAINT IF EXISTS lab_test_catalog_decimals_check;
ALTER TABLE lab_test_catalog
  ADD CONSTRAINT lab_test_catalog_decimals_check
  CHECK (decimals IS NULL OR decimals BETWEEN 0 AND 4)
  NOT VALID;
ALTER TABLE lab_test_catalog VALIDATE CONSTRAINT lab_test_catalog_decimals_check;

ALTER TABLE lab_test_catalog DROP CONSTRAINT IF EXISTS lab_test_catalog_select_options_check;
ALTER TABLE lab_test_catalog
  ADD CONSTRAINT lab_test_catalog_select_options_check
  CHECK (input_type <> 'select' OR COALESCE(cardinality(options), 0) >= 2)
  NOT VALID;
ALTER TABLE lab_test_catalog VALIDATE CONSTRAINT lab_test_catalog_select_options_check;

CREATE TABLE IF NOT EXISTS lab_catalog_audit (
  id         BIGSERIAL PRIMARY KEY,
  entity     TEXT NOT NULL CHECK (entity IN ('report', 'field', 'ranges', 'link', 'order')),
  entity_id  TEXT NOT NULL CHECK (btrim(entity_id) <> ''),
  action     TEXT NOT NULL CHECK (btrim(action) <> ''),
  before     JSONB,
  after      JSONB,
  actor_id   INT REFERENCES doctors(id) ON DELETE RESTRICT,
  at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS lab_catalog_audit_entity_idx
  ON lab_catalog_audit (entity, entity_id, at DESC);
CREATE INDEX IF NOT EXISTS lab_catalog_audit_at_idx ON lab_catalog_audit (at DESC);

CREATE OR REPLACE FUNCTION lab_catalog_audit_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'lab_catalog_audit is append-only: rows cannot be changed or deleted'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE OR REPLACE TRIGGER lab_catalog_audit_append_only
  BEFORE UPDATE OR DELETE ON lab_catalog_audit
  FOR EACH ROW EXECUTE FUNCTION lab_catalog_audit_append_only();

ALTER TABLE lab_catalog_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE lab_catalog_audit FORCE ROW LEVEL SECURITY;
REVOKE ALL ON lab_catalog_audit FROM anon, authenticated;
