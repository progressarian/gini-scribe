#!/bin/bash
# Full cycle: rebuild scratch DB -> apply migration -> seed fixtures -> verify RLS.
set -e
cd "$(dirname "$0")"
./apply.sh
echo "=== _scratch_fixtures.sql ==="
docker exec -i "${CRM_CONTAINER:-gini-crm-test}" psql -U postgres -d "${CRM_DB:-crmtest}" -q -v ON_ERROR_STOP=1 < _scratch_fixtures.sql
echo "    ok"
./verify_rls.sh
