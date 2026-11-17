CREATE SEQUENCE IF NOT EXISTS pharmacy_purchase_no_seq;

CREATE TABLE IF NOT EXISTS pharmacy_purchases (
  id               SERIAL PRIMARY KEY,
  receipt_no       TEXT NOT NULL DEFAULT ('GRN' || lpad(nextval('pharmacy_purchase_no_seq')::text, 6, '0')),
  kind             TEXT NOT NULL DEFAULT 'purchase' CHECK (kind IN ('purchase', 'opening')),
  vendor_id        INT REFERENCES pharmacy_vendors(id),
  invoice_no       TEXT,
  invoice_date     DATE,
  location_id      INT NOT NULL REFERENCES pharmacy_locations(id),
  status           TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted', 'cancelled')),
  notes            TEXT,
  taxable_amount   NUMERIC(14, 2) NOT NULL DEFAULT 0,
  gst_amount       NUMERIC(14, 2) NOT NULL DEFAULT 0,
  discount_amount  NUMERIC(14, 2) NOT NULL DEFAULT 0,
  net_amount       NUMERIC(14, 2) NOT NULL DEFAULT 0,
  version          INT NOT NULL DEFAULT 1,
  created_by       INT REFERENCES doctors(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by       INT REFERENCES doctors(id),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  posted_by        INT REFERENCES doctors(id),
  posted_at        TIMESTAMPTZ,
  cancelled_by     INT REFERENCES doctors(id),
  cancelled_at     TIMESTAMPTZ,
  cancel_reason    TEXT,
  CONSTRAINT pharmacy_purchases_vendor_needed
    CHECK (kind = 'opening' OR status <> 'posted'
           OR (vendor_id IS NOT NULL AND invoice_no IS NOT NULL AND invoice_date IS NOT NULL)),
  CONSTRAINT pharmacy_purchases_posted_stamp CHECK (status <> 'posted' OR posted_at IS NOT NULL),
  CONSTRAINT pharmacy_purchases_cancel_reason CHECK (status <> 'cancelled' OR cancel_reason IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS pharmacy_purchases_receipt_no_key ON pharmacy_purchases (receipt_no);

CREATE UNIQUE INDEX IF NOT EXISTS pharmacy_purchases_invoice_key
  ON pharmacy_purchases (vendor_id, lower(invoice_no))
  WHERE status <> 'cancelled' AND vendor_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS pharmacy_purchases_status_idx
  ON pharmacy_purchases (status, created_at DESC);

CREATE TABLE IF NOT EXISTS pharmacy_purchase_lines (
  id              SERIAL PRIMARY KEY,
  purchase_id     INT NOT NULL REFERENCES pharmacy_purchases(id) ON DELETE CASCADE,
  line_no         INT NOT NULL,
  medicine_id     INT NOT NULL REFERENCES pharmacy_medicines(id),
  batch_no        TEXT NOT NULL CHECK (batch_no ~ '^[A-Z0-9][A-Z0-9/._-]{0,29}$'),
  expiry_date     DATE NOT NULL,
  mfg_date        DATE CHECK (mfg_date IS NULL OR mfg_date < expiry_date),
  qty_packs       INT NOT NULL CHECK (qty_packs >= 0),
  free_packs      INT NOT NULL DEFAULT 0 CHECK (free_packs >= 0),
  purchase_rate   NUMERIC(12, 2) NOT NULL CHECK (purchase_rate >= 0),
  discount_pct    NUMERIC(5, 2) NOT NULL DEFAULT 0 CHECK (discount_pct BETWEEN 0 AND 100),
  gst_rate_pct    NUMERIC(5, 2) NOT NULL CHECK (gst_rate_pct BETWEEN 0 AND 28),
  mrp             NUMERIC(12, 2) NOT NULL CHECK (mrp > 0),
  sale_rate       NUMERIC(12, 2) NOT NULL CHECK (sale_rate > 0),
  rack_no         TEXT,
  taxable_amount  NUMERIC(14, 2) NOT NULL DEFAULT 0,
  discount_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
  gst_amount      NUMERIC(14, 2) NOT NULL DEFAULT 0,
  line_total      NUMERIC(14, 2) NOT NULL DEFAULT 0,
  batch_id        INT REFERENCES pharmacy_batches(id),
  CONSTRAINT pharmacy_purchase_lines_some_qty CHECK (qty_packs + free_packs > 0),
  CONSTRAINT pharmacy_purchase_lines_sale_within_mrp CHECK (sale_rate <= mrp),
  UNIQUE (purchase_id, line_no)
);

CREATE INDEX IF NOT EXISTS pharmacy_purchase_lines_purchase_idx
  ON pharmacy_purchase_lines (purchase_id);
CREATE INDEX IF NOT EXISTS pharmacy_purchase_lines_medicine_idx
  ON pharmacy_purchase_lines (medicine_id);
