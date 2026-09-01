-- ============================================================
-- Gini Flow — lab station: per-test status, and the claim the brief asks for.
-- 2026-09-01
--
-- Three gaps found reviewing 07-LAB-STATION-PLAN.md against the brief:
--
--   §5b.2  `amount_total` existed but was never written, so an order carried 0
--          while the screen showed the summed line prices. Backfilled here and
--          written at order time from now on.
--
--   §5b.3  Brief §2.2 gates the lab on "paid (or claim APPROVED)". The build
--          opened the gate the moment reception tapped Insurance claim — i.e. on
--          a claim nobody had approved. `insurance_claim` now means submitted;
--          `claim_approved` is the state that opens the gate.
--
--   §7     The prototype's detail pane shows a status per test, not per order.
--
--   node migrations/_runOne.mjs migrations/2026-09-01_giniflow_lab_detail.sql
-- ============================================================

-- Per-test state, for the detail pane's test rows.
ALTER TABLE giniflow_lab_order_tests
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'ordered';

-- Keep the order's recorded amount in step with the lines it was quoted from.
UPDATE giniflow_lab_orders o
   SET amount_total = COALESCE(
         (SELECT SUM(t.price) FROM giniflow_lab_order_tests t WHERE t.lab_order_id = o.id), 0)
 WHERE COALESCE(o.amount_total, 0) = 0;

-- An approved claim is not the same as a submitted one. Existing rows were
-- created under the old meaning, where tapping the button cleared the order, so
-- they are migrated to the approved state rather than silently re-blocking a
-- sample the lab may already have taken.
UPDATE giniflow_lab_orders
   SET payment_status = 'claim_approved'
 WHERE payment_status = 'insurance_claim';

COMMENT ON COLUMN giniflow_lab_orders.payment_status IS
  'pending | paid | insurance_claim (submitted, gate CLOSED) | claim_approved (gate open)';
