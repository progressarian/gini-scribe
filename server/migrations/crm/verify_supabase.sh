#!/bin/bash
# =====================================================================
# Production-safe verification of the CRM schema on Supabase.
#
#   railway run -s gini-scribe -e production -- ./verify_supabase.sh
#
# Every check here is READ-ONLY. It writes nothing, and the one DDL probe
# runs inside a transaction that is always rolled back.
#
# This is deliberately NOT verify_rls.sh. That suite proves behaviour — a
# Growth Executive sees 1 of 3 doctors — which requires fixture rows,
# including patients. Seeding it against production would insert fake
# patients into the live clinical database. The behavioural suite belongs on
# a scratch database or a Supabase branch; this script proves the structural
# and negative guarantees that hold with no data at all.
# =====================================================================
set -uo pipefail
cd "$(dirname "$0")"

# SESSION_DSN may be supplied directly (to dry-run against a scratch database);
# otherwise it is derived from Railway's injected DATABASE_URL.
if [ -z "${SESSION_DSN:-}" ]; then
  : "${DATABASE_URL:?Run via: railway run -s gini-scribe -e production -- ./verify_supabase.sh}"
  SESSION_DSN=$(node -e 'const u=new URL(process.env.DATABASE_URL); u.port="5432"; process.stdout.write(u.toString());')
fi
export SESSION_DSN

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m  %s\n       got: %s\n' "$1" "$2"; }

# Role switching happens in-statement rather than via startup parameters,
# because the connection may be multiplexed. SET tags are filtered out.
sql() {
  docker run --rm -i -e SESSION_DSN postgres:15 \
    psql "$SESSION_DSN" -tA -q -v ON_ERROR_STOP=1 2>&1 | grep -vE '^(SET|RESET)$'
}
as_owner() { echo "$1" | sql; }
as_user()  { printf "set role crm_app;\nselect set_config('crm.user_id','%s',false);\n%s\n" "$1" "$2" | sql | tail -n +2; }

expect() { # $1=actual $2=expected $3=label
  local got; got=$(echo "$1" | tr -d '[:space:]')
  [ "$got" = "$2" ] && ok "$3 (= $2)" || bad "$3 (expected $2)" "$got"
}
expect_err() { # $1=output $2=substring $3=label
  echo "$1" | grep -qi -- "$2" && ok "$3" || bad "$3 (expected error matching '$2')" "$(echo "$1"|head -1)"
}

echo
echo "Structure"
expect "$(as_owner "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='crm' and c.relkind='r' and c.relname<>'schema_migrations';")" 26 "26 crm tables present"
expect "$(as_owner "select count(*) from pg_policies where schemaname='crm';")" 52 "52 RLS policies installed"
expect "$(as_owner "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='crm' and c.relkind='r' and c.relrowsecurity;")" 26 "RLS enabled on every crm table"
expect "$(as_owner "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='crm' and c.relkind='r' and c.relforcerowsecurity;")" 21 "RLS forced on the 21 data tables"
expect "$(as_owner "select count(*) from crm.hospitals;")" 1 "reference seed: 1 hospital"
expect "$(as_owner "select count(*) from crm.service_lines;")" 16 "reference seed: 16 service lines"
expect "$(as_owner "select count(*) from crm.territories;")" 8 "reference seed: 8 territories"

echo
echo "Role isolation"
expect "$(as_owner "select count(*) from pg_roles where rolname='crm_app' and not rolbypassrls and not rolcanlogin;")" 1 "crm_app exists, cannot log in, cannot bypass RLS"
expect "$(as_owner "select count(*) from information_schema.role_table_grants where grantee='crm_app' and table_schema='public';")" 0 "crm_app holds zero privileges on schema public"
expect "$(as_owner "select count(*) from information_schema.role_table_grants where grantee='crm_app' and table_schema='crm' and privilege_type='DELETE';")" 0 "crm_app holds no DELETE anywhere in crm"

echo
echo "Negative access, as crm_app"
UNKNOWN=00000000-0000-0000-0000-0000000000ff
expect_err "$(as_user "$UNKNOWN" "select count(*) from public.patients;")" "permission denied" "public.patients is denied to crm_app"
expect_err "$(as_user "$UNKNOWN" "delete from crm.doctors;")" "permission denied" "DELETE on crm.doctors is denied"
expect "$(as_user "$UNKNOWN" "select count(*) from crm.doctors;")" 0 "an unrecognised user sees zero doctors (fails closed)"
expect "$(as_user "$UNKNOWN" "select count(*) from crm.doctor_referrals;")" 0 "…and zero referrals"
expect_err "$(as_owner "select crm.assert_app_role();")" "must run as crm_app" "assert_app_role rejects the pool role"
expect "$(as_user "$UNKNOWN" "select 'ok' from crm.assert_app_role();")" "ok" "…and passes under crm_app"

echo
echo "Patient exposure surface"
expect "$(as_owner "select count(*) from information_schema.columns where table_schema='crm' and table_name='v_referral_patients';")" 7 "v_referral_patients exposes exactly 7 identity columns"
expect "$(as_owner "select count(*) from information_schema.columns where table_schema='crm' and table_name='v_referral_patients' and column_name in ('notes','address','aadhaar','abha_id','email','dob');")" 0 "…and none of Scribe's sensitive patient columns"

echo
echo "NMC compliance guard"
TRIG=$(as_owner "select count(*) from pg_event_trigger where evtname='crm_no_payout_columns';" | tr -d '[:space:]')
if [ "$TRIG" = "1" ]; then
  ok "in-database event trigger is installed on Supabase"
  expect_err "$(as_owner "begin; alter table crm.doctors add column referral_fee numeric; rollback;")" "NMC compliance" "…and rejects a referral_fee column"
else
  ok "event trigger absent as expected on Supabase (superuser required) — degraded to CI"
  # The probe would otherwise really add the column, so it runs inside a
  # transaction that is rolled back regardless of outcome.
  OUT=$(as_owner "begin; alter table crm.doctors add column referral_fee numeric; rollback;")
  LEFT=$(as_owner "select count(*) from information_schema.columns where table_schema='crm' and table_name='doctors' and column_name='referral_fee';" | tr -d '[:space:]')
  expect "$LEFT" 0 "…probe rolled back cleanly, no referral_fee column left behind"
fi
expect "$(as_owner "select count(*) from information_schema.columns where table_schema='crm' and column_name ~* '(commission|payout|payable|incentive|kickback|fee_split|referral_fee|bounty|remuneration)';")" 0 "no payment-shaped column exists in crm"

echo
echo "Naming direction"
expect "$(as_owner "select (obj_description('crm.doctor_referrals'::regclass) ~ 'INBOUND')::text;")" "true" "crm.doctor_referrals is labelled INBOUND"
# public.referrals is created at runtime by server/routes/visit.js, so it may
# legitimately not exist yet on a given environment.
OUTBOUND=$(as_owner "select coalesce((obj_description(to_regclass('public.referrals')) ~ 'OUTBOUND')::text,'absent');" | tr -d '[:space:]')
case "$OUTBOUND" in
  true)   ok "public.referrals is labelled OUTBOUND" ;;
  absent) ok "public.referrals does not exist yet — nothing to label" ;;
  *)      bad "public.referrals should be labelled OUTBOUND" "$OUTBOUND" ;;
esac

echo
echo "Helpers"
expect "$(as_owner "select crm.normalize_phone('98765 00011');")" "+919876500011" "phone normalisation works"

echo
printf '  %s passed, %s failed\n\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
