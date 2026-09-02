-- ============================================================
-- Referrals — a human-quotable referral number.
-- 2026-09-02
--
-- docs/gini-flow/19-REFERRALS-STATION-PLAN.md, after a clinical review asked for
-- a referral ID on the letter.
--
-- WHY NOT THE UUID. Every referral already has a primary key, and it is
-- 2a9696e4-6689-4047-b2c6-0470ef8f0e46. Nobody reads that down a phone line, and
-- a receiving clinic that cannot quote the reference back cannot be traced
-- against. `ref_no` is a plain counter; the letter prints REF-<year>-<6 digits>,
-- which is short enough to say out loud and long enough not to collide.
--
-- The UUID stays the key. This is a label, not an identity — nothing joins on
-- it, so a gap in the sequence (a rolled-back insert) costs nothing.
--
--   node migrations/_runOne.mjs migrations/2026-09-02_giniflow_referral_ref_no.sql
-- ============================================================

ALTER TABLE giniflow_referrals
  ADD COLUMN IF NOT EXISTS ref_no BIGSERIAL;

COMMENT ON COLUMN giniflow_referrals.ref_no IS
  'Counter behind the printed REF-YYYY-NNNNNN. A label for humans; id remains the key.';
