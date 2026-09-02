-- ============================================================
-- Referrals — structure the letter, and capture allergies.
-- 2026-09-02
--
-- docs/gini-flow/19-REFERRALS-STATION-PLAN.md, revised after a clinical review
-- of a real generated letter.
--
-- WHY. One `reason` textarea was doing four jobs — presenting complaint,
-- history, clinical question, requested action — so a referral came out as a
-- wall of prose with no shape to violate. That is also how 900 characters of
-- unrelated text were pasted into a letter and nobody noticed. Three narrower
-- prompts are easier to answer than one wide one, and give the letter the
-- sections a receiving consultant scans for.
--
-- ALLERGIES is the clinical-safety addition. There is no allergy field anywhere
-- in this database, so the letter could only ever say "not recorded" — for every
-- patient, forever. The referral is the right moment to ask, because it is the
-- moment somebody else is about to prescribe.
--
-- `allergy_status` is NOT nullable-with-a-blank-default on purpose. A blank
-- allergy field on a clinical document is ambiguous: it reads as "none" to the
-- person receiving it. Three explicit values mean "nobody asked" is a stated
-- position rather than an empty box, and "none known" reaches a specialist only
-- because a human actually said so.
--
--   node migrations/_runOne.mjs migrations/2026-09-02_giniflow_referral_structure.sql
-- ============================================================

ALTER TABLE giniflow_referrals
  ADD COLUMN IF NOT EXISTS presenting_complaint TEXT,
  ADD COLUMN IF NOT EXISTS requested_action     TEXT,
  ADD COLUMN IF NOT EXISTS allergy_status       TEXT NOT NULL DEFAULT 'not_known',
  ADD COLUMN IF NOT EXISTS allergy_note         TEXT;

COMMENT ON COLUMN giniflow_referrals.presenting_complaint IS
  'What is happening now, in the referrer''s words. Rendered above the reason.';
COMMENT ON COLUMN giniflow_referrals.requested_action IS
  'What the referrer is asking the specialist to DO — the expected outcome.';
COMMENT ON COLUMN giniflow_referrals.allergy_status IS
  'none_known | not_known | known. Never blank: an empty allergy field reads as "none" on a letter.';
COMMENT ON COLUMN giniflow_referrals.allergy_note IS
  'The allergy itself, when allergy_status = known. e.g. "Penicillin — rash".';
