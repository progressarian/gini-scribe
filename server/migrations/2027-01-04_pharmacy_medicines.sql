CREATE SEQUENCE IF NOT EXISTS pharmacy_medicine_code_seq;

CREATE TABLE IF NOT EXISTS pharmacy_medicines (
  id                 SERIAL PRIMARY KEY,
  code               TEXT NOT NULL DEFAULT ('MED' || lpad(nextval('pharmacy_medicine_code_seq')::text, 6, '0'))
                       CHECK (code ~ '^[A-Z0-9-]{2,30}$'),
  name               TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 200),
  generic_name       TEXT,
  manufacturer       TEXT,
  form               TEXT NOT NULL,
  strength           TEXT,
  pack_size          INT NOT NULL DEFAULT 1 CHECK (pack_size BETWEEN 1 AND 10000),
  unit_label         TEXT NOT NULL DEFAULT 'unit',
  pack_label         TEXT NOT NULL DEFAULT 'strip',
  hsn_code           TEXT CHECK (hsn_code IS NULL OR hsn_code ~ '^[0-9]{4,8}$'),
  gst_rate_pct       NUMERIC(5, 2) NOT NULL DEFAULT 5 CHECK (gst_rate_pct BETWEEN 0 AND 28),
  schedule           TEXT NOT NULL DEFAULT 'none'
                       CHECK (schedule IN ('none', 'H', 'H1', 'X', 'narcotic')),
  default_mrp        NUMERIC(12, 2) CHECK (default_mrp IS NULL OR default_mrp > 0),
  default_sale_rate  NUMERIC(12, 2) CHECK (default_sale_rate IS NULL OR default_sale_rate > 0),
  min_stock_units    INT NOT NULL DEFAULT 0 CHECK (min_stock_units >= 0),
  max_stock_units    INT CHECK (max_stock_units IS NULL OR max_stock_units > 0),
  reorder_qty_units  INT CHECK (reorder_qty_units IS NULL OR reorder_qty_units > 0),
  default_rack       TEXT,
  medicine_key       TEXT NOT NULL,
  allow_loose_sale   BOOLEAN NOT NULL DEFAULT TRUE,
  needs_review       BOOLEAN NOT NULL DEFAULT FALSE,
  is_active          BOOLEAN NOT NULL DEFAULT TRUE,
  version            INT NOT NULL DEFAULT 1,
  created_by         INT REFERENCES doctors(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by         INT REFERENCES doctors(id),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pharmacy_medicines_sale_within_mrp
    CHECK (default_sale_rate IS NULL OR default_mrp IS NULL OR default_sale_rate <= default_mrp),
  CONSTRAINT pharmacy_medicines_max_over_min
    CHECK (max_stock_units IS NULL OR max_stock_units >= min_stock_units)
);

CREATE UNIQUE INDEX IF NOT EXISTS pharmacy_medicines_code_key ON pharmacy_medicines (code);

CREATE UNIQUE INDEX IF NOT EXISTS pharmacy_medicines_name_key
  ON pharmacy_medicines (lower(btrim(name)));

CREATE INDEX IF NOT EXISTS pharmacy_medicines_key_idx ON pharmacy_medicines (medicine_key);

CREATE INDEX IF NOT EXISTS pharmacy_medicines_active_idx
  ON pharmacy_medicines (is_active, lower(name));

CREATE INDEX IF NOT EXISTS pharmacy_medicines_review_idx
  ON pharmacy_medicines (needs_review) WHERE needs_review;
