CREATE TABLE IF NOT EXISTS billing_import_sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_name     TEXT NOT NULL CHECK (file_name ~ '\S'),
  file          BYTEA CHECK (octet_length(file) > 0),
  uploaded_by   INT NOT NULL REFERENCES doctors(id) ON DELETE RESTRICT,
  uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'committed', 'abandoned')),
  counts        JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(counts) = 'object'),
  import_id     BIGINT UNIQUE REFERENCES billing_imports(id) ON DELETE RESTRICT,
  committed_by  INT REFERENCES doctors(id) ON DELETE RESTRICT,
  committed_at  TIMESTAMPTZ,
  row_state     TEXT GENERATED ALWAYS AS (
                  CASE status WHEN 'open' THEN 'open' WHEN 'committed' THEN 'committed' END
                ) STORED,
  CONSTRAINT billing_import_sessions_expiry_check CHECK (expires_at > uploaded_at),
  CONSTRAINT billing_import_sessions_abandoned_file_check
    CHECK ((status = 'abandoned') = (file IS NULL)),
  CONSTRAINT billing_import_sessions_committed_check
    CHECK ((status = 'committed') = (import_id IS NOT NULL)),
  CONSTRAINT billing_import_sessions_committed_by_check
    CHECK ((import_id IS NULL) = (committed_by IS NULL)
       AND (import_id IS NULL) = (committed_at IS NULL)),
  CONSTRAINT billing_import_sessions_committed_at_check CHECK (committed_at >= uploaded_at),
  CONSTRAINT billing_import_sessions_row_state_key UNIQUE (id, row_state)
);

CREATE INDEX IF NOT EXISTS billing_import_sessions_stale_idx
  ON billing_import_sessions (expires_at)
  WHERE status <> 'committed';

CREATE INDEX IF NOT EXISTS billing_import_sessions_uploaded_idx
  ON billing_import_sessions (uploaded_by, uploaded_at DESC);

CREATE TABLE IF NOT EXISTS billing_import_rows (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id     UUID NOT NULL REFERENCES billing_import_sessions(id) ON DELETE CASCADE,
  sheet          TEXT NOT NULL CHECK (sheet IN ('Groups', 'Subgroups', 'Items', 'Categories',
                   'Category rules', 'Category rates', 'Payment rules', 'Consultant fees',
                   'Discounts')),
  row_no         INT NOT NULL CHECK (row_no >= 2),
  row_key        TEXT NOT NULL,
  label          TEXT,
  status         TEXT NOT NULL CHECK (status IN ('ready', 'override', 'unchanged', 'failed')),
  decision       TEXT CHECK (decision IN ('pending', 'override', 'keep')),
  reason         TEXT CHECK (reason ~ '\S'),
  errors         JSONB CHECK (jsonb_typeof(errors) = 'array' AND jsonb_array_length(errors) > 0),
  warnings       JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(warnings) = 'array'),
  "values"       JSONB NOT NULL CHECK (jsonb_typeof("values") = 'object'),
  input          JSONB NOT NULL CHECK (jsonb_typeof(input) = 'object'),
  before         JSONB,
  changes        JSONB CHECK (jsonb_typeof(changes) = 'array'),
  depends_on     BIGINT,
  outcome        TEXT CHECK (outcome IN ('saved', 'kept', 'failed', 'unchanged')),
  session_state  TEXT NOT NULL GENERATED ALWAYS AS (
                   CASE WHEN outcome IS NULL THEN 'open' ELSE 'committed' END
                 ) STORED,
  CONSTRAINT billing_import_rows_row_key UNIQUE (session_id, sheet, row_no),
  CONSTRAINT billing_import_rows_session_id_key UNIQUE (session_id, id),
  CONSTRAINT billing_import_rows_session_state_fkey
    FOREIGN KEY (session_id, session_state)
    REFERENCES billing_import_sessions (id, row_state)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT billing_import_rows_depends_on_fkey
    FOREIGN KEY (session_id, depends_on)
    REFERENCES billing_import_rows (session_id, id),
  CONSTRAINT billing_import_rows_blank_key_check CHECK (row_key ~ '\S' OR status = 'failed'),
  CONSTRAINT billing_import_rows_override_decision_check
    CHECK ((status = 'override') = (decision IS NOT NULL)),
  CONSTRAINT billing_import_rows_failed_reason_check
    CHECK ((status = 'failed' OR outcome IS NOT DISTINCT FROM 'failed') = (reason IS NOT NULL)),
  CONSTRAINT billing_import_rows_reason_errors_check CHECK ((reason IS NULL) = (errors IS NULL)),
  CONSTRAINT billing_import_rows_override_before_check
    CHECK ((status = 'override') = (before IS NOT NULL)),
  CONSTRAINT billing_import_rows_status_changes_check
    CHECK (CASE status
             WHEN 'override' THEN changes IS NOT NULL AND jsonb_array_length(changes) > 0
             WHEN 'failed' THEN TRUE
             ELSE changes IS NULL
           END),
  CONSTRAINT billing_import_rows_failed_depends_on_check
    CHECK (depends_on IS NULL
           OR ((status = 'failed' OR outcome IS NOT DISTINCT FROM 'failed') AND depends_on <> id)),
  CONSTRAINT billing_import_rows_status_outcome_check
    CHECK (outcome IS NULL OR CASE status
             WHEN 'ready' THEN outcome IN ('saved', 'failed')
             WHEN 'override' THEN (decision = 'override' AND outcome IN ('saved', 'failed'))
                               OR (decision <> 'override' AND outcome = 'kept')
             WHEN 'unchanged' THEN outcome = 'unchanged'
             ELSE outcome = 'failed'
           END)
);

CREATE INDEX IF NOT EXISTS billing_import_rows_list_idx
  ON billing_import_rows (session_id, status, sheet, row_no);

CREATE INDEX IF NOT EXISTS billing_import_rows_depends_on_idx
  ON billing_import_rows (session_id, depends_on)
  WHERE depends_on IS NOT NULL;

ALTER TABLE billing_import_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_import_sessions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON billing_import_sessions FROM anon, authenticated;

ALTER TABLE billing_import_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_import_rows FORCE ROW LEVEL SECURITY;
REVOKE ALL ON billing_import_rows FROM anon, authenticated;
