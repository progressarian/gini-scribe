CREATE TABLE IF NOT EXISTS pharmacy_settings (
  id                      BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  legal_name              TEXT CHECK (legal_name IS NULL OR btrim(legal_name) <> ''),
  gstin                   TEXT CHECK (gstin IS NULL OR gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  drug_license_no         TEXT,
  address                 TEXT,
  phone                   TEXT CHECK (phone IS NULL OR phone ~ '^[0-9]{10,12}$'),
  bill_footer             TEXT,
  sale_rate_includes_gst  BOOLEAN NOT NULL DEFAULT FALSE,
  near_expiry_warn_days   INT NOT NULL DEFAULT 30 CHECK (near_expiry_warn_days BETWEEN 0 AND 365),
  expiry_alert_days       INT NOT NULL DEFAULT 90 CHECK (expiry_alert_days BETWEEN 1 AND 730),
  version                 INT NOT NULL DEFAULT 1,
  updated_by              INT REFERENCES doctors(id) ON DELETE SET NULL,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pharmacy_settings_alert_after_warn CHECK (expiry_alert_days >= near_expiry_warn_days)
);

INSERT INTO pharmacy_settings (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION pharmacy_settings_keep_row()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'pharmacy_settings always keeps its one row: change its values instead of deleting it'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE OR REPLACE TRIGGER pharmacy_settings_keep_row
  BEFORE DELETE ON pharmacy_settings
  FOR EACH ROW EXECUTE FUNCTION pharmacy_settings_keep_row();
