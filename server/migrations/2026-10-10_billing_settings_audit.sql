CREATE TABLE IF NOT EXISTS billing_settings (
  id                  BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  discount_stacking   TEXT NOT NULL DEFAULT 'best_only' CHECK (discount_stacking IN ('best_only', 'per_rule')),
  allow_pay_later     BOOLEAN NOT NULL DEFAULT FALSE,
  max_codes_per_bill  INT CHECK (max_codes_per_bill >= 1),
  gst_enabled         BOOLEAN NOT NULL DEFAULT FALSE,
  gstin               TEXT CHECK (gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  state_code          TEXT CHECK (state_code ~ '^[0-9]{2}$'),
  legal_name          TEXT CHECK (btrim(legal_name) <> ''),
  bill_footer         TEXT,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by          INT REFERENCES doctors(id) ON DELETE SET NULL,
  CONSTRAINT billing_settings_gstin_state_check
    CHECK (gstin IS NULL OR state_code IS NULL OR left(gstin, 2) = state_code),
  CONSTRAINT billing_settings_gst_needs_details_check
    CHECK (NOT gst_enabled OR (gstin IS NOT NULL AND state_code IS NOT NULL AND legal_name IS NOT NULL))
);

INSERT INTO billing_settings (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION billing_settings_keep_row()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'billing_settings always keeps its one row: change its values instead of deleting it'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE OR REPLACE TRIGGER billing_settings_keep_row
  BEFORE DELETE ON billing_settings
  FOR EACH ROW EXECUTE FUNCTION billing_settings_keep_row();

CREATE TABLE IF NOT EXISTS bill_series (
  series        TEXT NOT NULL CHECK (series ~ '^\S+$'),
  fy            TEXT NOT NULL CHECK (CASE WHEN fy ~ '^[0-9]{4}-[0-9]{2}$'
                                          THEN right(fy, 2)::int = (left(fy, 4)::int + 1) % 100
                                          ELSE FALSE END),
  prefix        TEXT NOT NULL DEFAULT '',
  number_width  INT NOT NULL DEFAULT 6 CHECK (number_width BETWEEN 1 AND 12),
  next_no       BIGINT NOT NULL DEFAULT 1 CHECK (next_no >= 1),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by    INT REFERENCES doctors(id) ON DELETE SET NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by    INT REFERENCES doctors(id) ON DELETE SET NULL,
  PRIMARY KEY (series, fy)
);

CREATE TABLE IF NOT EXISTS billing_audit (
  id         BIGSERIAL PRIMARY KEY,
  entity     TEXT NOT NULL CHECK (btrim(entity) <> ''),
  entity_id  TEXT NOT NULL CHECK (btrim(entity_id) <> ''),
  action     TEXT NOT NULL CHECK (btrim(action) <> ''),
  before     JSONB,
  after      JSONB,
  actor_id   INT REFERENCES doctors(id) ON DELETE RESTRICT,
  at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip         TEXT
);

CREATE INDEX IF NOT EXISTS billing_audit_entity_idx ON billing_audit (entity, entity_id, at DESC);
CREATE INDEX IF NOT EXISTS billing_audit_at_idx ON billing_audit (at DESC);
CREATE INDEX IF NOT EXISTS billing_audit_actor_idx ON billing_audit (actor_id, at DESC);

CREATE OR REPLACE FUNCTION billing_audit_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'billing_audit is append-only: rows cannot be changed or deleted'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE OR REPLACE TRIGGER billing_audit_append_only
  BEFORE UPDATE OR DELETE ON billing_audit
  FOR EACH ROW EXECUTE FUNCTION billing_audit_append_only();

ALTER TABLE billing_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_settings FORCE ROW LEVEL SECURITY;
REVOKE ALL ON billing_settings FROM anon, authenticated;

ALTER TABLE bill_series ENABLE ROW LEVEL SECURITY;
ALTER TABLE bill_series FORCE ROW LEVEL SECURITY;
REVOKE ALL ON bill_series FROM anon, authenticated;

ALTER TABLE billing_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_audit FORCE ROW LEVEL SECURITY;
REVOKE ALL ON billing_audit FROM anon, authenticated;
