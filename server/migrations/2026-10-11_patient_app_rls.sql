-- ============================================================
-- Let the patient app (myhealthgenie) back in — scoped to its own rows.
--
-- WHY. 2026-09-11_enable_rls_lockdown.sql closed `public` to anon and
-- authenticated. That was right for the anon key, but the patient app reads
-- and writes this DB directly through PostgREST, so every hospital patient
-- hit "permission denied for table patients" on launch.
--
-- HOW. The app no longer uses the anon key here. It fetches a token from
-- GET /api/patient/app/gini-db-token (server/routes/patientApp.js): role
-- `authenticated`, plus an `app_patient_ids` claim holding the patient and the
-- family members on the same phone. Every policy below admits a row only when
-- its patient id is in that claim. anon stays fully locked out.
--
-- Staff browsers also hold `authenticated` tokens (Gini Flow Realtime,
-- giniflow.js), but those carry no `app_patient_ids`, so app_patient_ids()
-- returns '{}' and every policy here admits nothing for them.
--
-- FUNCTIONS. Postgres grants EXECUTE on new functions to PUBLIC. The lockdown
-- only hid that behind the missing schema USAGE; granting USAGE back would
-- expose every SECURITY DEFINER function in `public` (they bypass RLS). So the
-- PUBLIC grant on definer functions is revoked here, and the app gets narrow wrappers that check
-- p_patient_id against the token before calling the original gini_* RPC.
--
-- Tables that do not exist on this DB are skipped, so the file is safe to run
-- as-is. Run: node migrations/_runOne.mjs migrations/2026-10-11_patient_app_rls.sql
--
-- Rollback: DROP POLICY app_patient_rows on each table, then
--   REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated;
--   REVOKE USAGE ON SCHEMA public FROM authenticated;
-- ============================================================

BEGIN;

-- ── 1. Close PUBLIC execute on SECURITY DEFINER functions ──────────────────
-- Only definer functions matter: an invoker function runs with the caller's
-- rights and so stays inside RLS. Extension functions (uuid defaults etc.)
-- are left alone. The API connects as postgres (the owner) and is unaffected;
-- service_role is granted back explicitly.
--
-- NOTE for future migrations: a new SECURITY DEFINER function in `public` is
-- executable by PUBLIC again unless it is followed by
--   REVOKE EXECUTE ON FUNCTION ... FROM PUBLIC;
DO $$
DECLARE f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prosecdef
       AND p.prokind = 'f'
       AND NOT EXISTS (SELECT 1 FROM pg_depend d
                        WHERE d.classid = 'pg_proc'::regclass
                          AND d.objid = p.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.sig);
  END LOOP;
END $$;

-- ── 2. Claim helpers ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.app_patient_ids()
RETURNS integer[]
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  SELECT COALESCE(
    ARRAY(
      SELECT (v)::integer
        FROM jsonb_array_elements_text(auth.jwt() -> 'app_patient_ids') AS v
    ),
    '{}'::integer[]
  )
$$;

CREATE OR REPLACE FUNCTION public.app_assert_patient(p_patient_id integer)
RETURNS void
LANGUAGE plpgsql STABLE
SET search_path = ''
AS $$
BEGIN
  IF p_patient_id IS NULL OR NOT (p_patient_id = ANY (public.app_patient_ids())) THEN
    RAISE EXCEPTION 'not allowed for patient %', p_patient_id USING ERRCODE = '42501';
  END IF;
END;
$$;

GRANT USAGE ON SCHEMA public TO authenticated;
GRANT EXECUTE ON FUNCTION public.app_patient_ids() TO authenticated;
GRANT EXECUTE ON FUNCTION public.app_assert_patient(integer) TO authenticated;

-- ── 3. Tables: grants + one policy per table ───────────────────────────────
-- (table, patient column, privileges). Column-limited UPDATE where the app
-- only ever touches a couple of fields.
DO $$
DECLARE
  r record;
  seq text;
  cond text;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('patients',                        'id',         'SELECT'),
      ('appointments',                    'patient_id', 'SELECT, UPDATE (compliance, pre_visit_compliance_at)'),
      ('consultations',                   'patient_id', 'SELECT'),
      ('consultation_test_status',        'patient_id', 'SELECT, INSERT, UPDATE, DELETE'),
      ('vitals',                          'patient_id', 'SELECT, INSERT'),
      ('patient_vitals_log',              'patient_id', 'SELECT'),
      ('lab_results',                     'patient_id', 'SELECT, INSERT, UPDATE'),
      ('medications',                     'patient_id', 'SELECT, UPDATE'),
      ('patient_medications_genie',       'patient_id', 'SELECT'),
      ('diagnoses',                       'patient_id', 'SELECT'),
      ('patient_med_log',                 'patient_id', 'SELECT, INSERT, UPDATE, DELETE'),
      ('patient_med_streak',              'patient_id', 'SELECT, INSERT, UPDATE'),
      ('goals',                           'patient_id', 'SELECT, INSERT, UPDATE, DELETE'),
      ('meal_logs',                       'patient_id', 'SELECT, INSERT, UPDATE, DELETE'),
      ('patient_symptom_log',             'patient_id', 'SELECT, INSERT'),
      ('patient_summaries',               'patient_id', 'SELECT'),
      ('documents',                       'patient_id', 'SELECT'),
      ('chat_messages',                   'patient_id', 'SELECT, INSERT'),
      ('patient_messages',                'patient_id', 'SELECT, INSERT, UPDATE (is_read, read_at)'),
      ('conversations',                   'patient_id', 'SELECT, INSERT, UPDATE (patient_unread_count)'),
      ('medication_refill_requests',      'patient_id', 'SELECT'),
      ('medication_dose_change_requests', 'patient_id', 'SELECT'),
      ('patient_reported_side_effects',   'patient_id', 'SELECT')
    ) AS t(tbl, col, privs)
  LOOP
    IF to_regclass('public.' || r.tbl) IS NULL THEN
      RAISE NOTICE 'skip %: table not found', r.tbl;
      CONTINUE;
    END IF;

    -- conversations.patient_id is text; everything else is an integer id.
    -- The (SELECT ...) wrapper makes Postgres evaluate the claim once per
    -- query instead of once per row, so the patient_id index still applies.
    IF (SELECT data_type FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = r.tbl AND column_name = r.col)
       IN ('text', 'character varying') THEN
      cond := format('%I = ANY ((SELECT public.app_patient_ids())::text[])', r.col);
    ELSE
      cond := format('%I = ANY ((SELECT public.app_patient_ids())::integer[])', r.col);
    END IF;

    EXECUTE format('GRANT %s ON public.%I TO authenticated', r.privs, r.tbl);
    EXECUTE format('DROP POLICY IF EXISTS app_patient_rows ON public.%I', r.tbl);
    EXECUTE format(
      'CREATE POLICY app_patient_rows ON public.%I FOR ALL TO authenticated USING (%s) WITH CHECK (%s)',
      r.tbl, cond, cond);

    -- Inserts on serial / identity ids need the sequence.
    IF r.privs LIKE '%INSERT%' AND EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = r.tbl AND column_name = 'id') THEN
      SELECT pg_get_serial_sequence('public.' || quote_ident(r.tbl), 'id') INTO seq;
      IF seq IS NOT NULL THEN
        EXECUTE format('GRANT USAGE ON SEQUENCE %s TO authenticated', seq);
      END IF;
    END IF;
  END LOOP;
