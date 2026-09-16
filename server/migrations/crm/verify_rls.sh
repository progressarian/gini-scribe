#!/bin/bash
# =====================================================================
# RLS verification suite for the Gini CRM Phase 1 schema.
# Proves the access-control claims hold at the database level, as crm_app.
# Run: ./verify_rls.sh     (requires the gini-crm-test container)
# =====================================================================
# Connection modes:
#   default            -> docker exec into a local scratch container
#   CRM_DSN=postgres://... -> psql over the network (CI service, or Supabase)
# The DSN never appears in output; it is passed to psql and nothing else.
MODE=${CRM_MODE:-docker}
C=${CRM_CONTAINER:-gini-crm-test}
DB=${CRM_DB:-crmtest}
[ -n "${CRM_DSN:-}" ] && MODE=dsn
PASS=0; FAIL=0

CEO=11111111-1111-1111-1111-111111111111
HOG=22222222-2222-2222-2222-222222222222
MGR=33333333-3333-3333-3333-333333333333
EXA=44444444-4444-4444-4444-444444444444
OPS=66666666-6666-6666-6666-666666666666
CLN=77777777-7777-7777-7777-777777777777

# Run SQL as crm_app impersonating a CRM user, exactly as the Express layer will.
# $1 = PGOPTIONS (may be empty); SQL on stdin.
psql_run() {
  if [ "$MODE" = "dsn" ]; then
    PGOPTIONS="$1" psql "$CRM_DSN" -tA -q -v ON_ERROR_STOP=1 2>&1
  else
    docker exec -i -e PGOPTIONS="$1" "$C" \
      psql -U postgres -d "$DB" -tA -q -v ON_ERROR_STOP=1 2>&1
  fi
}
as_user() { # $1=user uuid  $2=sql
  psql_run "-c role=crm_app -c crm.user_id=$1" <<EOF
$2
EOF
}
as_owner() {
  psql_run "" <<EOF
$1
EOF
}

