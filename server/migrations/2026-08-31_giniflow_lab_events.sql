-- ============================================================
-- Gini Flow — append-only log for the parallel lab track.
-- 2026-08-31
--
-- giniflow_lab_orders carries only the CURRENT sample_status and payment_status.
-- The main chain learned this lesson already: without a timestamped log there is
-- no way to answer "how long did payment take" or "when did the sample sit", and
-- the 45-minute lab_total budget and the 10-minute reception_payment budget both
-- have nothing to measure (audit GF-12, GF-07).
--
-- Cheap to add now, expensive once the lab and reception screens are writing.
--
--   node migrations/_runOne.mjs migrations/2026-08-31_giniflow_lab_events.sql
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS giniflow_lab_order_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lab_order_id UUID NOT NULL REFERENCES giniflow_lab_orders(id) ON DELETE CASCADE,
  track        TEXT NOT NULL,   -- 'sample' | 'payment'
  status       TEXT NOT NULL,
  actor_role   TEXT NOT NULL DEFAULT 'system',
  actor_id     INT  REFERENCES doctors(id),
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  meta         JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_giniflow_lab_events_order
  ON giniflow_lab_order_events (lab_order_id, occurred_at);
