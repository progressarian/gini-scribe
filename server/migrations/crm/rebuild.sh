#!/bin/bash
# Full cycle: rebuild scratch DB -> apply migration -> seed fixtures -> verify RLS.
set -e
cd "$(dirname "$0")"
./apply.sh
echo "=== 003_test_seed.sql ==="
docker exec -i "${CRM_CONTAINER:-gini-crm-test}" psql -U postgres -d "${CRM_DB:-crmtest}" -q -v ON_ERROR_STOP=1 < 003_test_seed.sql
echo "    ok"
./verify_rls.sh
