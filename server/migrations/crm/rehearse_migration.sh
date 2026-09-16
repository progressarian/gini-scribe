#!/bin/bash
# Rehearses the production migration path end to end on a scratch database:
# build the schema exactly as production has it today (the enum version, taken
# from git), run the dated migration chain over it, then prove the result with
# the full behavioural suite.
#
# This is what caught DROP ROLE failing on a role with grants in another
# database, which would have left production half-migrated.
#
#   ./rehearse_migration.sh [container] [db]
set -euo pipefail
cd "$(dirname "$0")"
C=${1:-gini-crm-17}
DB=${2:-rehearsal}
BASE=${CRM_BASE_REF:-origin/main}

echo "== building production-as-is schema from $BASE =="
tmp=$(mktemp -d)
for f in 000_scribe_stub 001_crm_phase1 002_crm_phase1_rls; do
  git show "$BASE:server/migrations/crm/$f.sql" > "$tmp/$f.sql"
done
docker exec "$C" psql -U postgres -d postgres -q -c "drop database if exists $DB" -c "create database $DB" >/dev/null 2>&1
for f in 000_scribe_stub 001_crm_phase1 002_crm_phase1_rls; do
  docker exec -i "$C" psql -U postgres -d "$DB" -q -v ON_ERROR_STOP=1 < "$tmp/$f.sql" >/dev/null
done
rm -rf "$tmp"
echo "   enums present: $(docker exec -i "$C" psql -U postgres -d "$DB" -tA -c "select count(*) from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname='crm' and t.typtype='e'")"

echo "== running the dated migration chain =="
for f in 2026-09-30_crm_enums_to_text 2026-09-16_crm_phase1 2026-09-16_crm_phase1_rls \
         2026-10-01_crm_registration 2026-10-03_crm_registration_record_fn \
         2026-10-02_crm_inbound_attribution_comments; do
  printf "   %-48s " "$f"
  docker exec -i "$C" psql -U postgres -d "$DB" -q -v ON_ERROR_STOP=1 < "../$f.sql" >/dev/null
  echo "ok"
done
echo "   enums remaining: $(docker exec -i "$C" psql -U postgres -d "$DB" -tA -c "select count(*) from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname='crm' and t.typtype='e'")"

echo "== seeding fixtures and verifying =="
docker exec -i "$C" psql -U postgres -d "$DB" -q -v ON_ERROR_STOP=1 < _scratch_fixtures.sql >/dev/null
CRM_CONTAINER="$C" CRM_DB="$DB" ./verify_rls.sh
