CREATE TABLE IF NOT EXISTS billing_imports (
  id           BIGSERIAL PRIMARY KEY,
  file_name    TEXT NOT NULL CHECK (btrim(file_name) <> ''),
  imported_by  INT REFERENCES doctors(id) ON DELETE RESTRICT,
  imported_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  counts       JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(counts) = 'object'),
  status       TEXT NOT NULL CHECK (status IN ('saved', 'failed'))
);

CREATE INDEX IF NOT EXISTS billing_imports_imported_at_idx
  ON billing_imports (imported_at DESC);

ALTER TABLE billing_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_imports FORCE ROW LEVEL SECURITY;
REVOKE ALL ON billing_imports FROM anon, authenticated;
