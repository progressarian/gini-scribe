-- ============================================================
-- Gini Flow — who the insurance claim is with, and who approved it.
-- 2026-09-07
--
-- payment_status 'insurance_claim' meant only "somebody at the desk pressed the
-- button". Nothing recorded WHICH insurer, under what policy, or what the claim
-- reference is, so a claim waiting for approval could not be chased — and
-- nothing stopped the same person from approving their own submission.
--
-- claim_approved_by is the checker half of maker-checker: the submitter is the
-- actor on the 'insurance_claim' event, the approver is here, and the service
-- refuses when they are the same person.
--
--   node migrations/_runOne.mjs migrations/2026-09-07_giniflow_claim_details.sql
-- ============================================================

ALTER TABLE giniflow_lab_orders
  ADD COLUMN IF NOT EXISTS insurer           TEXT,
  ADD COLUMN IF NOT EXISTS policy_no         TEXT,
  ADD COLUMN IF NOT EXISTS claim_no          TEXT,
  ADD COLUMN IF NOT EXISTS claim_approved_by INT REFERENCES doctors(id);
