CREATE TABLE IF NOT EXISTS service_item_aliases (
  id              SERIAL PRIMARY KEY,
  service_item_id INTEGER NOT NULL REFERENCES service_items(id) ON DELETE CASCADE,
  name            TEXT NOT NULL CHECK (name = btrim(name) AND name <> ''),
  flat_name       TEXT NOT NULL CHECK (flat_name ~ '^[a-z0-9]+$'),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by      INTEGER REFERENCES doctors(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS service_item_aliases_flat_name_key
  ON service_item_aliases (flat_name);

CREATE INDEX IF NOT EXISTS service_item_aliases_item_idx
  ON service_item_aliases (service_item_id);
