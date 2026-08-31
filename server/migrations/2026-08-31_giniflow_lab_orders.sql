-- ============================================================
-- Gini Flow — lab orders for the board's parallel Lab-track column.
-- 2026-08-31
--
-- The Flow Manager board shows a Lab track column (payment pending → processing
-- → awaiting upload) alongside the main chain. These tables are what it reads.
-- No station UI writes to them yet; the demo seeder populates them, and the lab
-- station build later needs no schema work.
--
-- ⚠️ NOT lab_requests (the HealthRay-facing route) and NOT lab_test_requests
-- (the existing Scribe table). Three unrelated things with confusable names —
-- do not merge them. These belong to the giniflow_* module alone.
--
-- The payment gate is a rule the lab station will enforce, not a constraint here:
-- a sample may not be collected until payment_status is 'paid' or
-- 'insurance_claim'.
--
--   node migrations/_runOne.mjs migrations/2026-08-31_giniflow_lab_orders.sql
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()

CREATE TABLE IF NOT EXISTS giniflow_lab_orders (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id        UUID NOT NULL REFERENCES giniflow_visits(id) ON DELETE CASCADE,
  ordered_by      INT  REFERENCES doctors(id),
  urgency         TEXT NOT NULL DEFAULT 'today',    -- today | tomorrow | next_visit
  payment_status  TEXT NOT NULL DEFAULT 'pending',  -- pending | paid | insurance_claim
  amount_total    NUMERIC(10,2) NOT NULL DEFAULT 0,
  sample_status   TEXT NOT NULL DEFAULT 'ordered',
  report_file_url TEXT,
  uploaded_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_giniflow_lab_orders_visit
  ON giniflow_lab_orders (visit_id);

CREATE TABLE IF NOT EXISTS giniflow_lab_order_tests (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lab_order_id UUID NOT NULL REFERENCES giniflow_lab_orders(id) ON DELETE CASCADE,
  test_name    TEXT NOT NULL,
  price        NUMERIC(10,2) NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_giniflow_lab_order_tests_order
  ON giniflow_lab_order_tests (lab_order_id);
