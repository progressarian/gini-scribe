ALTER TABLE billing_imports ALTER COLUMN imported_by SET NOT NULL;

ALTER TABLE billing_audit
  ADD COLUMN IF NOT EXISTS import_id BIGINT REFERENCES billing_imports(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS billing_audit_import_idx
  ON billing_audit (import_id, at)
  WHERE import_id IS NOT NULL;
