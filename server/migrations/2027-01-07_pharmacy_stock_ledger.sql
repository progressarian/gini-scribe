CREATE TABLE IF NOT EXISTS pharmacy_batches (
  id             SERIAL PRIMARY KEY,
  medicine_id    INT NOT NULL REFERENCES pharmacy_medicines(id),
  batch_no       TEXT NOT NULL CHECK (batch_no ~ '^[A-Z0-9][A-Z0-9/._-]{0,29}$'),
  expiry_date    DATE NOT NULL,
  mfg_date       DATE CHECK (mfg_date IS NULL OR mfg_date < expiry_date),
  pack_size      INT NOT NULL CHECK (pack_size BETWEEN 1 AND 10000),
  mrp            NUMERIC(12, 2) NOT NULL CHECK (mrp > 0),
  sale_rate      NUMERIC(12, 2) NOT NULL CHECK (sale_rate > 0),
  purchase_rate  NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (purchase_rate >= 0),
  gst_rate_pct   NUMERIC(5, 2) NOT NULL CHECK (gst_rate_pct BETWEEN 0 AND 28),
  rack_no        TEXT,
  vendor_id      INT REFERENCES pharmacy_vendors(id),
  created_by     INT REFERENCES doctors(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pharmacy_batches_sale_within_mrp CHECK (sale_rate <= mrp)
);

CREATE UNIQUE INDEX IF NOT EXISTS pharmacy_batches_key
  ON pharmacy_batches (medicine_id, batch_no, expiry_date);

CREATE INDEX IF NOT EXISTS pharmacy_batches_expiry_idx ON pharmacy_batches (expiry_date);

CREATE TABLE IF NOT EXISTS pharmacy_stock (
  location_id  INT NOT NULL REFERENCES pharmacy_locations(id),
  batch_id     INT NOT NULL REFERENCES pharmacy_batches(id),
  qty_units    INT NOT NULL DEFAULT 0 CONSTRAINT pharmacy_stock_not_negative CHECK (qty_units >= 0),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (location_id, batch_id)
);

CREATE INDEX IF NOT EXISTS pharmacy_stock_batch_idx ON pharmacy_stock (batch_id);

CREATE TABLE IF NOT EXISTS pharmacy_stock_movements (
  id             BIGSERIAL PRIMARY KEY,
  location_id    INT NOT NULL REFERENCES pharmacy_locations(id),
  batch_id       INT NOT NULL REFERENCES pharmacy_batches(id),
  medicine_id    INT NOT NULL REFERENCES pharmacy_medicines(id),
  kind           TEXT NOT NULL CHECK (kind IN (
                   'opening', 'purchase', 'sale', 'sale_return', 'transfer_out', 'transfer_in',
                   'indent_issue', 'indent_return', 'adjustment', 'expiry_writeoff', 'vendor_return')),
  delta_units    INT NOT NULL CHECK (delta_units <> 0),
  balance_after  INT NOT NULL CHECK (balance_after >= 0),
  ref_type       TEXT,
  ref_id         TEXT,
  reason         TEXT,
  actor_id       INT REFERENCES doctors(id),
  at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pharmacy_stock_movements_direction CHECK (
    (kind IN ('opening', 'purchase', 'sale_return', 'transfer_in', 'indent_return') AND delta_units > 0)
    OR (kind IN ('sale', 'transfer_out', 'indent_issue', 'expiry_writeoff', 'vendor_return') AND delta_units < 0)
    OR kind = 'adjustment'
  )
);

CREATE INDEX IF NOT EXISTS pharmacy_stock_movements_batch_idx
  ON pharmacy_stock_movements (batch_id, location_id, at);
CREATE INDEX IF NOT EXISTS pharmacy_stock_movements_medicine_idx
  ON pharmacy_stock_movements (medicine_id, at);
CREATE INDEX IF NOT EXISTS pharmacy_stock_movements_ref_idx
  ON pharmacy_stock_movements (ref_type, ref_id);

CREATE OR REPLACE FUNCTION pharmacy_stock_movements_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'pharmacy_stock_movements is append-only: record a correcting movement instead'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE OR REPLACE TRIGGER pharmacy_stock_movements_append_only
  BEFORE UPDATE OR DELETE ON pharmacy_stock_movements
  FOR EACH ROW EXECUTE FUNCTION pharmacy_stock_movements_append_only();
