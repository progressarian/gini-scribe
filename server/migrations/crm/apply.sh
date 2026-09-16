#!/bin/bash
# Rebuild the scratch DB from scratch and apply the proposed migration.
set -u
C=${CRM_CONTAINER:-gini-crm-test}
DB=${CRM_DB:-crmtest}
docker exec $C psql -U postgres -tAc "drop database if exists $DB" -d postgres >/dev/null
docker exec $C psql -U postgres -tAc "create database $DB" -d postgres >/dev/null
for f in _scratch_scribe_stub.sql ../2026-09-16_crm_phase1.sql ../2026-09-16_crm_phase1_rls.sql; do
  echo "=== $f ==="
  docker exec -i $C psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -q < "$f" 2>&1 | sed 's/^/    /'
  rc=${PIPESTATUS[0]}
  [ $rc -ne 0 ] && { echo "    FAILED (exit $rc)"; exit $rc; }
  echo "    ok"
done
