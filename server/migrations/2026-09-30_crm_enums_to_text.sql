-- ============================================================
-- CRM vocabularies: 16 Postgres enums -> TEXT + CHECK
-- 2026-09-30
--
--   node migrations/_runOne.mjs migrations/2026-09-30_crm_enums_to_text.sql
--
-- Phase 1 shipped its vocabularies as Postgres enums. That is not the house
-- rule: shared/giniflowReferrals.js states it — TEXT with a trailing comment
-- plus a shared vocabulary file — so that a vocabulary can grow without a
-- migration. A CRM whose relationship-stage list needs DDL to change is the
-- CRM nobody updates. The labels now live in shared/crmVocab.js and the
-- integrity floor is a CHECK constraint on each column.
--
-- WHY A REBUILD RATHER THAN 16 ALTER TYPE CONVERSIONS
--
-- crm.current_user_role() returns crm.user_role and is called by all 52 RLS
-- policies. Changing a function's return type means DROP, and the policies
-- depend on it — so an in-place conversion has to drop every policy, drop the
-- function, convert 22 columns, recreate the function, then recreate every
-- policy. That is the whole of 2026-09-16_crm_phase1_rls.sql executed twice in
-- a more fragile order. Dropping and re-creating the schema does the same work
-- with one moving part, and is safe for exactly as long as the CRM holds no
-- operational data.
--
-- The emptiness check below is what makes that true, and it is a hard failure
-- rather than a skip: if this ever runs against a CRM with doctors or referrals
-- in it, the right outcome is an aborted migration and a human writing the
-- careful in-place version.
--
-- Idempotent: a no-op once the enums are gone. Run the two
-- 2026-09-16_crm_phase1*.sql files after this to rebuild the schema.
-- ============================================================

DO $$
DECLARE
  n_enums int;
  n_rows  bigint := 0;
  tbl     text;
  cnt     bigint;
  -- Reference data seeded by the migration itself. Hospitals, territories,
  -- service lines and cadence policies are regenerated on re-apply, so they do
  -- not count as operational data.
  data_tables text[] := ARRAY[
    'doctors', 'doctor_practice', 'doctor_service_opportunities',
    'doctor_assignments', 'doctor_stage_history', 'visits', 'visit_attachments',
    'doctor_referrals', 'referral_attributions', 'referral_clinical_notes',
    'referral_journey_events', 'patient_referral_sources', 'patient_consents',
    'revenue_records', 'tasks', 'saved_views', 'import_batches', 'import_rows',
    'users'
  ];
BEGIN
  IF to_regnamespace('crm') IS NULL THEN
    RAISE NOTICE 'crm schema not present — nothing to convert';
    RETURN;
  END IF;

  SELECT count(*) INTO n_enums
    FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
   WHERE n.nspname = 'crm' AND t.typtype = 'e';

  IF n_enums = 0 THEN
    RAISE NOTICE 'crm vocabularies are already TEXT + CHECK — nothing to do';
    RETURN;
  END IF;

  FOREACH tbl IN ARRAY data_tables LOOP
    IF to_regclass('crm.' || tbl) IS NOT NULL THEN
      EXECUTE format('SELECT count(*) FROM crm.%I', tbl) INTO cnt;
      n_rows := n_rows + cnt;
    END IF;
  END LOOP;

  IF n_rows > 0 THEN
    RAISE EXCEPTION
      'crm schema holds % operational rows — refusing to rebuild', n_rows
      USING HINT = 'This migration is only safe on an empty CRM. With data present, '
                   'write the in-place ALTER TYPE conversion instead: drop the 52 '
                   'policies, drop crm.current_user_role(), convert the 22 columns, '
                   'then recreate both.';
  END IF;

  RAISE NOTICE 'crm holds no operational data (% enums to remove) — rebuilding', n_enums;

  -- The event trigger is not schema-scoped, so CASCADE would not reach it.
  DROP EVENT TRIGGER IF EXISTS crm_no_payout_columns;
  DROP SCHEMA crm CASCADE;

  -- The roles are deliberately NOT dropped. DROP ROLE is cluster-wide while
  -- DROP OWNED BY only reaches the current database, so a role holding grants
  -- in any other database on the same cluster cannot be dropped — which aborts
  -- this block and leaves the schema standing with its enums intact. Rehearsing
  -- this migration against a copy of production is how that was found.
  --
  -- Keeping them is also correct on its own terms: DROP SCHEMA ... CASCADE
  -- removes every grant and default privilege inside crm, so the roles survive
  -- with no residual authority, and 2026-09-16_crm_phase1.sql recreates them
  -- only if absent.

  RAISE NOTICE 'crm schema dropped — now apply 2026-09-16_crm_phase1.sql and _rls.sql';
END $$;
