-- ============================================================
-- Doctors without a mobile number: skeleton records
-- 2026-10-04
--
--   node migrations/_runOne.mjs migrations/2026-10-04_crm_doctor_skeleton_records.sql
--
-- The brief calls mobile "the canonical unique identity" for a doctor, so
-- 2026-09-16_crm_phase1.sql made it NOT NULL. The first real list contradicts
-- that: Virender's universe is transcribed from handwritten notes and has no
-- phone numbers at all. A schema that cannot hold those doctors is a schema
-- that turns the actual starting data away.
--
-- Mobile stays the identity *when present* — the uniqueness rule is unchanged
-- and still absolute for any doctor who has one. What changes is that a doctor
-- may exist before anyone has their number, carrying a flag that makes
-- "who is still missing a mobile?" a query rather than a spreadsheet.
--
-- Idempotent.
-- ============================================================

-- 1. A doctor may now exist without a number.
ALTER TABLE crm.doctors ALTER COLUMN mobile DROP NOT NULL;

-- A *present* number must still normalise. Postgres CHECKs pass on NULL, so
-- the original constraint already tolerated a null; it is replaced anyway so
-- the intent is written down rather than inferred from three-valued logic.
ALTER TABLE crm.doctors DROP CONSTRAINT IF EXISTS doctors_mobile_valid;
ALTER TABLE crm.doctors ADD CONSTRAINT doctors_mobile_valid
  CHECK (mobile IS NULL OR crm.normalize_phone(mobile) IS NOT NULL);

-- 2. Uniqueness only where there is something to be unique about.
--
-- Postgres already treats NULLs as distinct in a unique index, so many
-- number-less doctors would have coexisted regardless. Saying it explicitly
-- means a later `NULLS NOT DISTINCT` cannot silently collapse every skeleton
-- record onto one row.
DROP INDEX IF EXISTS crm.doctors_mobile_uniq;
CREATE UNIQUE INDEX IF NOT EXISTS doctors_mobile_uniq
  ON crm.doctors (hospital_id, mobile_e164)
  WHERE deleted_at IS NULL AND mobile_e164 IS NOT NULL;

-- 3. Completeness, as a queryable property rather than a convention.
--
-- Generated, so it cannot drift from the data it describes: there is no code
-- path that can set profile_complete true on a doctor with no number.
--
-- Computed from `mobile` through the normaliser rather than from mobile_e164,
-- because a generated column may not reference another generated column.
-- crm.normalize_phone is IMMUTABLE, so the two always agree.
ALTER TABLE crm.doctors
  ADD COLUMN IF NOT EXISTS profile_complete boolean
    GENERATED ALWAYS AS (crm.normalize_phone(mobile) IS NOT NULL) STORED;

-- What a rep would have to go and find out. Ordered by how much it blocks the
-- relationship: you cannot call a doctor at all without a number.
ALTER TABLE crm.doctors
  ADD COLUMN IF NOT EXISTS missing_fields text[]
    GENERATED ALWAYS AS (
      array_remove(ARRAY[
        CASE WHEN crm.normalize_phone(mobile) IS NULL THEN 'mobile' END,
        CASE WHEN nullif(btrim(coalesce(specialty, '')), '') IS NULL THEN 'specialty' END,
        CASE WHEN nullif(btrim(coalesce(clinic_name, '')), '') IS NULL THEN 'clinic' END,
        CASE WHEN nullif(btrim(coalesce(area, '')), '') IS NULL THEN 'area' END
      ], NULL)
    ) STORED;

-- 4. Transcription confidence travels with the record.
--
-- A row the transcriber marked "check" is not an error — the doctor is real
-- and the rep should visit them — but the spelling or the area may be wrong,
-- and whoever opens the record deserves to know that before they act on it.
ALTER TABLE crm.doctors
  ADD COLUMN IF NOT EXISTS needs_verification boolean NOT NULL DEFAULT false;
ALTER TABLE crm.doctors
  ADD COLUMN IF NOT EXISTS verification_note text;

-- 5. Provenance. Which file did this doctor come from, and which row.
ALTER TABLE crm.doctors
  ADD COLUMN IF NOT EXISTS import_batch_id uuid REFERENCES crm.import_batches(id);

CREATE INDEX IF NOT EXISTS doctors_incomplete_idx
  ON crm.doctors (hospital_id) WHERE deleted_at IS NULL AND NOT profile_complete;
CREATE INDEX IF NOT EXISTS doctors_needs_verification_idx
  ON crm.doctors (hospital_id) WHERE deleted_at IS NULL AND needs_verification;
CREATE INDEX IF NOT EXISTS doctors_import_batch_idx
  ON crm.doctors (import_batch_id) WHERE import_batch_id IS NOT NULL;

COMMENT ON COLUMN crm.doctors.profile_complete IS
  'Generated: the doctor has a usable mobile number. False means a rep cannot '
  'contact them yet — see crm.v_doctors_needing_details.';
COMMENT ON COLUMN crm.doctors.needs_verification IS
  'The source record was uncertain (a handwritten note the transcriber marked '
  '"check"). The doctor is real; a detail may be wrong.';

-- 6. The rep task list the flag exists to produce.
CREATE OR REPLACE VIEW crm.v_doctors_needing_details
  WITH (security_invoker = true) AS
SELECT d.id AS doctor_id,
       d.hospital_id,
       d.full_name,
       d.specialty,
       d.area,
       d.city,
       d.priority,
       d.needs_verification,
       d.verification_note,
       d.missing_fields,
       cardinality(d.missing_fields) AS missing_count,
       a.executive_id,
       t.name AS territory_name
FROM crm.doctors d
LEFT JOIN crm.doctor_assignments a
       ON a.doctor_id = d.id AND a.effective_to IS NULL
LEFT JOIN crm.territories t ON t.id = d.territory_id
WHERE d.deleted_at IS NULL
  AND d.is_active
  AND (NOT d.profile_complete OR d.needs_verification)
-- Most-blocked first, then the ones someone flagged as uncertain.
ORDER BY cardinality(d.missing_fields) DESC, d.needs_verification DESC, d.full_name;

COMMENT ON VIEW crm.v_doctors_needing_details IS
  'Rep work queue: doctors who cannot be contacted yet, or whose transcribed '
  'details were marked uncertain. Inherits the caller''s RLS, so an executive '
  'sees only their own assigned doctors.';

INSERT INTO crm.schema_migrations (version)
VALUES ('2026-10-04_crm_doctor_skeleton_records')
ON CONFLICT DO NOTHING;
