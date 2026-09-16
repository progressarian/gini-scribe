#!/bin/bash
# =====================================================================
# Apply the CRM Phase 1 migration to the Supabase project.
#
# Invoke through Railway so DATABASE_URL is injected into the process and
# never written to a file, a log, or the terminal:
#
#   railway run -s gini-scribe -e production -- ./apply_supabase.sh
#
# It never runs _scratch_scribe_stub.sql (those tables already exist in Scribe)
# and never runs _scratch_fixtures.sql, which would insert fake patients into
# the live clinical database.
#
# Safe to re-run: every migration in the chain is idempotent, and the enum
# conversion refuses outright if the CRM has picked up operational data.
# =====================================================================
set -euo pipefail
cd "$(dirname "$0")"

: "${DATABASE_URL:?Run via: railway run -s gini-scribe -e production -- ./apply_supabase.sh}"

# Supabase's DATABASE_URL points at the transaction pooler (6543), which does
# not hold session state. DDL and the RLS harness need SET LOCAL ROLE and
# startup parameters to survive, so target the session pooler on 5432. Same
# host, same credentials, different multiplexing mode.
export SESSION_DSN
SESSION_DSN=$(node -e 'const u=new URL(process.env.DATABASE_URL); u.port="5432"; process.stdout.write(u.toString());')

MIGRATIONS=$(cd .. && pwd)

psql_run() {
  docker run --rm -i -e SESSION_DSN -v "$MIGRATIONS":/w -w /w postgres:17 \
    bash -c 'exec psql "$SESSION_DSN" "$@"' _ "$@"
}

echo "== target =="
psql_run -tA -c "select 'server: '||current_setting('server_version')" \
         -c "select 'connected as: '||current_user" \
         -c "select 'database: '||current_database()"

echo
echo "== preflight =="
ENUMS=$(psql_run -tA -c "select count(*) from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname='crm' and t.typtype='e'" | tr -d '[:space:]')
PATIENTS=$(psql_run -tA -c "select count(*) from public.patients" | tr -d '[:space:]')
echo "  legacy enum types in crm: $ENUMS (0 once converted)"
echo "  public.patients rows visible: $PATIENTS (read-only; the migration does not modify them)"

echo
for f in 2026-09-30_crm_enums_to_text.sql \
         2026-09-16_crm_phase1.sql \
         2026-09-16_crm_phase1_rls.sql \
         2026-10-01_crm_registration.sql \
         2026-10-03_crm_registration_record_fn.sql \
         2026-10-02_crm_inbound_attribution_comments.sql; do
  echo "== applying $f =="
  psql_run -v ON_ERROR_STOP=1 -q -f "$f" 2>&1 | sed 's/^/    /'
  echo "    applied"
done

echo
echo "== post-apply state =="
psql_run -tA \
  -c "select 'tables: '||count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='crm' and c.relkind='r'" \
  -c "select 'policies: '||count(*) from pg_policies where schemaname='crm'" \
  -c "select 'rls_enabled: '||count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='crm' and c.relkind='r' and c.relrowsecurity" \
  -c "select 'enums: '||count(*) from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname='crm' and t.typtype='e'" \
  -c "select 'check_constraints: '||count(*) from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname='crm' and c.contype='c'" \
  -c "select 'roles: '||string_agg(rolname,', ' order by rolname) from pg_roles where rolname like 'crm\\_%'" \
  -c "select 'event_trigger: '||case when exists(select 1 from pg_event_trigger where evtname='crm_no_payout_columns') then 'installed' else 'ABSENT - CI check is the only guard' end" \
  -c "select 'seed: '||(select count(*) from crm.hospitals)||' hospital, '||(select count(*) from crm.territories)||' territories, '||(select count(*) from crm.service_lines)||' service lines'"
