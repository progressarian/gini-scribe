#!/bin/bash
# =====================================================================
# Apply the CRM Phase 1 migration to the Supabase project.
#
# Invoke through Railway so DATABASE_URL is injected into the process and
# never written to a file, a log, or the terminal:
#
#   railway run -s gini-scribe -e production -- ./apply_supabase.sh
#
# This applies 001 and 002 only. It never runs 000_scribe_stub.sql (those
# tables already exist in Scribe) and never runs 003_test_seed.sql, which
# would insert fake patients into the live clinical database.
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

psql_run() {
  docker run --rm -i -e SESSION_DSN -v "$PWD":/w -w /w postgres:15 \
    bash -c 'exec psql "$SESSION_DSN" "$@"' _ "$@"
}

echo "== target =="
psql_run -tA -c "select 'server: '||current_setting('server_version')" \
         -c "select 'connected as: '||current_user" \
         -c "select 'database: '||current_database()"

echo
echo "== preflight =="
EXISTING=$(psql_run -tA -c "select count(*) from pg_namespace where nspname='crm'" | tr -d '[:space:]')
if [ "$EXISTING" != "0" ]; then
  echo "  crm schema already exists — refusing to re-apply."
  echo "  To start over: psql -c 'drop schema crm cascade; drop role crm_app;'"
  exit 1
fi
PATIENTS=$(psql_run -tA -c "select count(*) from public.patients" | tr -d '[:space:]')
echo "  crm schema absent, ready to create"
echo "  public.patients rows visible: $PATIENTS (read-only; the migration does not modify them)"

echo
for f in 001_crm_phase1.sql 002_crm_phase1_rls.sql; do
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
  -c "select 'event_trigger: '||case when exists(select 1 from pg_event_trigger where evtname='crm_no_payout_columns') then 'installed' else 'ABSENT - CI check is the only guard' end" \
  -c "select 'seed: '||(select count(*) from crm.hospitals)||' hospital, '||(select count(*) from crm.territories)||' territories, '||(select count(*) from crm.service_lines)||' service lines'"
