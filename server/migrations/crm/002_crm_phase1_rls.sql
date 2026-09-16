-- =====================================================================
-- Gini Doctor Growth CRM — Phase 1, part 2
-- Triggers, grants, RLS policies, reporting views, compliance guard, seed
-- Migration: 002_crm_phase1_rls.sql      STATUS: PROPOSAL (not applied)
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 16. IDENTITY & AUTHORISATION PRIMITIVES
-- ---------------------------------------------------------------------
-- Dual-path identity. Scribe has no Supabase Auth today (it issues its own
-- JWT against public.doctors), so the Express layer sets crm.user_id per
-- transaction. If/when CRM users move to Supabase Auth, the first branch
-- starts working with no policy changes.
--
-- These live in 002 rather than 001 because SQL-language function bodies are
-- validated at CREATE time, so they must follow the tables they read.
create or replace function crm.current_user_id()
returns uuid language plpgsql stable security definer
set search_path = crm, public, pg_temp as $$
declare
  claim_sub uuid;
  guc       uuid;
begin
  begin
    claim_sub := nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
  exception when others then claim_sub := null;
  end;

  if claim_sub is not null then
    return (select u.id from crm.users u
            where u.supabase_user_id = claim_sub and u.deleted_at is null);
  end if;

  begin
    guc := nullif(current_setting('crm.user_id', true), '')::uuid;
  exception when others then guc := null;
  end;

  return guc;
end $$;

create or replace function crm.current_user_role()
returns crm.user_role language sql stable security definer
set search_path = crm, public, pg_temp as $$
  select u.role from crm.users u
  where u.id = crm.current_user_id() and u.deleted_at is null and u.is_active;
$$;

create or replace function crm.current_hospital_ids()
returns uuid[] language sql stable security definer
set search_path = crm, public, pg_temp as $$
  select coalesce(array_agg(m.hospital_id), '{}')
  from crm.user_hospitals m
  where m.user_id = crm.current_user_id();
$$;

-- Self + every descendant in the manager tree. SECURITY DEFINER, so
-- policies on crm.users can call it without recursing into their own RLS.
create or replace function crm.visible_user_ids()
returns uuid[] language sql stable security definer
set search_path = crm, public, pg_temp as $$
  with recursive tree as (
    select u.id from crm.users u where u.id = crm.current_user_id()
    union all
    select c.id from crm.users c join tree t on c.manager_id = t.id
    where c.deleted_at is null
  )
  select coalesce(array_agg(id), '{}') from tree;
$$;

create or replace function crm.sees_whole_universe()
returns boolean language sql stable as $$
  select crm.current_user_role() in ('ceo_admin','head_of_growth','operations');
$$;

create or replace function crm.can_access_doctor(p_doctor_id uuid)
returns boolean language sql stable security definer
set search_path = crm, public, pg_temp as $$
  select crm.sees_whole_universe()
      or exists (
        select 1 from crm.doctor_assignments a
        where a.doctor_id = p_doctor_id
          and a.effective_to is null
          and (   a.executive_id = any (crm.visible_user_ids())
               or a.manager_id   = any (crm.visible_user_ids()))
      );
$$;

