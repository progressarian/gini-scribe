-- ============================================================
-- Lab results typed at the lab station belong to an order.
-- 2026-09-10 · docs/gini-flow/32-LAB-TYPED-RESULTS-PLAN.md
--
-- The values themselves go where every lab number in this system already goes —
-- lab_results — so the doctor's Labs tab, the trends, the MO/SD chips and the
-- patient's app show them with no new screen anywhere. What is new is only the
-- link back: without it the station could write a result and never find it
-- again to correct a typo.
--
--   node migrations/_runOne.mjs migrations/2026-09-10_lab_results_order_link.sql
-- ============================================================

ALTER TABLE lab_results
  ADD COLUMN IF NOT EXISTS lab_order_id UUID REFERENCES giniflow_lab_orders(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_lab_results_order
  ON lab_results (lab_order_id) WHERE lab_order_id IS NOT NULL;
