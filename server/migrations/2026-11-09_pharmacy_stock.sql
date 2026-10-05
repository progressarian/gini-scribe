CREATE TABLE IF NOT EXISTS pharmacy_stock_uploads (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_name           TEXT NOT NULL,
  store_name          TEXT,
  generated_by        TEXT,
  report_generated_at TIMESTAMPTZ,
  status              TEXT NOT NULL DEFAULT 'preview'
                        CHECK (status IN ('preview', 'committed', 'discarded')),
  uploaded_by         INT REFERENCES doctors(id),
  uploaded_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  committed_by        INT REFERENCES doctors(id),
  committed_at        TIMESTAMPTZ,
  item_count          INT NOT NULL DEFAULT 0,
  total_units         NUMERIC(14, 2) NOT NULL DEFAULT 0,
  purchase_total      NUMERIC(14, 2) NOT NULL DEFAULT 0,
  landing_total       NUMERIC(14, 2) NOT NULL DEFAULT 0,
  sale_total          NUMERIC(14, 2) NOT NULL DEFAULT 0,
  warnings            JSONB NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS idx_pharmacy_stock_uploads_status
  ON pharmacy_stock_uploads (status, uploaded_at DESC);

CREATE TABLE IF NOT EXISTS pharmacy_stock_upload_lines (
  id              BIGSERIAL PRIMARY KEY,
  upload_id       UUID NOT NULL REFERENCES pharmacy_stock_uploads(id) ON DELETE CASCADE,
  row_no          INT NOT NULL,
  item_key        TEXT NOT NULL,
  item_name       TEXT NOT NULL,
  qty             NUMERIC(12, 2) NOT NULL,
  company         TEXT,
  generic_name    TEXT,
  category        TEXT,
  item_type       TEXT,
  purchase_total  NUMERIC(14, 2),
  landing_total   NUMERIC(14, 2),
  sale_total      NUMERIC(14, 2),
  warnings        TEXT[] NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_pharmacy_stock_upload_lines_upload
  ON pharmacy_stock_upload_lines (upload_id, item_key);

CREATE TABLE IF NOT EXISTS pharmacy_stock_items (
  item_key         TEXT PRIMARY KEY,
  item_name        TEXT NOT NULL,
  qty              NUMERIC(12, 2) NOT NULL DEFAULT 0,
  company          TEXT,
  generic_name     TEXT,
  category         TEXT,
  item_type        TEXT,
  purchase_total   NUMERIC(14, 2),
  landing_total    NUMERIC(14, 2),
  sale_total       NUMERIC(14, 2),
  unit_sale_price  NUMERIC(12, 2),
  in_latest        BOOLEAN NOT NULL DEFAULT TRUE,
  last_upload_id   UUID REFERENCES pharmacy_stock_uploads(id),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pharmacy_stock_links (
  item_key      TEXT NOT NULL REFERENCES pharmacy_stock_items(item_key) ON DELETE CASCADE,
  medicine_key  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'auto' CHECK (status IN ('identity', 'auto', 'confirmed')),
  created_by    INT REFERENCES doctors(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (item_key, medicine_key)
);

CREATE INDEX IF NOT EXISTS idx_pharmacy_stock_links_medicine
  ON pharmacy_stock_links (medicine_key);
