-- Patient identity keyed on health_id, not the reusable HealthRay UHID.
--
-- BACKGROUND (P_180848 incident): HealthRay's patient_case_id (our file_no) is a
-- UHID that HealthRay reuses/reassigns to a DIFFERENT person over time. Our
-- upsertPatient matched patients by file_no only and never updated an existing
-- row, so when P_180848 was reassigned from "Meenu Gupta" to "Rattan Singh",
-- Rattan's completed visit was silently attached to Meenu's chart and her name
-- stayed frozen. 102 file numbers already have appointments with conflicting sex
-- (two people on one record), 1356 with differing names.
--
-- FIX: person identity = family_member.healthray_id (our patients.health_id),
-- which is stable per person. file_no becomes "the UHID this person currently
-- holds" and is no longer unique on the patient row. Each appointment records
-- the family_member id that owned that specific visit.
--
--   node migrations/_runOne.mjs migrations/2026-07-14_patient_identity_health_id.sql
--
-- SAFETY: verified zero duplicate health_ids and zero duplicate file_nos in
-- production before writing this, so the unique index below builds cleanly.
-- If a future run hits a duplicate health_id, resolve it with
-- scripts/split-reassigned-uhids.mjs first.
--
-- file_no STAYS unique among current owners (prod already enforces this via the
-- partial-unique idx_patients_file plus the full-unique patients_file_no_unique,
-- which sheetsSync's ON CONFLICT (file_no) depends on). We do NOT drop that:
-- the reassignment model instead nulls the previous owner's file_no BEFORE the
-- new owner claims it (upsertPatient / split-reassigned-uhids.mjs), so there is
-- one live owner per UHID and any number of former owners at NULL. This line
-- just removes a redundant legacy constraint if it happens to exist.
ALTER TABLE patients DROP CONSTRAINT IF EXISTS patients_file_no_key;

-- 2) Person identity: family_member.healthray_id. Partial unique index because
--    health_id is NULL for legacy / sheet / Genie / manual patients.
CREATE INDEX IF NOT EXISTS idx_patients_health_id ON patients(health_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_patients_health_id_uniq
  ON patients(health_id) WHERE health_id IS NOT NULL;

-- 3) Record which family member owned each individual appointment, so future
--    audits/backfills can group encounters by person without re-calling HealthRay.
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS family_member_id TEXT;
CREATE INDEX IF NOT EXISTS idx_appointments_family_member
  ON appointments(family_member_id);