-- ---------------------------------------------------------------------
-- 17. TRIGGER WIRING
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  -- updated_at on everything that has the column
  for t in
    select c.relname from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attname = 'updated_at'
    where n.nspname = 'crm' and c.relkind = 'r'
  loop
    execute format(
      'create trigger trg_%1$s_updated before update on crm.%1$I
         for each row execute function crm.set_updated_at()', t);
  end loop;

  -- Soft deletes only: block hard DELETE on every CRM table
  for t in
    select c.relname from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'crm' and c.relkind = 'r'
      and c.relname not in ('audit_log','schema_migrations')
  loop
    execute format(
      'create trigger trg_%1$s_no_delete before delete on crm.%1$I
         for each row execute function crm.block_hard_delete()', t);
  end loop;
end $$;

create trigger trg_doctors_stage_history
  after update of relationship_stage on crm.doctors
  for each row execute function crm.log_stage_change();

create trigger trg_journey_apply
  after insert on crm.referral_journey_events
  for each row execute function crm.apply_journey_event();

-- Audit trail on core entities
do $$
declare t text;
begin
  foreach t in array array[
    'doctors','doctor_practice','doctor_service_opportunities','doctor_assignments',
    'visits','doctor_referrals','referral_attributions','referral_journey_events',
    'patient_consents','patient_referral_sources','revenue_records','tasks',
    'users','user_hospitals','territories','service_lines','visit_cadence_policies']
  loop
    execute format(
      'create trigger trg_%1$s_audit after insert or update or delete on crm.%1$I
         for each row execute function crm.audit_row()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 18. GRANTS
-- ---------------------------------------------------------------------
-- No DELETE anywhere (soft deletes only). No write access to audit_log.
grant select, insert, update on all tables in schema crm to crm_app;
grant usage, select on all sequences in schema crm to crm_app;
grant execute on all functions in schema crm to crm_app;

revoke insert, update on crm.audit_log from crm_app;
grant  select            on crm.audit_log to crm_app;
revoke all on crm.schema_migrations from crm_app;

alter default privileges in schema crm
  grant select, insert, update on tables to crm_app;

-- ---------------------------------------------------------------------
-- 19. ROW LEVEL SECURITY
-- ---------------------------------------------------------------------
-- RLS is enabled on every table, so crm_app is always policy-bound.
--
-- FORCE (which subjects the table OWNER to policies too) is applied to every
-- table EXCEPT four. Those four are read or written by the authorisation
-- layer itself — the SECURITY DEFINER helpers run as the owner, and forcing
-- RLS on them would make crm.users' own policy call crm.current_user_role(),
-- which reads crm.users: infinite recursion. Excluding exactly these four
-- keeps owner-bypass confined to the machinery that decides access, while
-- every table holding CRM data stays forced.
--
--   crm.users, crm.user_hospitals  -> read by current_user_role/hospital_ids
--   crm.doctor_assignments         -> read by can_access_doctor()
--   crm.audit_log, crm.doctor_stage_history -> written by definer triggers
do $$
declare
  t text;
  unforced text[] := array['users','user_hospitals','doctor_assignments',
                           'audit_log','doctor_stage_history'];
begin
  for t in
    select c.relname from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'crm' and c.relkind = 'r'
      and c.relname <> 'schema_migrations'
  loop
    execute format('alter table crm.%I enable row level security', t);
    if not (t = any (unforced)) then
      execute format('alter table crm.%I force row level security', t);
    end if;
  end loop;
end $$;

-- Guard rail for the Express layer: refuses to run if a CRM request reached
-- the database without dropping to crm_app, which would silently bypass RLS
-- on the five unforced tables above.
create or replace function crm.assert_app_role()
returns void language plpgsql stable as $$
begin
  if current_user <> 'crm_app' then
    raise exception 'CRM queries must run as crm_app (current_user = %)', current_user
      using hint = 'Wrap the request in SET LOCAL ROLE crm_app; SET LOCAL crm.user_id = ...';
  end if;
end $$;

-- ---- Convenience predicates -----------------------------------------
create or replace function crm.in_my_hospital(p_hospital_id uuid)
returns boolean language sql stable as $$
  select p_hospital_id = any (crm.current_hospital_ids());
$$;

create or replace function crm.is_admin() returns boolean language sql stable as $$
  select crm.current_user_role() = 'ceo_admin';
$$;

create or replace function crm.is_growth_lead() returns boolean language sql stable as $$
  select crm.current_user_role() in ('ceo_admin','head_of_growth');
$$;

create or replace function crm.is_ops() returns boolean language sql stable as $$
  select crm.current_user_role() in ('ceo_admin','head_of_growth','operations');
$$;

-- ---- hospitals -------------------------------------------------------
create policy hospitals_read on crm.hospitals for select
  using (crm.in_my_hospital(id));
create policy hospitals_write on crm.hospitals for all
  using (crm.is_admin() and crm.in_my_hospital(id))
  with check (crm.is_admin() and crm.in_my_hospital(id));

-- ---- users -----------------------------------------------------------
-- Self, own reporting tree, or leadership. visible_user_ids() is
-- SECURITY DEFINER so this policy does not recurse into itself.
create policy users_read on crm.users for select
  using (
    crm.is_growth_lead()
    or id = any (crm.visible_user_ids())
    or exists (select 1 from crm.user_hospitals uh
               where uh.user_id = crm.users.id
                 and crm.in_my_hospital(uh.hospital_id)
                 and crm.current_user_role() = 'operations')
  );
create policy users_write on crm.users for all
  using (crm.is_growth_lead()) with check (crm.is_growth_lead());

create policy user_hospitals_read on crm.user_hospitals for select
  using (crm.is_growth_lead() or user_id = any (crm.visible_user_ids()));
create policy user_hospitals_write on crm.user_hospitals for all
  using (crm.is_growth_lead()) with check (crm.is_growth_lead());

-- ---- reference data (readable by all roles in the hospital) -----------
create policy territories_read on crm.territories for select
  using (crm.in_my_hospital(hospital_id));
create policy territories_write on crm.territories for all
  using (crm.is_growth_lead() and crm.in_my_hospital(hospital_id))
  with check (crm.is_growth_lead() and crm.in_my_hospital(hospital_id));

create policy service_lines_read on crm.service_lines for select
  using (crm.in_my_hospital(hospital_id));
create policy service_lines_write on crm.service_lines for all
  using (crm.is_growth_lead() and crm.in_my_hospital(hospital_id))
  with check (crm.is_growth_lead() and crm.in_my_hospital(hospital_id));

create policy cadence_read on crm.visit_cadence_policies for select
  using (crm.in_my_hospital(hospital_id));
create policy cadence_write on crm.visit_cadence_policies for all
  using (crm.is_growth_lead() and crm.in_my_hospital(hospital_id))
  with check (crm.is_growth_lead() and crm.in_my_hospital(hospital_id));

-- ---- doctors ---------------------------------------------------------
-- Executives and managers see only their assigned universe.
create policy doctors_read on crm.doctors for select
  using (crm.in_my_hospital(hospital_id) and crm.can_access_doctor(id));

-- Anyone in growth can add a doctor (field discovery); it lands unassigned.
create policy doctors_insert on crm.doctors for insert
  with check (
    crm.in_my_hospital(hospital_id)
    and crm.current_user_role() in
        ('ceo_admin','head_of_growth','growth_manager','growth_executive','operations')
  );

create policy doctors_update on crm.doctors for update
  using (crm.in_my_hospital(hospital_id) and crm.can_access_doctor(id))
  with check (crm.in_my_hospital(hospital_id) and crm.can_access_doctor(id));

create policy doctor_practice_read on crm.doctor_practice for select
  using (crm.in_my_hospital(hospital_id) and crm.can_access_doctor(doctor_id));
create policy doctor_practice_write on crm.doctor_practice for all
  using (crm.in_my_hospital(hospital_id) and crm.can_access_doctor(doctor_id))
  with check (crm.in_my_hospital(hospital_id) and crm.can_access_doctor(doctor_id));

create policy dso_read on crm.doctor_service_opportunities for select
  using (crm.in_my_hospital(hospital_id) and crm.can_access_doctor(doctor_id));
create policy dso_write on crm.doctor_service_opportunities for all
  using (crm.in_my_hospital(hospital_id) and crm.can_access_doctor(doctor_id))
  with check (crm.in_my_hospital(hospital_id) and crm.can_access_doctor(doctor_id));

create policy dsh_read on crm.doctor_stage_history for select
  using (crm.in_my_hospital(hospital_id) and crm.can_access_doctor(doctor_id));
-- written only by trigger (SECURITY DEFINER path); no insert policy for crm_app

-- ---- assignments -----------------------------------------------------
-- Reps can see who owns what; only managers and above can (re)assign.
create policy assignments_read on crm.doctor_assignments for select
  using (crm.in_my_hospital(hospital_id)
         and (crm.sees_whole_universe()
              or executive_id = any (crm.visible_user_ids())
              or manager_id   = any (crm.visible_user_ids())));
create policy assignments_write on crm.doctor_assignments for all
  using (crm.in_my_hospital(hospital_id)
         and crm.current_user_role() in ('ceo_admin','head_of_growth','growth_manager'))
  with check (crm.in_my_hospital(hospital_id)
         and crm.current_user_role() in ('ceo_admin','head_of_growth','growth_manager'));

-- ---- visits ----------------------------------------------------------
create policy visits_read on crm.visits for select
  using (crm.in_my_hospital(hospital_id)
         and (crm.sees_whole_universe()
              or executive_id = any (crm.visible_user_ids())
              or crm.can_access_doctor(doctor_id)));

-- A rep may only log a visit as themselves, against a doctor they own.
create policy visits_insert on crm.visits for insert
  with check (crm.in_my_hospital(hospital_id)
              and crm.can_access_doctor(doctor_id)
              and (executive_id = crm.current_user_id() or crm.is_growth_lead()));

-- Reps can correct their own visit for 24h; leads can always edit.
create policy visits_update on crm.visits for update
  using (crm.in_my_hospital(hospital_id)
         and (crm.is_growth_lead()
              or (executive_id = crm.current_user_id()
                  and created_at > now() - interval '24 hours')))
  with check (crm.in_my_hospital(hospital_id));

create policy visit_sl_read on crm.visit_service_lines for select
  using (exists (select 1 from crm.visits v where v.id = visit_id));
create policy visit_sl_write on crm.visit_service_lines for all
  using (exists (select 1 from crm.visits v where v.id = visit_id))
  with check (exists (select 1 from crm.visits v where v.id = visit_id));

create policy visit_att_read on crm.visit_attachments for select
  using (crm.in_my_hospital(hospital_id)
         and exists (select 1 from crm.visits v where v.id = visit_id));
create policy visit_att_write on crm.visit_attachments for all
  using (crm.in_my_hospital(hospital_id)
         and exists (select 1 from crm.visits v where v.id = visit_id))
  with check (crm.in_my_hospital(hospital_id)
         and exists (select 1 from crm.visits v where v.id = visit_id));

-- ---- referrals -------------------------------------------------------
-- Growth executives reach referrals through their doctor or their own
-- ownership. What they see is status-level: this table holds no clinical
-- content, and crm.referral_clinical_notes is closed to them below.
create policy doctor_referrals_read on crm.doctor_referrals for select
  using (crm.in_my_hospital(hospital_id)
         and (crm.is_ops()
              or crm.current_user_role() = 'clinical_team'
              or responsible_executive_id = any (crm.visible_user_ids())
              or (referring_doctor_id is not null
                  and crm.can_access_doctor(referring_doctor_id))));

create policy doctor_referrals_insert on crm.doctor_referrals for insert
  with check (crm.in_my_hospital(hospital_id)
              and crm.current_user_role() in
                  ('ceo_admin','head_of_growth','growth_manager','growth_executive','operations'));

-- Verification and attribution changes are leadership-only (§6 rule 5).
create policy doctor_referrals_update on crm.doctor_referrals for update
  using (crm.in_my_hospital(hospital_id)
         and (crm.is_ops()
              or responsible_executive_id = any (crm.visible_user_ids())
              or (referring_doctor_id is not null
                  and crm.can_access_doctor(referring_doctor_id))))
  with check (crm.in_my_hospital(hospital_id));

create policy attributions_read on crm.referral_attributions for select
  using (crm.in_my_hospital(hospital_id)
         and (crm.is_ops() or crm.can_access_doctor(claimed_doctor_id)));
create policy attributions_insert on crm.referral_attributions for insert
  with check (crm.in_my_hospital(hospital_id)
              and crm.can_access_doctor(claimed_doctor_id)
              and is_primary = false
              and status = 'claimed');
-- Only the Head of Growth (or CEO) resolves conflicts and marks the winner.
create policy attributions_resolve on crm.referral_attributions for update
  using (crm.in_my_hospital(hospital_id) and crm.is_growth_lead())
  with check (crm.in_my_hospital(hospital_id) and crm.is_growth_lead());

-- Clinical notes: growth roles have NO policy here, so they get zero rows.
create policy rcn_read on crm.referral_clinical_notes for select
  using (crm.in_my_hospital(hospital_id)
         and crm.current_user_role() in ('ceo_admin','clinical_team','operations'));
create policy rcn_write on crm.referral_clinical_notes for all
  using (crm.in_my_hospital(hospital_id)
         and crm.current_user_role() in ('ceo_admin','clinical_team'))
  with check (crm.in_my_hospital(hospital_id)
         and crm.current_user_role() in ('ceo_admin','clinical_team'));

-- ---- journey ---------------------------------------------------------
create policy journey_read on crm.referral_journey_events for select
  using (crm.in_my_hospital(hospital_id)
         and exists (select 1 from crm.doctor_referrals r where r.id = referral_id));
create policy journey_insert on crm.referral_journey_events for insert
  with check (crm.in_my_hospital(hospital_id)
              and crm.current_user_role() in
                  ('ceo_admin','head_of_growth','operations','clinical_team'));

-- ---- patient bridge, consent ----------------------------------------
create policy prs_read on crm.patient_referral_sources for select
  using (crm.in_my_hospital(hospital_id));
create policy prs_write on crm.patient_referral_sources for all
  using (crm.in_my_hospital(hospital_id) and crm.is_ops())
  with check (crm.in_my_hospital(hospital_id) and crm.is_ops());

create policy consents_read on crm.patient_consents for select
  using (crm.in_my_hospital(hospital_id)
         and crm.current_user_role() in
             ('ceo_admin','head_of_growth','operations','clinical_team'));
create policy consents_write on crm.patient_consents for all
  using (crm.in_my_hospital(hospital_id)
         and crm.current_user_role() in ('ceo_admin','operations','clinical_team'))
  with check (crm.in_my_hospital(hospital_id)
         and crm.current_user_role() in ('ceo_admin','operations','clinical_team'));

-- ---- revenue ---------------------------------------------------------
-- Executives see revenue for their own doctors only; ops enters it.
create policy revenue_read on crm.revenue_records for select
  using (crm.in_my_hospital(hospital_id)
         and (crm.is_ops()
              or (referring_doctor_id is not null
                  and crm.can_access_doctor(referring_doctor_id))));
create policy revenue_write on crm.revenue_records for all
  using (crm.in_my_hospital(hospital_id) and crm.is_ops())
  with check (crm.in_my_hospital(hospital_id) and crm.is_ops());

-- ---- tasks, saved views, import -------------------------------------
create policy tasks_read on crm.tasks for select
  using (crm.in_my_hospital(hospital_id)
         and (crm.sees_whole_universe()
              or owner_id   = any (crm.visible_user_ids())
              or created_by = crm.current_user_id()));
create policy tasks_write on crm.tasks for all
  using (crm.in_my_hospital(hospital_id)
         and (crm.sees_whole_universe()
              or owner_id   = any (crm.visible_user_ids())
              or created_by = crm.current_user_id()))
  with check (crm.in_my_hospital(hospital_id));

create policy saved_views_read on crm.saved_views for select
  using (crm.in_my_hospital(hospital_id)
         and (is_shared or owner_id = crm.current_user_id()));
create policy saved_views_write on crm.saved_views for all
  using (owner_id = crm.current_user_id() or crm.is_growth_lead())
  with check (crm.in_my_hospital(hospital_id)
              and (owner_id = crm.current_user_id() or crm.is_growth_lead()));

create policy import_batches_rw on crm.import_batches for all
  using (crm.in_my_hospital(hospital_id)
         and (crm.is_growth_lead() or uploaded_by = crm.current_user_id()))
  with check (crm.in_my_hospital(hospital_id)
         and (crm.is_growth_lead() or uploaded_by = crm.current_user_id()));

create policy import_rows_rw on crm.import_rows for all
  using (exists (select 1 from crm.import_batches b where b.id = batch_id))
  with check (exists (select 1 from crm.import_batches b where b.id = batch_id));

-- ---- audit -----------------------------------------------------------
create policy audit_read on crm.audit_log for select
  using (crm.is_growth_lead() and crm.in_my_hospital(hospital_id));

-- ---------------------------------------------------------------------
-- 20. REPORTING VIEWS (security_invoker: they inherit the caller's RLS)
-- ---------------------------------------------------------------------
create or replace view crm.v_doctor_current_assignment
  with (security_invoker = true) as
select a.doctor_id, a.executive_id, a.manager_id, a.territory_id,
       a.effective_from, ex.full_name as executive_name, t.name as territory_name
from crm.doctor_assignments a
left join crm.users ex on ex.id = a.executive_id
left join crm.territories t on t.id = a.territory_id
where a.effective_to is null;

-- Due / Upcoming / Overdue (§5)
create or replace view crm.v_doctor_visit_due
  with (security_invoker = true) as
with last_visit as (
  select doctor_id, max(occurred_at) as last_visit_at
  from crm.visits where deleted_at is null group by doctor_id
)
select d.id as doctor_id, d.hospital_id, d.full_name, d.priority,
       lv.last_visit_at,
       p.interval_days,
       (lv.last_visit_at + make_interval(days => p.interval_days))::date as next_due_on,
       case
         when lv.last_visit_at is null then 'never_visited'
         when now() > lv.last_visit_at + make_interval(days => p.interval_days + p.grace_days) then 'overdue'
         when now() >= lv.last_visit_at + make_interval(days => p.interval_days) then 'due'
         when now() >= lv.last_visit_at + make_interval(days => p.interval_days - 3) then 'upcoming'
         else 'ok'
       end::crm.visit_due_state as due_state
from crm.doctors d
left join last_visit lv on lv.doctor_id = d.id
left join crm.visit_cadence_policies p
       on p.hospital_id = d.hospital_id and p.priority = d.priority
where d.deleted_at is null and d.is_active;

-- Doctor 360 KPI cards (§8). Verified and claimed are never mixed (§6 rule 4).
--
-- Referrals and revenue are aggregated in separate CTEs and only then joined.
-- Joining both to crm.doctors in one query fans out into a cartesian product:
-- a doctor with 4 referrals and 3 revenue rows would report 12 referrals and
-- triple the revenue.
create or replace view crm.v_doctor_kpis
  with (security_invoker = true) as
with ref as (
  select r.referring_doctor_id as doctor_id,
         count(*) filter (where r.referred_at >= date_trunc('month', now())) as referrals_mtd,
         count(*) filter (where r.referred_at >= date_trunc('month', now())
                            and r.attribution_status = 'verified')            as referrals_mtd_verified,
         count(*) filter (where r.referred_at >= date_trunc('year', now()))   as referrals_ytd,
         count(*) filter (where r.status in ('admitted','procedure_completed','discharged')
                            and r.status_changed_at >= date_trunc('month', now())) as admissions_mtd,
         count(*) as referrals_total,
         count(*) filter (where r.status in ('consulted','admitted','procedure_completed',
                                             'discharged','follow_up','closed')) as converted_total,
         max(r.referred_at) as last_referral_at
  from crm.doctor_referrals r
  where r.deleted_at is null and r.referring_doctor_id is not null
  group by r.referring_doctor_id
),
rev as (
  select rv.referring_doctor_id as doctor_id,
         coalesce(sum(rv.amount_collected_inr)
                  filter (where rv.period_month >= date_trunc('month', now())::date), 0) as revenue_mtd_inr,
         coalesce(sum(rv.amount_collected_inr)
                  filter (where rv.period_month >= date_trunc('year', now())::date), 0)  as revenue_ytd_inr,
         coalesce(sum(rv.amount_collected_inr) filter (where rv.source = 'manual_ops'), 0) as revenue_manual_inr
  from crm.revenue_records rv
  where rv.deleted_at is null and rv.referring_doctor_id is not null
  group by rv.referring_doctor_id
)
select d.id as doctor_id, d.hospital_id,
       d.estimated_monthly_potential_inr as potential_revenue_inr,
       coalesce(ref.referrals_mtd, 0)           as referrals_mtd,
       coalesce(ref.referrals_mtd_verified, 0)  as referrals_mtd_verified,
       coalesce(ref.referrals_ytd, 0)           as referrals_ytd,
       coalesce(ref.admissions_mtd, 0)          as admissions_mtd,
       ref.last_referral_at,
       coalesce(rev.revenue_mtd_inr, 0)         as revenue_mtd_inr,
       coalesce(rev.revenue_ytd_inr, 0)         as revenue_ytd_inr,
       coalesce(rev.revenue_manual_inr, 0)      as revenue_manual_inr,
       -- 0.0 when a doctor has referrals but none converted; NULL only when
       -- they have no referrals at all, where a percentage is meaningless.
       round(100.0 * coalesce(ref.converted_total, 0)
             / nullif(ref.referrals_total, 0), 1) as conversion_rate_pct
from crm.doctors d
left join ref on ref.doctor_id = d.id
left join rev on rev.doctor_id = d.id
where d.deleted_at is null;

-- Doctor 360 timeline (§8)
create or replace view crm.v_doctor_timeline
  with (security_invoker = true) as
select v.doctor_id, v.hospital_id, v.occurred_at as event_at, 'visit' as event_type,
       coalesce(v.purpose, v.visit_type::text) as summary, v.id as source_id
from crm.visits v where v.deleted_at is null
union all
select r.referring_doctor_id, r.hospital_id, r.referred_at, 'referral',
       'Referral ' || r.referral_code || ' (' || r.attribution_status || ')', r.id
from crm.doctor_referrals r where r.deleted_at is null and r.referring_doctor_id is not null
union all
select r.referring_doctor_id, e.hospital_id, e.occurred_at, 'journey',
       'Patient ' || e.status::text, e.id
from crm.referral_journey_events e
join crm.doctor_referrals r on r.id = e.referral_id
where r.referring_doctor_id is not null
union all
select t.doctor_id, t.hospital_id, coalesce(t.completed_at, t.created_at), 'task',
       t.title, t.id
from crm.tasks t where t.deleted_at is null and t.doctor_id is not null;

-- Attribution-unknown queue.
--
-- Patients reach Scribe through five paths, and only the registration form has
-- a human present to ask "who referred you?". The quick-book form, consultation
-- save, and the HealthRay and Sheets sync jobs all insert patients unattended.
-- Those paths leave no crm.patient_referral_sources row at all, rather than
-- writing a misleading 'none_self' -- absence is the signal, and this view is
-- the work queue it feeds. Only the registration form records 'none_self',
-- which is a real answer from a real patient and therefore NOT surfaced here.
create or replace view crm.v_attribution_unknown
  with (security_invoker = true) as
select p.patient_id,
       p.patient_name,
       p.patient_phone,
       p.file_no,
       exists (select 1 from crm.doctor_referrals r
               where r.patient_id = p.patient_id and r.deleted_at is null) as has_claimed_referral,
       (select min(r.referred_at) from crm.doctor_referrals r
        where r.patient_id = p.patient_id and r.deleted_at is null) as first_referral_at
from crm.v_referral_patients p
left join crm.patient_referral_sources s on s.patient_id = p.patient_id
where s.id is null;

comment on view crm.v_attribution_unknown is
  'Patients with no recorded answer to "who referred you?" -- created through a '
  'path with no human present. Growth team work queue. A patient who answered '
  '"none/self" at registration has a row and does not appear here.';

-- Attribution conflict queue, owned by the Head of Growth (§6 rule 5)
create or replace view crm.v_attribution_conflicts
  with (security_invoker = true) as
select a.referral_id, r.referral_code, r.hospital_id,
       count(*) as claim_count,
       array_agg(d.full_name order by a.claimed_at) as claiming_doctors,
       min(a.claimed_at) as first_claim_at
from crm.referral_attributions a
join crm.doctor_referrals r on r.id = a.referral_id
join crm.doctors d   on d.id = a.claimed_doctor_id
where a.status in ('claimed','disputed') and r.deleted_at is null
group by a.referral_id, r.referral_code, r.hospital_id
having count(*) > 1;

grant select on all tables in schema crm to crm_app;

-- ---------------------------------------------------------------------
-- 21. COMPLIANCE GUARD (NMC fee-splitting)
-- ---------------------------------------------------------------------
-- Makes "no payout field, ever" structurally enforced rather than a comment
-- in a brief: any future migration that adds a payment-shaped column to the
-- crm schema fails loudly. Requires superuser to create the event trigger;
-- if Supabase refuses it, the same check runs in CI instead (see notes).
create or replace function crm.guard_no_payout_columns()
returns event_trigger language plpgsql as $$
declare
  r record;
  bad text;
begin
  for r in select * from pg_event_trigger_ddl_commands()
           where object_type in ('table','table column')
  loop
    select string_agg(format('%s.%s', c.relname, a.attname), ', ')
      into bad
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'crm' and a.attnum > 0 and not a.attisdropped
      and a.attname ~* '(commission|payout|payable|incentive|kickback|fee_split|referral_fee|bounty|remuneration)';

    if bad is not null then
      raise exception
        'NMC compliance: payment-shaped column(s) rejected in crm schema: %', bad
        using hint = 'Referral incentives are illegal under NMC ethics regulations. '
                     'This schema must contain no payout ledger of any kind.';
    end if;
  end loop;
end $$;

-- CREATE EVENT TRIGGER requires superuser, which Supabase does not grant to
-- `postgres`. Both migration files are wrapped in a transaction, so letting
-- this statement raise would roll back all of 002 and leave the tables from
-- 001 standing with NO row level security at all -- far worse than losing the
-- guard. Degrade to a warning instead; ci_compliance_check.sh covers the same
-- rule, and assertCrmIsolation() reports at boot when the trigger is absent.
do $$
begin
  execute $t$create event trigger crm_no_payout_columns
    on ddl_command_end
    when tag in ('CREATE TABLE','ALTER TABLE')
    execute function crm.guard_no_payout_columns()$t$;
  raise notice 'NMC guard: in-database event trigger installed.';
exception when others then
  raise warning 'NMC guard: event trigger could not be created (%: %). '
                'Falling back to ci_compliance_check.sh in CI.',
                sqlstate, sqlerrm;
end $$;

-- ---------------------------------------------------------------------
-- 22. SEED — Gini Advanced Care, territories, service lines, cadence
-- ---------------------------------------------------------------------
insert into crm.hospitals (name, code, city, state)
values ('Gini Advanced Care Hospital', 'GACH', 'Mohali', 'Punjab');

insert into crm.territories (hospital_id, name, code)
select h.id, t.name, t.code
from crm.hospitals h,
     (values ('Mohali','MOH'),('Chandigarh','CHD'),('Panchkula','PKL'),
             ('Kharar','KHR'),('Zirakpur','ZRK'),('Derabassi','DBS'),
             ('Ropar','RPR'),('Patiala','PTA')) as t(name, code)
where h.code = 'GACH';

insert into crm.service_lines (hospital_id, name, code, sort_order)
select h.id, s.name, s.code, s.ord
from crm.hospitals h,
     (values ('Internal Medicine','IM',1),('ICU / Critical Care','ICU',2),
             ('Diabetes / Endocrinology','ENDO',3),('Diabetic Foot','DFOOT',4),
             ('General Surgery','GSURG',5),('Laparoscopic Surgery','LAP',6),
             ('Orthopedics','ORTHO',7),('Neurology','NEURO',8),
             ('Neurosurgery','NSURG',9),('Pulmonology','PULM',10),
             ('Cardiology','CARD',11),('Nephrology','NEPH',12),
             ('Diagnostics','DIAG',13),('Day Care','DAYC',14),
             ('Emergency','EMER',15),('Other','OTHER',16)) as s(name, code, ord)
where h.code = 'GACH';

insert into crm.visit_cadence_policies (hospital_id, priority, interval_days)
select h.id, p.priority::crm.doctor_priority, p.days
from crm.hospitals h,
     (values ('A',15),('B',15),('C',45),('unclassified',60)) as p(priority, days)
where h.code = 'GACH';

insert into crm.schema_migrations (version) values ('001_crm_phase1'), ('002_crm_phase1_rls');

commit;
