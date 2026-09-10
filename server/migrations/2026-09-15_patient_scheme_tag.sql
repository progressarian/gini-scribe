-- ============================================================
-- The scheme tag moves onto the patient (33-PATIENT-SCHEME-PLAN.md step 2).
-- 2026-09-15
--
-- A CGHS or ECHS entitlement is a card the PERSON holds, not a property of one
-- appointment. Today the only place it can be set is the GHM sheet's dropdown,
-- which covers the OBT day list and nothing else: a walk-in is never tagged,
-- and a patient who IS tagged has to be re-tagged by hand at every visit. That
-- is a large part of why the tag has never been used — 0 of 7,413 appointments
-- in the 60 days to 2026-09-13.
--
-- So the master lives here and falls onto each appointment.
--
-- THE INHERITANCE RULE: an appointment's scheme is its own explicit value if
-- set, otherwise the patient's scheme SNAPSHOTTED AT APPOINTMENT CREATION.
-- Never a live join. A card that lapses in March must not silently rewrite
-- February's counts, and the daily cap is counted off those appointment rows.
--
-- scheme_ref is the card / beneficiary number. Encrypted at rest with the same
-- helper Aadhaar uses (server/utils/aadhaarCrypt.js) because it is a government
-- identifier under the same DPDP obligations — see plan §2. No validity date:
-- a wrong expiry is worse than none (plan D5).
--
-- Idempotent.
-- ============================================================

ALTER TABLE patients
  ADD COLUMN IF NOT EXISTS scheme_code TEXT REFERENCES patient_schemes(code),
  ADD COLUMN IF NOT EXISTS scheme_ref  TEXT;

-- "Which of our patients are ECHS" is the question the desk and the cap both
-- ask; the tagged set is small, so a partial index is the right shape.
CREATE INDEX IF NOT EXISTS idx_patients_scheme
  ON patients (scheme_code) WHERE scheme_code IS NOT NULL;

-- The appointment's tag has been TEXT since 2026-08-21 with no foreign key, and
-- it stays that way on purpose: rows carry codes for schemes that may later be
-- retired, and a FK would either block the retirement or rewrite history.
-- Validation happens at the write, in isKnownScheme().
