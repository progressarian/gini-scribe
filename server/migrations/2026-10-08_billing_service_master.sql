CREATE TABLE IF NOT EXISTS service_groups (
  id          SERIAL PRIMARY KEY,
  code        TEXT NOT NULL CHECK (code ~ '^\S+$'),
  name        TEXT NOT NULL CHECK (btrim(name) <> ''),
  sort_order  INT NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by  INT REFERENCES doctors(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by  INT REFERENCES doctors(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS service_groups_code_key ON service_groups (lower(code));

CREATE TABLE IF NOT EXISTS service_subgroups (
  id          SERIAL PRIMARY KEY,
  group_id    INT NOT NULL REFERENCES service_groups(id) ON DELETE RESTRICT,
  code        TEXT NOT NULL CHECK (code ~ '^\S+$'),
  name        TEXT NOT NULL CHECK (btrim(name) <> ''),
  sort_order  INT NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by  INT REFERENCES doctors(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by  INT REFERENCES doctors(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS service_subgroups_code_key ON service_subgroups (lower(code));
CREATE INDEX IF NOT EXISTS service_subgroups_group_id_idx ON service_subgroups (group_id);

ALTER TABLE service_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_groups FORCE ROW LEVEL SECURITY;
REVOKE ALL ON service_groups FROM anon, authenticated;

ALTER TABLE service_subgroups ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_subgroups FORCE ROW LEVEL SECURITY;
REVOKE ALL ON service_subgroups FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS tax_codes (
  id          SERIAL PRIMARY KEY,
  code        TEXT NOT NULL CHECK (code ~ '^\S+$'),
  sac_hsn     TEXT CHECK (sac_hsn ~ '^([0-9]{4}|[0-9]{6}|[0-9]{8})$'),
  rate_pct    NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (rate_pct >= 0 AND rate_pct <= 100),
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by  INT REFERENCES doctors(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by  INT REFERENCES doctors(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS tax_codes_code_key ON tax_codes (lower(code));

ALTER TABLE tax_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_codes FORCE ROW LEVEL SECURITY;
REVOKE ALL ON tax_codes FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS service_items (
  id                  SERIAL PRIMARY KEY,
  code                TEXT NOT NULL CHECK (code ~ '^\S+$'),
  name                TEXT NOT NULL CHECK (btrim(name) <> ''),
  subgroup_id         INT NOT NULL REFERENCES service_subgroups(id) ON DELETE RESTRICT,
  base_price          NUMERIC(12,2) NOT NULL CHECK (base_price >= 0),
  unit                TEXT NOT NULL DEFAULT 'each' CHECK (btrim(unit) <> ''),
  allow_quantity      BOOLEAN NOT NULL DEFAULT FALSE,
  max_quantity        INT CHECK (max_quantity >= 1),
  tax_code_id         INT REFERENCES tax_codes(id) ON DELETE RESTRICT,
  price_includes_tax  BOOLEAN NOT NULL DEFAULT FALSE,
  kind                TEXT NOT NULL CHECK (kind IN ('consultation', 'test', 'procedure', 'medicine', 'other')),
  doctor_id           INT REFERENCES doctors(id) ON DELETE RESTRICT,
  visit_type          TEXT CHECK (visit_type IN ('New', 'Follow Up')),
  test_catalog_id     UUID REFERENCES giniflow_test_catalog(id) ON DELETE RESTRICT,
  is_active           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by          INT REFERENCES doctors(id) ON DELETE SET NULL,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by          INT REFERENCES doctors(id) ON DELETE SET NULL,
  CONSTRAINT service_items_quantity_check
    CHECK (allow_quantity OR max_quantity IS NULL),
  CONSTRAINT service_items_consultation_check
    CHECK (CASE WHEN kind = 'consultation'
                THEN visit_type IS NOT NULL
                ELSE doctor_id IS NULL AND visit_type IS NULL END),
  CONSTRAINT service_items_test_check
    CHECK ((kind = 'test') = (test_catalog_id IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS service_items_code_key ON service_items (lower(code));
CREATE UNIQUE INDEX IF NOT EXISTS service_items_consultation_key
  ON service_items (doctor_id, visit_type) NULLS NOT DISTINCT
  WHERE kind = 'consultation' AND is_active;
CREATE UNIQUE INDEX IF NOT EXISTS service_items_test_catalog_key
  ON service_items (test_catalog_id) WHERE test_catalog_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS service_items_subgroup_id_idx ON service_items (subgroup_id);
CREATE INDEX IF NOT EXISTS service_items_tax_code_id_idx ON service_items (tax_code_id);

CREATE TABLE IF NOT EXISTS service_item_price_history (
  id               BIGSERIAL PRIMARY KEY,
  service_item_id  INT NOT NULL REFERENCES service_items(id) ON DELETE CASCADE,
  old_price        NUMERIC(12,2) CHECK (old_price >= 0),
  new_price        NUMERIC(12,2) NOT NULL CHECK (new_price >= 0),
  reason           TEXT NOT NULL CHECK (btrim(reason) <> ''),
  changed_by       INT REFERENCES doctors(id) ON DELETE SET NULL,
  changed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS service_item_price_history_item_idx
  ON service_item_price_history (service_item_id, changed_at DESC);

ALTER TABLE service_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_items FORCE ROW LEVEL SECURITY;
REVOKE ALL ON service_items FROM anon, authenticated;

ALTER TABLE service_item_price_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_item_price_history FORCE ROW LEVEL SECURITY;
REVOKE ALL ON service_item_price_history FROM anon, authenticated;
