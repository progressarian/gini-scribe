-- Allergies on the patient, where they belong — addendum v1.1 §4,
-- docs/gini-flow/24-ADDENDUM-V11-PLAN.md §5.1.
--
-- Three states, not a nullable list. The referral form (giniflow_referrals)
-- already models it this way and its reasoning is the right one: "not asked" is
-- a clinical state, not an absent value, and the difference between it and
-- "none known" is the difference between a specialist checking before
-- prescribing and not.
--
-- The addendum asks for `allergies text[]`. This uses the vocabulary already in
-- the codebase instead, so the referral letter and the patient header cannot
-- describe the same patient differently.
ALTER TABLE patients
  ADD COLUMN IF NOT EXISTS allergy_status TEXT,
  ADD COLUMN IF NOT EXISTS allergy_note   TEXT,
  ADD COLUMN IF NOT EXISTS allergy_asked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS allergy_asked_by INT REFERENCES doctors(id);

DO $$
BEGIN
  ALTER TABLE patients
    ADD CONSTRAINT patients_allergy_status_check
    CHECK (allergy_status IN ('not_known', 'none_known', 'known'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- NULL means nobody has ever been asked — the same thing 'not_known' says, but
-- reached by never having opened the question rather than by answering it.
-- Both must read as "not asked" on every screen; neither may read as "none".
