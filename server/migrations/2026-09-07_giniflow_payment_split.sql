-- ============================================================
-- Gini Flow — a lab order paid partly in cash and partly by insurance.
-- 2026-09-07
--
-- payment_status was all-or-nothing: the desk took the whole amount in cash or
-- claimed the whole amount from an insurer. Real OPD policies have co-pay and
-- exclusions, so the ordinary case is "insurer covers ₹900, patient pays ₹350
-- now" — which reception could not record without either losing the hospital's
-- ₹350 or over-collecting from the patient.
--
-- The money is now the truth: amount_paid is cash in hand, amount_claimed is
-- what the insurer was asked for, and claim_state says whether that ask is
-- still a promise. payment_status is derived from the three by
-- shared/labPayment.js and kept in the column so every existing screen and SQL
-- filter reads exactly what it read before.
--
-- version is the optimistic lock. With amounts, "clearing twice" is no longer
-- caught by a status check — two taps of "collect ₹350" on a ₹1,250 order are
-- both legal and the patient pays ₹700. Every write carries the version it read.
--
--   node migrations/_runOne.mjs migrations/2026-09-07_giniflow_payment_split.sql
-- ============================================================

ALTER TABLE giniflow_lab_orders
  ADD COLUMN IF NOT EXISTS amount_paid    NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS amount_claimed NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS claim_state    TEXT NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS claim_note     TEXT,
  ADD COLUMN IF NOT EXISTS version        INT NOT NULL DEFAULT 0;

-- What the old status column already asserted, written into the money columns.
-- Only rows still at their defaults are touched, so re-running changes nothing.
UPDATE giniflow_lab_orders
   SET amount_paid = amount_total
 WHERE payment_status = 'paid'
   AND amount_paid = 0 AND amount_claimed = 0 AND claim_state = 'none';

UPDATE giniflow_lab_orders
   SET amount_claimed = amount_total,
       claim_state    = 'submitted'
 WHERE payment_status = 'insurance_claim'
   AND amount_paid = 0 AND amount_claimed = 0 AND claim_state = 'none';

UPDATE giniflow_lab_orders
   SET amount_claimed = amount_total,
       claim_state    = 'approved'
 WHERE payment_status = 'claim_approved'
   AND amount_paid = 0 AND amount_claimed = 0 AND claim_state = 'none';

-- Drift, not blanks: the older build wrote payment_status and knew nothing about
-- claim_state, so an order approved on the floor between this migration and the
-- new build's deploy reads as settled on top and unsettled underneath. Once the
-- status is derived from the money, that order would reappear on reception's
-- list as an unapproved claim. Re-run this file at deploy time — every statement
-- here only touches rows that actually disagree, so it is safe to repeat.
UPDATE giniflow_lab_orders
   SET claim_state = 'approved'
 WHERE payment_status = 'claim_approved' AND claim_state <> 'approved';

UPDATE giniflow_lab_orders
   SET amount_claimed = amount_total
 WHERE payment_status = 'claim_approved' AND amount_claimed = 0;

UPDATE giniflow_lab_orders
   SET amount_paid = amount_total
 WHERE payment_status = 'paid' AND amount_paid = 0 AND claim_state = 'none';

UPDATE giniflow_lab_orders
   SET claim_state = 'submitted', amount_claimed = amount_total
 WHERE payment_status = 'insurance_claim' AND claim_state = 'none' AND amount_claimed = 0;

-- The invariant every write has to keep: an order can never be collected for
-- more than it is worth, and neither half of the split can go negative. A
-- REJECTED claim is not money any more — the desk collects that part in cash
-- instead — so it stops counting against the total while staying on the record.
ALTER TABLE giniflow_lab_orders
  DROP CONSTRAINT IF EXISTS giniflow_lab_orders_amounts_within_total;
ALTER TABLE giniflow_lab_orders
  ADD CONSTRAINT giniflow_lab_orders_amounts_within_total
  CHECK (
    amount_paid >= 0 AND amount_claimed >= 0
    AND amount_paid + (CASE WHEN claim_state = 'rejected' THEN 0 ELSE amount_claimed END)
        <= amount_total
  );

ALTER TABLE giniflow_lab_orders
  DROP CONSTRAINT IF EXISTS giniflow_lab_orders_claim_state;
ALTER TABLE giniflow_lab_orders
  ADD CONSTRAINT giniflow_lab_orders_claim_state
  CHECK (claim_state IN ('none', 'submitted', 'approved', 'rejected'));
