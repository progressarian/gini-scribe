ALTER TABLE patient_schemes
  ADD COLUMN IF NOT EXISTS parent_code TEXT,
  ADD COLUMN IF NOT EXISTS payer_name TEXT,
  ADD COLUMN IF NOT EXISTS requires_referral BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS requires_referral_doc BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS print_category_on_bill BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS allow_pay_later BOOLEAN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'patient_schemes_parent_code_fkey') THEN
    ALTER TABLE patient_schemes
      ADD CONSTRAINT patient_schemes_parent_code_fkey
      FOREIGN KEY (parent_code) REFERENCES patient_schemes(code) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'patient_schemes_parent_not_self_check') THEN
    ALTER TABLE patient_schemes
      ADD CONSTRAINT patient_schemes_parent_not_self_check CHECK (parent_code <> code);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'patient_schemes_payer_name_check') THEN
    ALTER TABLE patient_schemes
      ADD CONSTRAINT patient_schemes_payer_name_check
      CHECK (payer_name IS NULL OR btrim(payer_name) <> '');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_patient_schemes_parent_code
  ON patient_schemes (parent_code) WHERE parent_code IS NOT NULL;

CREATE OR REPLACE FUNCTION patient_schemes_two_levels_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.parent_code IS NULL THEN
    RETURN NEW;
  END IF;
  PERFORM 1 FROM patient_schemes WHERE code = NEW.parent_code FOR UPDATE;
  IF EXISTS (SELECT 1 FROM patient_schemes WHERE code = NEW.parent_code AND parent_code IS NOT NULL) THEN
    RAISE EXCEPTION 'Category "%" is already a sub-category, so "%" cannot go under it: only two levels are allowed',
      NEW.parent_code, NEW.code
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM patient_schemes WHERE parent_code = NEW.code) THEN
    RAISE EXCEPTION 'Category "%" has sub-categories, so it cannot become a sub-category itself: only two levels are allowed',
      NEW.code
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER patient_schemes_two_levels_only
  BEFORE INSERT OR UPDATE OF parent_code ON patient_schemes
  FOR EACH ROW EXECUTE FUNCTION patient_schemes_two_levels_only();

CREATE TABLE IF NOT EXISTS category_rules (
  id             SERIAL PRIMARY KEY,
  scheme_code    TEXT NOT NULL REFERENCES patient_schemes(code) ON DELETE RESTRICT,
  name           TEXT NOT NULL CHECK (btrim(name) <> ''),
  min_age        INT CHECK (min_age BETWEEN 0 AND 150),
  max_age        INT CHECK (max_age BETWEEN 0 AND 150),
  gender         TEXT CHECK (gender IN ('Male', 'Female', 'Other')),
  requires_card  BOOLEAN NOT NULL DEFAULT FALSE,
  mode           TEXT NOT NULL DEFAULT 'suggest' CHECK (mode IN ('suggest', 'auto')),
  priority       INT NOT NULL DEFAULT 100 CHECK (priority >= 0),
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by     INT REFERENCES doctors(id) ON DELETE SET NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by     INT REFERENCES doctors(id) ON DELETE SET NULL,
  CONSTRAINT category_rules_age_order_check CHECK (min_age IS NULL OR max_age IS NULL OR min_age <= max_age),
  CONSTRAINT category_rules_has_criterion_check
    CHECK (min_age IS NOT NULL OR max_age IS NOT NULL OR gender IS NOT NULL OR requires_card)
);

CREATE UNIQUE INDEX IF NOT EXISTS category_rules_scheme_name_key
  ON category_rules (scheme_code, lower(name));

CREATE INDEX IF NOT EXISTS category_rules_active_priority_idx
  ON category_rules (priority) WHERE is_active;

CREATE TABLE IF NOT EXISTS category_item_rates (
  scheme_code      TEXT NOT NULL REFERENCES patient_schemes(code) ON DELETE RESTRICT,
  service_item_id  INT NOT NULL REFERENCES service_items(id) ON DELETE RESTRICT,
  rate             NUMERIC(12,2) CHECK (rate >= 0),
  bill_name        TEXT CHECK (btrim(bill_name) <> ''),
  bill_code        TEXT CHECK (bill_code ~ '^\S+$'),
  valid_from       DATE NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Kolkata')::date,
  valid_to         DATE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by       INT REFERENCES doctors(id) ON DELETE SET NULL,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by       INT REFERENCES doctors(id) ON DELETE SET NULL,
  PRIMARY KEY (scheme_code, service_item_id, valid_from),
  CONSTRAINT category_item_rates_dates_check CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CONSTRAINT category_item_rates_changes_something_check
    CHECK (rate IS NOT NULL OR bill_name IS NOT NULL OR bill_code IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS category_item_rates_item_idx
  ON category_item_rates (service_item_id, scheme_code, valid_from DESC);

ALTER TABLE category_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE category_rules FORCE ROW LEVEL SECURITY;
REVOKE ALL ON category_rules FROM anon, authenticated;

ALTER TABLE category_item_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE category_item_rates FORCE ROW LEVEL SECURITY;
REVOKE ALL ON category_item_rates FROM anon, authenticated;
