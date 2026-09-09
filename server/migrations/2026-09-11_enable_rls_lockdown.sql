-- ============================================================
-- Close the public schema to the anon key.
-- 2026-09-11
--
-- WHY. PostgREST exposes `public` on this project. The anon key — a public
-- credential by design, which /api/giniflow/realtime-token hands to any
-- logged-in browser — could read and write patient tables directly: `patients`
-- answered 200 with 18,432 rows, and an insert probe returned PGRST204 (bad
-- column) rather than 42501, proving the write grant was live too.
--
-- 128 tables were exposed, in two different ways. 25 simply had RLS off. The
-- other 103 had RLS ON and so looked "Restricted" in the dashboard, but carried
-- 422 policies that were every one of them USING (true) / WITH CHECK (true) for
-- {anon,authenticated} — the warning had been silenced with allow-everything
-- policies, which is not a restriction at all. Enabling RLS on the first 25
-- without dropping those policies would have fixed a fifth of the problem and
-- left the dashboard looking clean, which is the worse outcome.
--
-- WHAT THIS DOES. Drops every policy in `public`, enables RLS everywhere, and
-- revokes the grants. RLS on with ZERO policies = deny all. Nothing is granted
-- back; this schema is not meant to be reachable from a browser at all.
--
-- WHY IT DOES NOT BREAK THE APP. The API and worker connect as `postgres`
-- (server/config/db.js), and the server-side Supabase SDK calls use
-- SUPABASE_SERVICE_KEY -> service_role. Both bypass RLS. The only browser-side
-- Supabase use here is Realtime Broadcast (src/lib/giniflowRealtime.js), which
-- reads no table and is authorised by realtime.messages — untouched below,
-- since this migration only ever names schema `public`.
--
-- FORCE, because plain ENABLE still exempts the table owner, and ownership in
-- a Supabase project is not a boundary worth trusting.
--
-- The REVOKEs are the part that covers VIEWS. RLS protects tables only; a view
-- in `public` owned by postgres runs with the owner's rights and would read
-- straight through the policies underneath it. Grants are also what PostgREST
-- checks before it ever reaches RLS.
--
-- Reversible: ALTER TABLE ... DISABLE ROW LEVEL SECURITY.
-- ============================================================

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT policyname, tablename FROM pg_policies WHERE schemaname = 'public'
  LOOP
    EXECUTE format('DROP POLICY %I ON public.%I', r.policyname, r.tablename);
  END LOOP;

  FOR r IN
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.tablename);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', r.tablename);
  END LOOP;
END $$;

REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL ROUTINES  IN SCHEMA public FROM anon, authenticated;

REVOKE USAGE ON SCHEMA public FROM anon, authenticated;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL ON FUNCTIONS FROM anon, authenticated;
