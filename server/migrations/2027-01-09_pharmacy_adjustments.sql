CREATE TABLE IF NOT EXISTS pharmacy_stock_adjustments (
  id            SERIAL PRIMARY KEY,
  location_id   INT NOT NULL REFERENCES pharmacy_locations(id),
  batch_id      INT NOT NULL REFERENCES pharmacy_batches(id),
  reason        TEXT NOT NULL CHECK (reason IN ('physical_count', 'damaged', 'expired', 'lost', 'entry_error')),
  note          TEXT NOT NULL CHECK (length(btrim(note)) >= 3),
  before_units  INT NOT NULL CHECK (before_units >= 0),
  after_units   INT NOT NULL CHECK (after_units >= 0),
  delta_units   INT NOT NULL CHECK (delta_units <> 0 AND delta_units = after_units - before_units),
  created_by    INT REFERENCES doctors(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pharmacy_stock_adjustments_writeoff_reduces
    CHECK (reason NOT IN ('damaged', 'expired', 'lost') OR delta_units < 0)
);

CREATE INDEX IF NOT EXISTS pharmacy_stock_adjustments_recent_idx
  ON pharmacy_stock_adjustments (location_id, created_at DESC);
CREATE INDEX IF NOT EXISTS pharmacy_stock_adjustments_batch_idx
  ON pharmacy_stock_adjustments (batch_id);
