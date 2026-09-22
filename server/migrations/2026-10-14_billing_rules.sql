CREATE OR REPLACE FUNCTION billing_array_is_distinct(anyarray) RETURNS boolean
  LANGUAGE sql IMMUTABLE AS $$ SELECT count(*) = count(DISTINCT v) FROM unnest($1) AS v $$;

CREATE TABLE IF NOT EXISTS category_payment_rules (
  id               SERIAL PRIMARY KEY,
  scheme_code      TEXT NOT NULL REFERENCES patient_schemes(code) ON DELETE RESTRICT,
  name             TEXT NOT NULL CHECK (name ~ '\S' AND name !~ '^\s|\s$'),
  group_id         INT REFERENCES service_groups(id) ON DELETE RESTRICT,
  subgroup_id      INT REFERENCES service_subgroups(id) ON DELETE RESTRICT,
  service_item_id  INT REFERENCES service_items(id) ON DELETE RESTRICT,
  visit_types      TEXT[] CHECK (
                     visit_types IS NULL OR (
                       cardinality(visit_types) > 0
                       AND array_position(visit_types, NULL) IS NULL
                       AND visit_types <@ ARRAY['New', 'Follow Up', 'Investigation']::text[]
                       AND billing_array_is_distinct(visit_types)
                     )
                   ),
  patient_pays     TEXT NOT NULL CHECK (patient_pays IN ('full', 'amount', 'percent', 'nothing')),
  patient_value    NUMERIC(12,2) CHECK (patient_value >= 0),
  remainder        TEXT NOT NULL DEFAULT 'claim' CHECK (remainder IN ('claim', 'adjustment')),
  valid_from       DATE NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Kolkata')::date,
  valid_to         DATE,
  priority         INT NOT NULL DEFAULT 100 CHECK (priority >= 0),
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by       INT REFERENCES doctors(id) ON DELETE SET NULL,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by       INT REFERENCES doctors(id) ON DELETE SET NULL,
  CONSTRAINT category_payment_rules_one_scope_check
    CHECK (num_nonnulls(group_id, subgroup_id, service_item_id) <= 1),
  CONSTRAINT category_payment_rules_value_check
    CHECK (
      (patient_pays IN ('amount', 'percent') AND patient_value IS NOT NULL)
      OR (patient_pays IN ('full', 'nothing') AND patient_value IS NULL)
    ),
  CONSTRAINT category_payment_rules_percent_check
    CHECK (patient_pays <> 'percent' OR patient_value <= 100),
  CONSTRAINT category_payment_rules_dates_check
    CHECK (valid_to IS NULL OR valid_to >= valid_from)
);

CREATE UNIQUE INDEX IF NOT EXISTS category_payment_rules_scheme_name_key
  ON category_payment_rules (scheme_code, lower(name));

CREATE INDEX IF NOT EXISTS category_payment_rules_active_idx
  ON category_payment_rules (scheme_code, priority) WHERE is_active;

CREATE INDEX IF NOT EXISTS category_payment_rules_group_idx
  ON category_payment_rules (group_id) WHERE group_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS category_payment_rules_subgroup_idx
  ON category_payment_rules (subgroup_id) WHERE subgroup_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS category_payment_rules_item_idx
  ON category_payment_rules (service_item_id) WHERE service_item_id IS NOT NULL;

