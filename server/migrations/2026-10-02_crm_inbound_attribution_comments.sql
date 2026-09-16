-- ============================================================
-- Label the two dormant inbound-attribution columns on appointments
-- 2026-10-02
--
--   node migrations/_runOne.mjs migrations/2026-10-02_crm_inbound_attribution_comments.sql
--
-- 2026-06-01_ghm_cc_system.sql added appointments.how_did_you_know and
-- appointments.referred_by_doctor_name. They are free text, per-appointment,
-- written only by the GHM Excel import, and have no frontend. As of today they
-- hold zero values across 45,940 appointments — inbound attribution has never
-- actually been captured through them.
--
-- crm.patient_referral_sources is now the canonical store for that answer: one
-- row per patient, a real foreign key to the referring doctor, and a distinction
-- between "said nobody referred me" and "was never asked" that free text cannot
-- express. These two columns are left in place — dropping a column the GHM
-- import writes is a separate piece of work — but labelled so nobody revives
-- them as a second source of truth.
--
-- Metadata only. COMMENT ON does not alter the table or its data.
-- Idempotent.
-- ============================================================

DO $$
BEGIN
  IF to_regclass('public.appointments') IS NULL THEN
    RAISE NOTICE 'appointments table not present — skipping';
    RETURN;
  END IF;

  EXECUTE $c$
    COMMENT ON COLUMN public.appointments.how_did_you_know IS
      'DORMANT — do not build on this. Free-text marketing-channel answer from '
      'the GHM Excel import; never populated (0 of 45,940 rows as of 2026-10-02) '
      'and no frontend writes it. Canonical inbound attribution is '
      'crm.patient_referral_sources, which distinguishes "came on my own" from '
      '"was never asked". See docs/CRM_PLAN.md.'
  $c$;

  EXECUTE $c$
    COMMENT ON COLUMN public.appointments.referred_by_doctor_name IS
      'DORMANT — do not build on this. Free-text referring-doctor name from the '
      'GHM Excel import; never populated and cannot reference a doctor record. '
      'Canonical inbound attribution is crm.patient_referral_sources, whose '
      'doctor_id is a real foreign key to crm.doctors. See docs/CRM_PLAN.md.'
  $c$;

  RAISE NOTICE 'dormant inbound-attribution columns labelled';
END $$;
