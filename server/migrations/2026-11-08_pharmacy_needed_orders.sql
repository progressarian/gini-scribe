CREATE TABLE IF NOT EXISTS pharmacy_needed_orders (
  medicine_key  TEXT PRIMARY KEY CHECK (medicine_key ~ '\S'),
  medicine_name TEXT NOT NULL,
  note          TEXT,
  ordered_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ordered_by    INT REFERENCES doctors(id) ON DELETE SET NULL
);

ALTER TABLE pharmacy_needed_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE pharmacy_needed_orders FORCE ROW LEVEL SECURITY;
REVOKE ALL ON pharmacy_needed_orders FROM anon, authenticated;