ALTER TABLE category_payment_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE category_payment_rules FORCE ROW LEVEL SECURITY;
REVOKE ALL ON category_payment_rules FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS discount_rules (
  id                          SERIAL PRIMARY KEY,
  code                        TEXT CHECK (code ~ '^\S+$'),
  name                        TEXT NOT NULL CHECK (name ~ '\S' AND name !~ '^\s|\s$'),
  method                      TEXT NOT NULL CHECK (method IN ('auto', 'code')),
  kind                        TEXT NOT NULL CHECK (kind IN ('percent', 'flat', 'fixed_price')),
  value                       NUMERIC(12,2) NOT NULL CHECK (value >= 0),
  max_discount                NUMERIC(12,2) CHECK (max_discount >= 0),
  group_ids                   INT[] CHECK (
                                group_ids IS NULL OR (
                                  cardinality(group_ids) > 0
                                  AND array_position(group_ids, NULL) IS NULL
                                  AND billing_array_is_distinct(group_ids)
                                )
                              ),
  subgroup_ids                INT[] CHECK (
                                subgroup_ids IS NULL OR (
                                  cardinality(subgroup_ids) > 0
                                  AND array_position(subgroup_ids, NULL) IS NULL
                                  AND billing_array_is_distinct(subgroup_ids)
                                )
                              ),
  service_item_ids            INT[] CHECK (
                                service_item_ids IS NULL OR (
                                  cardinality(service_item_ids) > 0
                                  AND array_position(service_item_ids, NULL) IS NULL
                                  AND billing_array_is_distinct(service_item_ids)
                                )
                              ),
  doctor_ids                  INT[] CHECK (
                                doctor_ids IS NULL OR (
                                  cardinality(doctor_ids) > 0
                                  AND array_position(doctor_ids, NULL) IS NULL
                                  AND billing_array_is_distinct(doctor_ids)
                                )
                              ),
  visit_types                 TEXT[] CHECK (
                                visit_types IS NULL OR (
                                  cardinality(visit_types) > 0
                                  AND array_position(visit_types, NULL) IS NULL
                                  AND visit_types <@ ARRAY['New', 'Follow Up', 'Investigation']::text[]
                                  AND billing_array_is_distinct(visit_types)
                                )
                              ),
  scheme_codes                TEXT[] CHECK (
                                scheme_codes IS NULL OR (
                                  cardinality(scheme_codes) > 0
                                  AND array_position(scheme_codes, NULL) IS NULL
                                  AND billing_array_is_distinct(scheme_codes)
                                  AND array_to_string(scheme_codes, ',') ~ '^[a-z0-9_]{2,32}(,[a-z0-9_]{2,32})*$'
                                )
                              ),
  min_age                     INT CHECK (min_age BETWEEN 0 AND 150),
  max_age                     INT CHECK (max_age BETWEEN 0 AND 150),
  gender                      TEXT CHECK (gender IN ('Male', 'Female', 'Other')),
  valid_from                  DATE,
  valid_to                    DATE,
  max_uses_total              INT CHECK (max_uses_total >= 1),
  max_uses_per_patient        INT CHECK (max_uses_per_patient >= 1),
  max_uses_per_day            INT CHECK (max_uses_per_day >= 1),
  max_uses_per_doctor_per_day INT CHECK (max_uses_per_doctor_per_day >= 1),
  applies_per                 TEXT NOT NULL DEFAULT 'line' CHECK (applies_per IN ('line', 'bill')),
  priority                    INT NOT NULL DEFAULT 100 CHECK (priority >= 0),
  stackable                   BOOLEAN NOT NULL DEFAULT FALSE,
  applies_on_scheme_rate      BOOLEAN NOT NULL DEFAULT FALSE,
  allowed_roles               TEXT[] CHECK (
                                allowed_roles IS NULL OR (
                                  cardinality(allowed_roles) > 0
                                  AND array_position(allowed_roles, NULL) IS NULL
                                  AND allowed_roles <@ ARRAY['reception', 'reception_admin', 'admin']::text[]
                                  AND billing_array_is_distinct(allowed_roles)
                                )
                              ),
  is_active                   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by                  INT REFERENCES doctors(id) ON DELETE SET NULL,
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by                  INT REFERENCES doctors(id) ON DELETE SET NULL,
  CONSTRAINT discount_rules_code_method_check CHECK ((method = 'code') = (code IS NOT NULL)),
  CONSTRAINT discount_rules_percent_check CHECK (kind <> 'percent' OR value <= 100),
  CONSTRAINT discount_rules_cap_check CHECK (max_discount IS NULL OR kind = 'percent'),
  CONSTRAINT discount_rules_age_order_check
    CHECK (min_age IS NULL OR max_age IS NULL OR min_age <= max_age),
  CONSTRAINT discount_rules_dates_check
    CHECK (valid_from IS NULL OR valid_to IS NULL OR valid_to >= valid_from)
);

