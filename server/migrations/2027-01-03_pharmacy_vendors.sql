CREATE TABLE IF NOT EXISTS pharmacy_vendors (
  id                   SERIAL PRIMARY KEY,
  name                 TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 160),
  contact_person       TEXT,
  phone                TEXT NOT NULL CHECK (phone ~ '^[0-9]{10,12}$'),
  alt_phone            TEXT CHECK (alt_phone IS NULL OR alt_phone ~ '^[0-9]{10,12}$'),
  email                TEXT,
  address              TEXT,
  city                 TEXT,
  state                TEXT,
  pincode              TEXT CHECK (pincode IS NULL OR pincode ~ '^[1-9][0-9]{5}$'),
  gstin                TEXT CHECK (gstin IS NULL OR gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  pan                  TEXT CHECK (pan IS NULL OR pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  drug_license_no      TEXT,
  drug_license_expiry  DATE,
  payment_terms_days   INT NOT NULL DEFAULT 0 CHECK (payment_terms_days BETWEEN 0 AND 365),
  bank_name            TEXT,
  bank_account         TEXT CHECK (bank_account IS NULL OR bank_account ~ '^[0-9]{6,20}$'),
  ifsc                 TEXT CHECK (ifsc IS NULL OR ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  notes                TEXT,
  is_active            BOOLEAN NOT NULL DEFAULT TRUE,
  version              INT NOT NULL DEFAULT 1,
  created_by           INT REFERENCES doctors(id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by           INT REFERENCES doctors(id),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS pharmacy_vendors_name_key
  ON pharmacy_vendors (lower(btrim(name)));

CREATE UNIQUE INDEX IF NOT EXISTS pharmacy_vendors_gstin_key
  ON pharmacy_vendors (gstin) WHERE gstin IS NOT NULL;

CREATE INDEX IF NOT EXISTS pharmacy_vendors_active_idx
  ON pharmacy_vendors (is_active, lower(name));