ok()   { PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m  %s\n       got: %s\n' "$1" "$2"; }

expect_count() { # $1=user $2=sql $3=expected $4=label
  local got; got=$(as_user "$1" "$2" | tr -d '[:space:]')
  [ "$got" = "$3" ] && ok "$4 (= $3)" || bad "$4 (expected $3)" "$got"
}
expect_error() { # $1=user $2=sql $3=error substring $4=label
  local got; got=$(as_user "$1" "$2")
  echo "$got" | grep -qi -- "$3" && ok "$4" || bad "$4 (expected error matching '$3')" "$(echo "$got"|head -2|tr '\n' ' ')"
}
expect_owner_error() {
  local got; got=$(as_owner "$1")
  echo "$got" | grep -qi -- "$2" && ok "$3" || bad "$3 (expected error matching '$2')" "$(echo "$got"|head -2|tr '\n' ' ')"
}

echo
echo "(a) Growth Executive sees only their assigned doctors"
expect_count "$EXA" "select count(*) from crm.doctors;" 1 "Exec A sees 1 of 3 doctors"
expect_count "$EXA" "select full_name from crm.doctors;" "DrOwnedByA" "…and it is the one assigned to them"
expect_count "$EXA" "select count(*) from crm.doctor_referrals;" 1 "Exec A sees only their own referral"
expect_count "$EXA" "select count(*) from crm.visits;" 1 "Exec A sees their own visit"
expect_count "$MGR" "select count(*) from crm.doctors;" 2 "Manager sees both reports' doctors"
expect_count "$HOG" "select count(*) from crm.doctors;" 3 "Head of Growth sees the whole universe"
expect_count "$CEO" "select count(*) from crm.doctors;" 3 "CEO sees the whole universe"

echo
echo "(b) Growth Executive cannot reach clinical data"
expect_error "$EXA" "select count(*) from public.patients;"  "permission denied" "public.patients is denied outright"
expect_error "$EXA" "select count(*) from public.diagnoses;" "permission denied" "public.diagnoses is denied outright"
expect_error "$EXA" "select notes from public.patients where id=1;" "permission denied" "patient clinical notes unreachable"
expect_count "$EXA" "select count(*) from crm.referral_clinical_notes;" 0 "clinical notes on own referral return zero rows"
expect_count "$CLN" "select count(*) from crm.referral_clinical_notes;" 1 "…while Clinical Team can read them"
expect_count "$EXA" "select patient_name from crm.v_referral_patients where patient_id=1;" "TestPatientOne" "identity-only patient view still works"
expect_error "$EXA" "select notes from crm.v_referral_patients;" "does not exist" "…and exposes no clinical column"
expect_count "$EXA" "select count(*) from crm.patient_consents;" 0 "consent records hidden from growth roles"
expect_count "$OPS" "select count(*) from crm.patient_consents;" 1 "…while Operations can see them"
expect_count "$EXA" "select count(*) from crm.revenue_records;" 0 "Exec A sees no revenue for another rep's doctor"
expect_count "$OPS" "select count(*) from crm.revenue_records;" 3 "…while Operations sees all three revenue rows"
expect_count "$EXA" "select count(*) from crm.doctor_practice;" 1 "Exec A sees practice intel for their doctor only"

echo
echo "(c) Hard DELETE fails everywhere"
expect_error "$EXA" "delete from crm.visits;"  "permission denied" "crm_app has no DELETE privilege (visits)"
expect_error "$EXA" "delete from crm.doctors;" "permission denied" "crm_app has no DELETE privilege (doctors)"
expect_error "$OPS" "delete from crm.doctor_referrals;" "permission denied" "…including for Operations"
expect_owner_error "delete from crm.doctors where id='aaaaaaaa-0000-0000-0000-000000000003';" \
  "Hard deletes are disabled" "owner DELETE is stopped by the trigger"
expect_owner_error "delete from crm.doctor_referrals where id='bbbbbbbb-0000-0000-0000-000000000001';" \
  "Hard deletes are disabled" "owner DELETE stopped on referrals too"

echo
echo "(d) NMC compliance guard rejects payment-shaped columns"
expect_owner_error "alter table crm.doctors add column referral_fee numeric;" \
  "NMC compliance" "ALTER TABLE ... referral_fee is rejected"
expect_owner_error "alter table crm.revenue_records add column commission_amount numeric;" \
  "NMC compliance" "commission_amount is rejected"
expect_owner_error "create table crm.payout_ledger (id uuid primary key, doctor_payout numeric);" \
  "NMC compliance" "a new payout table is rejected"
expect_owner_error "alter table crm.doctors add column incentive_rate numeric;" \
  "NMC compliance" "incentive_rate is rejected"
as_owner "alter table crm.doctors add column clinic_landmark text;" >/dev/null
got=$(as_owner "select count(*) from information_schema.columns where table_schema='crm' and table_name='doctors' and column_name='clinic_landmark';" | tr -d '[:space:]')
[ "$got" = "1" ] && ok "an innocuous column is still allowed (no false positives)" || bad "innocuous column should be allowed" "$got"
as_owner "alter table crm.doctors drop column clinic_landmark;" >/dev/null

echo
echo "(e) Write-path restrictions"
expect_count "$EXA" "with u as (update crm.referral_attributions set is_primary=true, status='verified', resolved_by='$EXA', resolved_at=now(), resolution_reason='mine' returning 1) select count(*) from u;" 0 "Exec A cannot resolve attribution conflicts"
expect_count "$HOG" "select claim_count from crm.v_attribution_conflicts;" 2 "the conflict queue surfaces the contested referral"
expect_count "$HOG" "with u as (update crm.referral_attributions set is_primary=true, status='verified', resolved_by='$HOG', resolved_at=now(), resolution_reason='confirmed at registration' where claimed_doctor_id='aaaaaaaa-0000-0000-0000-000000000001' returning 1) select count(*) from u;" 1 "…but the Head of Growth can"
expect_count "$HOG" "select count(*) from crm.v_attribution_conflicts;" 0 "…and the queue clears once resolved"
expect_error "$EXA" "insert into crm.revenue_records (hospital_id, amount_collected_inr, period_month) select id, 1000, date_trunc('month',now())::date from crm.hospitals;" \
  "row-level security" "Exec A cannot enter revenue"
expect_error "$EXA" "insert into crm.visits (hospital_id, doctor_id, executive_id, visit_type, occurred_at) select h.id,'aaaaaaaa-0000-0000-0000-000000000002','$EXA','in_person',now() from crm.hospitals h;" \
  "row-level security" "Exec A cannot log a visit against another rep's doctor"
expect_error "$EXA" "insert into crm.doctor_assignments (hospital_id, doctor_id, executive_id) select h.id,'aaaaaaaa-0000-0000-0000-000000000003','$EXA' from crm.hospitals h;" \
  "row-level security" "Exec A cannot assign doctors to themselves"
expect_error "$EXA" "select * from crm.assert_app_role();" "" "assert_app_role passes under crm_app"

echo
echo "(f) Data-integrity constraints"
expect_owner_error "update crm.doctor_referrals set status='lost' where id='bbbbbbbb-0000-0000-0000-000000000001';" \
  "referral_lost_reason_required" "status='lost' without a reason is rejected"
expect_owner_error "insert into crm.doctors (hospital_id, full_name, mobile) select id,'Dup','+919876500011' from crm.hospitals;" \
  "doctors_mobile_uniq" "duplicate normalised mobile is rejected"
expect_owner_error "insert into crm.doctor_assignments (hospital_id, doctor_id, executive_id) select id,'aaaaaaaa-0000-0000-0000-000000000001','$EXA' from crm.hospitals;" \
  "assignment_no_overlap" "overlapping ownership of one doctor is impossible"
got=$(as_owner "select crm.normalize_phone('98765 00011')||' '||crm.normalize_phone('+91 9876500012')||' '||crm.normalize_phone('09876500013');" | tr -d '[:space:]')
[ "$got" = "+919876500011+919876500012+919876500013" ] && ok "phone normalisation collapses all three input formats" || bad "phone normalisation" "$got"

echo
echo "(g) Reporting views"
D3=aaaaaaaa-0000-0000-0000-000000000003
expect_count "$HOG" "select referrals_mtd from crm.v_doctor_kpis where doctor_id='$D3';" 3 "KPI referral count does not fan out across revenue rows"
expect_count "$HOG" "select revenue_mtd_inr::int from crm.v_doctor_kpis where doctor_id='$D3';" 90000 "KPI revenue does not fan out across referral rows"
expect_count "$HOG" "select admissions_mtd from crm.v_doctor_kpis where doctor_id='$D3';" 1 "admissions counted once"
expect_count "$HOG" "select conversion_rate_pct from crm.v_doctor_kpis where doctor_id='$D3';" "66.7" "conversion rate = 2 of 3"
expect_count "$HOG" "select conversion_rate_pct from crm.v_doctor_kpis where doctor_id='aaaaaaaa-0000-0000-0000-000000000001';" "0.0" "0 percent, not NULL, when nothing converted"
expect_count "$HOG" "select due_state from crm.v_doctor_visit_due where doctor_id='aaaaaaaa-0000-0000-0000-000000000001';" "overdue" "A-doctor unvisited for 40 days is overdue"
expect_count "$HOG" "select due_state from crm.v_doctor_visit_due where doctor_id='$D3';" "never_visited" "never-visited doctor is flagged"
expect_count "$HOG" "select count(*) from crm.v_doctor_timeline where doctor_id='aaaaaaaa-0000-0000-0000-000000000001';" 2 "timeline merges visit + referral"
expect_count "$EXA" "select count(*) from crm.v_doctor_kpis;" 1 "views inherit RLS: Exec A sees one doctor's KPIs"

echo "(h) Attribution-unknown queue and table direction"
expect_count "$HOG" "select count(*) from crm.v_attribution_unknown;" 1 "unattended-path patient appears in the queue"
expect_count "$HOG" "select has_claimed_referral from crm.v_attribution_unknown;" "t" "…flagged as already having a rep-claimed referral"
as_owner "insert into crm.patient_referral_sources (hospital_id, patient_id, answer_type, captured_by) select id, 1, 'none_self', '66666666-6666-6666-6666-666666666666' from crm.hospitals;" >/dev/null
expect_count "$HOG" "select count(*) from crm.v_attribution_unknown;" 0 "a 'none/self' answer from registration clears it"
expect_error "$HOG" "select count(*) from crm.referrals;" "does not exist" "crm.referrals no longer exists after the rename"
expect_count "$HOG" "select count(*) from crm.doctor_referrals;" 5 "crm.doctor_referrals carries the data"
got=$(as_owner "select obj_description('crm.doctor_referrals'::regclass) ~ 'INBOUND';" | tr -d '[:space:]')
[ "$got" = "t" ] && ok "crm.doctor_referrals is labelled INBOUND" || bad "inbound comment" "$got"
as_owner "create table if not exists public.referrals (id serial primary key, patient_id int, doctor_name text);" >/dev/null
as_owner "do \$\$ begin if to_regclass('public.referrals') is not null then execute \$c\$comment on table public.referrals is 'OUTBOUND referral: a Gini doctor referring a patient OUT to an external specialist. Scribe clinical workflow. The inbound counterpart -- doctors sending patients TO Gini -- is crm.doctor_referrals.'\$c\$; end if; end \$\$;" >/dev/null
got=$(as_owner "select obj_description('public.referrals'::regclass) ~ 'OUTBOUND';" | tr -d '[:space:]')
[ "$got" = "t" ] && ok "public.referrals is labelled OUTBOUND" || bad "outbound comment" "$got"

echo
printf '  %s passed, %s failed\n\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
