SET LOCAL lock_timeout = '5s';

ALTER TABLE bills
  ADD COLUMN IF NOT EXISTS edit_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS edit_started_by INT REFERENCES doctors(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS edit_snapshot JSONB,
  ADD COLUMN IF NOT EXISTS revision_no INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS revised_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revised_by INT REFERENCES doctors(id) ON DELETE SET NULL;

ALTER TABLE bills DROP CONSTRAINT IF EXISTS bills_edit_session_check;
ALTER TABLE bills ADD CONSTRAINT bills_edit_session_check
  CHECK (
    (edit_started_at IS NULL) = (edit_snapshot IS NULL)
    AND (edit_started_at IS NULL OR (status = 'final' AND bill_type = 'invoice'))
  );

ALTER TABLE bills DROP CONSTRAINT IF EXISTS bills_revision_no_check;
ALTER TABLE bills ADD CONSTRAINT bills_revision_no_check CHECK (revision_no >= 0);

CREATE TABLE IF NOT EXISTS bill_revisions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id      UUID NOT NULL REFERENCES bills(id) ON DELETE RESTRICT,
  revision_no  INT NOT NULL CHECK (revision_no > 0),
  reason       TEXT NOT NULL CHECK (reason ~ '\S'),
  before       JSONB NOT NULL,
  after        JSONB NOT NULL,
  revised_by   INT REFERENCES doctors(id) ON DELETE SET NULL,
  revised_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT bill_revisions_bill_revision_key UNIQUE (bill_id, revision_no)
);

CREATE OR REPLACE FUNCTION bill_revisions_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'bill_revisions is append-only: rows cannot be changed or deleted'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE OR REPLACE TRIGGER bill_revisions_append_only
  BEFORE UPDATE OR DELETE ON bill_revisions
  FOR EACH ROW EXECUTE FUNCTION bill_revisions_append_only();

ALTER TABLE bill_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE bill_revisions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON bill_revisions FROM anon, authenticated;
