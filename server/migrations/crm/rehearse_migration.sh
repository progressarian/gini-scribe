#!/bin/bash
# Runs the full dated CRM migration chain against a fresh scratch database, in
# the same order apply_supabase.sh uses on production, then proves the result
# with the behavioural suite.
#
# This is not rebuild.sh. That applies the two phase-1 files and stops;
# this walks every migration, so an ALTER that works on a fresh CREATE TABLE
# but breaks against the shipped schema is caught here.
#
# It was originally seeded from git so the enum conversion could be replayed
# against the schema production actually had. That baseline is gone now that
# production matches these files — but the chain still has to survive being run
# in order over its own output, which is what this checks.
#
#   ./rehearse_migration.sh [container] [db]
set -euo pipefail
cd "$(dirname "$0")"
C=${1:-gini-crm-17}
DB=${2:-rehearsal}

CHAIN=(
  2026-09-16_crm_phase1
  2026-09-16_crm_phase1_rls
  2026-09-30_crm_enums_to_text
  2026-10-01_crm_registration
  2026-10-03_crm_registration_record_fn
  2026-10-02_crm_inbound_attribution_comments
  2026-10-04_crm_doctor_skeleton_records
  2026-10-05_crm_referral_capture
)

echo "== fresh database =="
docker exec "$C" psql -U postgres -d postgres -q -c "drop database if exists $DB" -c "create database $DB" >/dev/null 2>&1
docker exec -i "$C" psql -U postgres -d "$DB" -q -v ON_ERROR_STOP=1 < _scratch_scribe_stub.sql >/dev/null

echo "== migration chain =="
for f in "${CHAIN[@]}"; do
  printf "   %-46s " "$f"
  docker exec -i "$C" psql -U postgres -d "$DB" -q -v ON_ERROR_STOP=1 < "../$f.sql" >/dev/null
  echo "ok"
done

echo "== re-running the whole chain (idempotency) =="
for f in "${CHAIN[@]}"; do
  docker exec -i "$C" psql -U postgres -d "$DB" -q -v ON_ERROR_STOP=1 < "../$f.sql" >/dev/null
done
echo "   every migration re-ran cleanly"

echo "== seeding fixtures and verifying =="
docker exec -i "$C" psql -U postgres -d "$DB" -q -v ON_ERROR_STOP=1 < _scratch_fixtures.sql >/dev/null
CRM_CONTAINER="$C" CRM_DB="$DB" ./verify_rls.sh
