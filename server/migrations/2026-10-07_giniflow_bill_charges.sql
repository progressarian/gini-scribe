CREATE TABLE IF NOT EXISTS giniflow_bill_charges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id UUID NOT NULL REFERENCES giniflow_visits(id) ON DELETE CASCADE,
  item_name TEXT NOT NULL,
  amount NUMERIC(10, 2) NOT NULL DEFAULT 0,
  payment_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (payment_status IN ('pending', 'paid')),
  paid_by INTEGER REFERENCES doctors(id),
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (visit_id, item_name)
);

CREATE INDEX IF NOT EXISTS idx_giniflow_bill_charges_visit ON giniflow_bill_charges (visit_id);
