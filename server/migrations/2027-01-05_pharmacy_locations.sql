CREATE TABLE IF NOT EXISTS pharmacy_locations (
  id          SERIAL PRIMARY KEY,
  code        TEXT NOT NULL CHECK (code ~ '^[A-Z0-9-]{2,20}$'),
  name        TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 120),
  kind        TEXT NOT NULL DEFAULT 'department' CHECK (kind IN ('main', 'department')),
  notes       TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  version     INT NOT NULL DEFAULT 1,
  created_by  INT REFERENCES doctors(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by  INT REFERENCES doctors(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pharmacy_locations_main_active CHECK (kind <> 'main' OR is_active)
);

CREATE UNIQUE INDEX IF NOT EXISTS pharmacy_locations_code_key ON pharmacy_locations (code);

CREATE UNIQUE INDEX IF NOT EXISTS pharmacy_locations_name_key
  ON pharmacy_locations (lower(btrim(name)));

CREATE UNIQUE INDEX IF NOT EXISTS pharmacy_locations_one_main
  ON pharmacy_locations (kind) WHERE kind = 'main';

INSERT INTO pharmacy_locations (code, name, kind)
VALUES ('MAIN', 'Main pharmacy', 'main')
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS pharmacy_location_levels (
  location_id  INT NOT NULL REFERENCES pharmacy_locations(id),
  medicine_id  INT NOT NULL REFERENCES pharmacy_medicines(id),
  min_units    INT NOT NULL DEFAULT 0 CHECK (min_units >= 0),
  max_units    INT CHECK (max_units IS NULL OR max_units > 0),
  updated_by   INT REFERENCES doctors(id),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (location_id, medicine_id),
  CONSTRAINT pharmacy_location_levels_max_over_min
    CHECK (max_units IS NULL OR max_units >= min_units)
);

CREATE INDEX IF NOT EXISTS pharmacy_location_levels_medicine_idx
  ON pharmacy_location_levels (medicine_id);
