-- ============================================================
-- Gini Flow — remember where a blocked patient was standing.
-- 2026-08-31
--
-- `blocked_reports` is recoverable: the patient unblocks back into the chain.
-- Without recording the status they held when they were blocked, recovery could
-- re-enter anywhere, including behind where they already were — and every
-- duration derived from the log would then misreport (audit GF-15).
--
--   node migrations/_runOne.mjs migrations/2026-08-31_giniflow_resume_status.sql
-- ============================================================

ALTER TABLE giniflow_visits ADD COLUMN IF NOT EXISTS resume_status TEXT;
