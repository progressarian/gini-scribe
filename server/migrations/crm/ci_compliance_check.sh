#!/bin/bash
# =====================================================================
# NMC fee-splitting compliance check — CI gate.
#
# The migration installs an event trigger that rejects payment-shaped
# columns in the crm schema at DDL time. Event triggers require superuser,
# which Supabase may not grant to the `postgres` role. This script is the
# fallback (and a useful belt-and-braces even when the trigger IS active):
# point it at any database and it fails the build if such a column exists.
#
# Usage: ./ci_compliance_check.sh "$DATABASE_URL"
#        ./ci_compliance_check.sh --docker gini-crm-test crmtest
# =====================================================================
set -u
PATTERN='(commission|payout|payable|incentive|kickback|fee_split|referral_fee|bounty|remuneration)'

QUERY="select c.table_name || '.' || c.column_name
       from information_schema.columns c
       where c.table_schema = 'crm' and c.column_name ~* '$PATTERN'
       union all
       select t.table_name
       from information_schema.tables t
       where t.table_schema = 'crm' and t.table_name ~* '$PATTERN';"

if [ "${1:-}" = "--docker" ]; then
  FOUND=$(docker exec -i "$2" psql -U postgres -d "$3" -tA -c "$QUERY")
else
  FOUND=$(psql "$1" -tA -c "$QUERY")
fi

FOUND=$(echo "$FOUND" | grep -v '^$')
if [ -n "$FOUND" ]; then
  echo "FAIL: payment-shaped objects found in the crm schema:"
  echo "$FOUND" | sed 's/^/  - /'
  echo
  echo "Referral incentives are illegal under NMC ethics regulations."
  echo "The CRM must contain no payout ledger of any kind. See the brief's"
  echo "Compliance Design Note."
  exit 1
fi

echo "PASS: no incentive, commission or payout objects in the crm schema."

# Report whether the in-database guard is also active.
TRIG_Q="select count(*) from pg_event_trigger where evtname='crm_no_payout_columns';"
if [ "${1:-}" = "--docker" ]; then
  T=$(docker exec -i "$2" psql -U postgres -d "$3" -tA -c "$TRIG_Q")
else
  T=$(psql "$1" -tA -c "$TRIG_Q")
fi
[ "$(echo "$T"|tr -d '[:space:]')" = "1" ] \
  && echo "PASS: in-database event trigger crm_no_payout_columns is installed." \
  || echo "WARN: event trigger not installed — this CI check is the only guard."