END $$;

-- Refill items carry no patient_id; they are visible through their request.
DO $$
BEGIN
  IF to_regclass('public.medication_refill_request_items') IS NOT NULL THEN
    GRANT SELECT ON public.medication_refill_request_items TO authenticated;
    DROP POLICY IF EXISTS app_patient_rows ON public.medication_refill_request_items;
    CREATE POLICY app_patient_rows ON public.medication_refill_request_items
      FOR SELECT TO authenticated
      USING (EXISTS (
        SELECT 1 FROM public.medication_refill_requests r
         WHERE r.id = request_id
           AND r.patient_id = ANY ((SELECT public.app_patient_ids())::integer[])
      ));
  END IF;
END $$;

-- ── 4. RPC wrappers ─────────────────────────────────────────────────────────
-- The gini_* originals are SECURITY DEFINER and trust p_patient_id. They stay
-- unreachable from the app; these check the claim first, then delegate.

CREATE OR REPLACE FUNCTION public.app_create_refill_request(
  p_patient_id integer, p_items jsonb, p_notes text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  PERFORM public.app_assert_patient(p_patient_id);
  RETURN public.gini_create_refill_request(p_patient_id, p_items, p_notes);
END;
$$;

CREATE OR REPLACE FUNCTION public.app_create_dose_change_request(
  p_patient_id integer,
  p_medication_id text,
  p_medication_name text,
  p_current_dose text,
  p_requested_dose text DEFAULT NULL,
  p_dose_unit text DEFAULT NULL,
  p_patient_reason text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  PERFORM public.app_assert_patient(p_patient_id);
  RETURN public.gini_create_dose_change_request(
    p_patient_id, p_medication_id, p_medication_name, p_current_dose,
    p_requested_dose, p_dose_unit, p_patient_reason);
END;
$$;

CREATE OR REPLACE FUNCTION public.app_cancel_dose_change_request(
  p_request_id uuid, p_patient_id integer
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  PERFORM public.app_assert_patient(p_patient_id);
  RETURN public.gini_cancel_dose_change_request(p_request_id, p_patient_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.app_upsert_patient_side_effect(
  p_id uuid,
  p_patient_id integer,
  p_medication_id text,
  p_medication_name text,
  p_name text,
  p_description text DEFAULT NULL,
  p_severity text DEFAULT 'common',
  p_status text DEFAULT 'active',
  p_source text DEFAULT 'custom',
  p_patient_note text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  PERFORM public.app_assert_patient(p_patient_id);
  RETURN public.gini_upsert_patient_side_effect(
    p_id, p_patient_id, p_medication_id, p_medication_name, p_name,
    p_description, p_severity, p_status, p_source, p_patient_note);
END;
$$;

CREATE OR REPLACE FUNCTION public.app_delete_patient_side_effect(
  p_id uuid, p_patient_id integer
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  PERFORM public.app_assert_patient(p_patient_id);
  RETURN public.gini_delete_patient_side_effect(p_id, p_patient_id);
END;
$$;

REVOKE EXECUTE ON FUNCTION
  public.app_create_refill_request(integer, jsonb, text),
  public.app_create_dose_change_request(integer, text, text, text, text, text, text),
  public.app_cancel_dose_change_request(uuid, integer),
  public.app_upsert_patient_side_effect(uuid, integer, text, text, text, text, text, text, text, text),
  public.app_delete_patient_side_effect(uuid, integer)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  public.app_create_refill_request(integer, jsonb, text),
  public.app_create_dose_change_request(integer, text, text, text, text, text, text),
  public.app_cancel_dose_change_request(uuid, integer),
  public.app_upsert_patient_side_effect(uuid, integer, text, text, text, text, text, text, text, text),
  public.app_delete_patient_side_effect(uuid, integer)
TO authenticated;

COMMIT;

-- PostgREST caches the schema; make it see the new grants and functions.
NOTIFY pgrst, 'reload schema';
