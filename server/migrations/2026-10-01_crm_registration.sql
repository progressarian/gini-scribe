-- ============================================================
-- Registration capability: the doctor picker at patient registration
-- 2026-10-01
--
--   node migrations/_runOne.mjs migrations/2026-10-01_crm_registration.sql
--
-- "Who referred you?" is asked at registration, which means front-desk staff
-- need to search the doctor universe. They are not growth-team members and
-- must not become crm.users rows: the narrowest CRM role that can browse
-- doctors is `operations`, and operations can also read revenue.
--
-- So registration gets its own database role with exactly two powers: execute
-- one search function that returns picker fields only, and write the patient's
-- answer. It cannot read practice intelligence, potential revenue, relationship
-- stage, notes, referrals, or anything else in the schema.
--
-- Idempotent.
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crm_registration') THEN
    CREATE ROLE crm_registration NOLOGIN NOINHERIT;
  END IF;
  EXECUTE format('GRANT crm_registration TO %I', current_user);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Could not create or grant crm_registration: %', SQLERRM;
END $$;

GRANT USAGE ON SCHEMA crm TO crm_registration;

-- Picker fields only. No potential revenue, no relationship stage, no notes —
-- SECURITY DEFINER so it answers without granting SELECT on crm.doctors, which
-- would expose every one of those columns.
CREATE OR REPLACE FUNCTION crm.search_doctors_for_registration(
  p_query text,
  p_limit int DEFAULT 10
)
RETURNS TABLE (
  doctor_id   uuid,
  full_name   text,
  specialty   text,
  clinic_name text,
  area        text
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = crm, public, pg_temp AS $$
  WITH q AS (
    SELECT btrim(coalesce(p_query, '')) AS raw,
           regexp_replace(coalesce(p_query, ''), '[^0-9]', '', 'g') AS digits
  )
  SELECT d.id, d.full_name, d.specialty, d.clinic_name, d.area
  FROM crm.doctors d, q
  WHERE d.deleted_at IS NULL
    AND d.is_active
    AND length(q.raw) >= 2
    AND (
      d.full_name ILIKE '%' || q.raw || '%'
      OR d.clinic_name ILIKE '%' || q.raw || '%'
      OR d.specialty ILIKE '%' || q.raw || '%'
      OR (length(q.digits) >= 4 AND d.mobile_e164 LIKE '%' || q.digits || '%')
    )
  -- A name match is what the clerk almost always means; a prefix match on it
  -- is what they mean most of all. Clinic and specialty fall below both.
  ORDER BY
    (d.full_name ILIKE q.raw || '%') DESC,
    (d.full_name ILIKE '%' || q.raw || '%') DESC,
    d.full_name
  LIMIT least(greatest(coalesce(p_limit, 10), 1), 25);
$$;

COMMENT ON FUNCTION crm.search_doctors_for_registration(text, int) IS
  'Doctor picker for "who referred you?" at patient registration. Returns '
  'identity and practice location only — never potential, stage, or notes. '
  'SECURITY DEFINER so front-desk staff need no crm.users row and no SELECT '
  'on crm.doctors.';

REVOKE ALL ON FUNCTION crm.search_doctors_for_registration(text, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm.search_doctors_for_registration(text, int) TO crm_registration;
GRANT EXECUTE ON FUNCTION crm.search_doctors_for_registration(text, int) TO crm_app;

GRANT SELECT, INSERT ON crm.patient_referral_sources TO crm_registration;

-- crm.current_user_id() is null under this role, so the hospital-scoped
-- policies from 2026-09-16_crm_phase1_rls.sql match nothing. These two are
-- targeted at the role itself. RLS is permissive-OR across policies, so the
-- growth-team policies are unaffected.
DROP POLICY IF EXISTS prs_registration_read ON crm.patient_referral_sources;
CREATE POLICY prs_registration_read ON crm.patient_referral_sources
  FOR SELECT TO crm_registration USING (true);

DROP POLICY IF EXISTS prs_registration_insert ON crm.patient_referral_sources;
CREATE POLICY prs_registration_insert ON crm.patient_referral_sources
  FOR INSERT TO crm_registration WITH CHECK (true);

-- No UPDATE and no DELETE: the answer given at registration is a record of what
-- the patient said, and correcting it is a growth-team action through the
-- normal policies, not something the registration desk can overwrite later.

INSERT INTO crm.schema_migrations (version)
VALUES ('2026-10-01_crm_registration')
ON CONFLICT DO NOTHING;
