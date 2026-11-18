CREATE TABLE IF NOT EXISTS pharmacy_bill_rx_outcomes (
  bill_id      UUID NOT NULL REFERENCES pharmacy_bills(id) ON DELETE CASCADE,
  rx_item_id   UUID NOT NULL REFERENCES giniflow_rx_items(id) ON DELETE CASCADE,
  outcome      TEXT NOT NULL CHECK (outcome IN ('given', 'substitute', 'not_given', 'requested')),
  medicine_id  INT REFERENCES pharmacy_medicines(id) ON DELETE SET NULL,
  reason       TEXT CHECK (reason IS NULL OR reason ~ '^[a-z_]{2,40}$'),
  decided_by   INT REFERENCES doctors(id) ON DELETE SET NULL,
  decided_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (bill_id, rx_item_id),
  CONSTRAINT pharmacy_bill_rx_outcomes_reason
    CHECK (outcome IN ('given', 'substitute') OR reason IS NOT NULL),
  CONSTRAINT pharmacy_bill_rx_outcomes_substitute
    CHECK (outcome <> 'substitute' OR medicine_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS pharmacy_bill_rx_outcomes_rx_item
  ON pharmacy_bill_rx_outcomes (rx_item_id);

ALTER TABLE pharmacy_bill_rx_outcomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE pharmacy_bill_rx_outcomes FORCE ROW LEVEL SECURITY;
REVOKE ALL ON pharmacy_bill_rx_outcomes FROM anon, authenticated;
