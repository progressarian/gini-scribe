-- ============================================================
-- Doctor qualification on the letterhead.
-- 2026-09-11
--
-- templates/prescriptionTemplate.js has read doctor.qualification since it was
-- written (the first of the two cred lines under the doctor's name), but no
-- query ever selected such a column because none existed: services build the
-- doctor block from doctors.specialty and doctors.license_no only. The degree
-- line has therefore printed blank on every prescription ever issued.
--
-- specialty is not a substitute. "Endocrinologist" is what the doctor does;
-- "MBBS, MD (Medicine)" is the registrable qualification a prescription is
-- expected to carry, and the two print as separate lines by design.
--
-- Nullable with no default and no backfill: a qualification is a claim about a
-- person's credentials, so it is typed in per doctor from Doctor Management
-- rather than guessed here. Until one is set the line keeps rendering blank,
-- exactly as it does today.
--
-- Idempotent.
-- ============================================================

ALTER TABLE doctors
  ADD COLUMN IF NOT EXISTS qualification TEXT;