CREATE UNIQUE INDEX IF NOT EXISTS discount_rules_code_key
  ON discount_rules (lower(code)) WHERE code IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS discount_rules_name_key
  ON discount_rules (lower(name));

CREATE INDEX IF NOT EXISTS discount_rules_active_idx
  ON discount_rules (priority) WHERE is_active;

ALTER TABLE discount_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE discount_rules FORCE ROW LEVEL SECURITY;
REVOKE ALL ON discount_rules FROM anon, authenticated;

CREATE OR REPLACE FUNCTION billing_codes_dont_clash() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'discount_rules' THEN
    IF NEW.code IS NOT NULL AND EXISTS (
      SELECT 1 FROM category_item_rates WHERE lower(bill_code) = lower(NEW.code)
    ) THEN
      RAISE EXCEPTION 'The discount code % is already a category bill code; choose another code', NEW.code
        USING ERRCODE = '23505';
    END IF;
  ELSIF NEW.bill_code IS NOT NULL AND EXISTS (
    SELECT 1 FROM discount_rules WHERE lower(code) = lower(NEW.bill_code)
  ) THEN
    RAISE EXCEPTION 'The bill code % is already a discount code; choose another code', NEW.bill_code
      USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS discount_rules_code_clash ON discount_rules;
CREATE TRIGGER discount_rules_code_clash
  BEFORE INSERT OR UPDATE OF code ON discount_rules
  FOR EACH ROW EXECUTE FUNCTION billing_codes_dont_clash();

DROP TRIGGER IF EXISTS category_item_rates_code_clash ON category_item_rates;
CREATE TRIGGER category_item_rates_code_clash
  BEFORE INSERT OR UPDATE OF bill_code ON category_item_rates
  FOR EACH ROW EXECUTE FUNCTION billing_codes_dont_clash();

CREATE OR REPLACE FUNCTION billing_discount_targets_exist() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  missing TEXT;
BEGIN
  SELECT string_agg(label, ', ') INTO missing FROM (
    SELECT 'group ' || v AS label FROM unnest(NEW.group_ids) AS v
     WHERE NOT EXISTS (SELECT 1 FROM service_groups WHERE id = v)
    UNION ALL
    SELECT 'subgroup ' || v FROM unnest(NEW.subgroup_ids) AS v
     WHERE NOT EXISTS (SELECT 1 FROM service_subgroups WHERE id = v)
    UNION ALL
    SELECT 'item ' || v FROM unnest(NEW.service_item_ids) AS v
     WHERE NOT EXISTS (SELECT 1 FROM service_items WHERE id = v)
    UNION ALL
    SELECT 'doctor ' || v FROM unnest(NEW.doctor_ids) AS v
     WHERE NOT EXISTS (SELECT 1 FROM doctors WHERE id = v)
    UNION ALL
    SELECT 'category ' || v FROM unnest(NEW.scheme_codes) AS v
     WHERE v <> 'general' AND NOT EXISTS (SELECT 1 FROM patient_schemes WHERE code = v)
  ) AS gone;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'The discount "%" points at something that does not exist: %', NEW.name, missing
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS discount_rules_targets_exist ON discount_rules;
CREATE TRIGGER discount_rules_targets_exist
  BEFORE INSERT OR UPDATE OF group_ids, subgroup_ids, service_item_ids, doctor_ids, scheme_codes
  ON discount_rules
  FOR EACH ROW EXECUTE FUNCTION billing_discount_targets_exist();
