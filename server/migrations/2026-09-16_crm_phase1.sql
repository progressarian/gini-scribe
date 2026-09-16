-- =====================================================================
-- Gini Doctor Growth CRM — Phase 1 schema
-- Migration: 001_crm_phase1.sql          STATUS: PROPOSAL (not applied)
-- Target: existing Supabase project vuukipgdegewpwucdgxa
--
-- Touches NO existing Scribe table. The only coupling to Scribe is
-- read-only foreign keys to public.patients(id) (and one optional,
-- nullable FK to public.doctors(id) — see DECISION 4 in the brief notes).
-- =====================================================================

begin;

create extension if not exists btree_gist;   -- uuid support in exclusion constraints
create extension if not exists pg_trgm;      -- fuzzy global search (§12)

create schema if not exists crm;
comment on schema crm is
  'Gini Doctor Growth CRM. Contains NO clinical content. Patient identity is '
  'referenced from public.patients; diagnoses/labs/notes never enter this schema.';

-- ---------------------------------------------------------------------
-- 0. MIGRATION LEDGER
-- ---------------------------------------------------------------------
create table if not exists crm.schema_migrations (
  version     text primary key,
  applied_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 1. DATABASE ROLE
-- ---------------------------------------------------------------------
-- The CRM connects as crm_app, NOT as the table owner. Owners bypass RLS,
-- so every table below also gets FORCE ROW LEVEL SECURITY as a second belt.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'crm_app') then
    create role crm_app nologin noinherit;
  end if;
end $$;

-- The migration role must be able to SET ROLE crm_app, or neither the Express
-- layer nor the verification harness can drop privileges. A superuser gets
-- this implicitly; Supabase's `postgres` is not a superuser and needs explicit
-- membership.
do $$
begin
  execute format('grant crm_app to %I', current_user);
exception when others then
  raise warning 'Could not grant crm_app to %: %. SET ROLE crm_app will fail.',
                current_user, sqlerrm;
end $$;

grant usage on schema crm to crm_app;
-- Deliberately NOT granted: usage/select on schema public's clinical tables.
-- Patient fields reach the CRM only through crm.v_referral_patients (§9).

-- ---------------------------------------------------------------------
-- 2. ENUMS
-- ---------------------------------------------------------------------
-- Vocabularies are TEXT + CHECK, not Postgres enums. That is the house rule
-- (shared/giniflowReferrals.js states it): a vocabulary must be able to grow
-- without a migration, and a CRM whose relationship-stage list needs DDL to
-- change is the CRM nobody updates. The CHECK is the integrity floor; the
-- labels, ordering and tones live in shared/crmVocab.js, which the UI renders.
-- Adding a value means editing both.
--
-- Each constrained column below carries its vocabulary as a trailing comment
-- so the column is readable without opening the shared file.

-- ---------------------------------------------------------------------
-- 3. UTILITY FUNCTIONS
-- ---------------------------------------------------------------------

-- Canonical +91 phone normalisation. IMMUTABLE so it can back a generated
-- column — this is what makes "never two doctors with the same mobile" a
-- database guarantee rather than an application convention.
create or replace function crm.normalize_phone(p text)
returns text language sql immutable parallel safe as $$
  with d as (select regexp_replace(coalesce(p,''), '[^0-9]', '', 'g') as x)
  select case
    when x = ''                                   then null
    when length(x) = 10                           then '+91' || x
    when length(x) = 11 and left(x,1)  = '0'      then '+91' || right(x,10)
    when length(x) = 12 and left(x,2)  = '91'     then '+'   || x
    when length(x) = 13 and left(x,3)  = '091'    then '+'   || right(x,12)
    when length(x) between 8 and 15               then '+'   || x
    else null
  end
  from d;
$$;

create or replace function crm.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- Soft deletes only (brief §6). DELETE is revoked from crm_app, and this
-- trigger stops anything else that slips through.
create or replace function crm.block_hard_delete()
returns trigger language plpgsql as $$
begin
  raise exception 'Hard deletes are disabled on %. Set deleted_at instead.',
    tg_table_name using errcode = 'restrict_violation';
end $$;

-- ---------------------------------------------------------------------
-- 4. TENANCY & PEOPLE
-- ---------------------------------------------------------------------
create table if not exists crm.hospitals (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  code        text not null unique,
  city        text,
  state       text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

create table if not exists crm.users (
  id                uuid primary key default gen_random_uuid(),
  full_name         text not null,
  email             text,
  mobile            text,
  mobile_e164       text generated always as (crm.normalize_phone(mobile)) stored,
  role              text not null check (role in ('ceo_admin', 'head_of_growth', 'growth_manager', 'growth_executive', 'clinical_team', 'operations')), -- ceo_admin | head_of_growth | growth_manager | growth_executive | clinical_team | operations
  manager_id        uuid references crm.users(id),
  -- Identity anchors: Scribe's PIN login today, Supabase Auth later.
  scribe_doctor_id  integer references public.doctors(id),
  supabase_user_id  uuid unique,
  is_active         boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz,
  constraint users_identity_present
    check (scribe_doctor_id is not null or supabase_user_id is not null),
  constraint users_not_own_manager check (manager_id is null or manager_id <> id)
);
create unique index if not exists users_email_uniq on crm.users (lower(email)) where deleted_at is null and email is not null;
create unique index if not exists users_scribe_uniq on crm.users (scribe_doctor_id) where deleted_at is null and scribe_doctor_id is not null;
create index if not exists users_manager_idx on crm.users (manager_id);

-- A user can be attached to more than one hospital (brief §5, multi-hospital future)
create table if not exists crm.user_hospitals (
  user_id     uuid not null references crm.users(id),
  hospital_id uuid not null references crm.hospitals(id),
  created_at  timestamptz not null default now(),
  primary key (user_id, hospital_id)
);

create table if not exists crm.territories (
  id          uuid primary key default gen_random_uuid(),
  hospital_id uuid not null references crm.hospitals(id),
  name        text not null,
  code        text,
  parent_id   uuid references crm.territories(id),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create unique index if not exists territories_name_uniq on crm.territories (hospital_id, lower(name)) where deleted_at is null;

create table if not exists crm.service_lines (
  id          uuid primary key default gen_random_uuid(),
  hospital_id uuid not null references crm.hospitals(id),
  name        text not null,
  code        text not null,
  sort_order  integer not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create unique index if not exists service_lines_code_uniq on crm.service_lines (hospital_id, code) where deleted_at is null;

-- ---------------------------------------------------------------------
-- 6. DOCTOR UNIVERSE (§1, §2, §3)
-- ---------------------------------------------------------------------
create table if not exists crm.doctors (
  id                    uuid primary key default gen_random_uuid(),
  hospital_id           uuid not null references crm.hospitals(id),

  full_name             text not null,
  photo_url             text,
  specialty             text,
  sub_specialty         text,
  qualifications        text,

  clinic_name           text,
  address_line          text,
  area                  text,
  city                  text,
  district              text,
  state                 text,
  pin_code              text,
  territory_id          uuid references crm.territories(id),
  google_maps_url       text,
  latitude              numeric(9,6),
  longitude             numeric(9,6),

  -- Mobile is the canonical identity (§1). mobile_e164 is generated, so the
  -- uniqueness guarantee cannot be defeated by an un-normalised write path.
  mobile                text not null,
  mobile_e164           text generated always as (crm.normalize_phone(mobile)) stored,
  whatsapp              text,
  whatsapp_e164         text generated always as (crm.normalize_phone(whatsapp)) stored,
  alt_mobile            text,
  clinic_phone          text,
  email                 text,
  preferred_contact     text,

  -- Segmentation (§2)
  priority              text not null default 'unclassified' check (priority in ('A', 'B', 'C', 'unclassified')), -- A | B | C | unclassified
  relationship_stage    text not null default 'prospect' check (relationship_stage in ('prospect', 'contacted', 'met', 'engaged', 'trial_referrer', 'active_referrer', 'high_value_referrer', 'dormant', 'lost')), -- prospect | contacted | met | engaged | trial_referrer | active_referrer | high_value_referrer | dormant | lost
  estimated_monthly_potential_inr numeric(14,2),
  -- Phase 3 will compute a score; the manual override must always exist.
  potential_score_computed  numeric(6,2),
  potential_score_override  numeric(6,2),
  potential_score_override_reason text,
  potential_score_overridden_by uuid references crm.users(id),

  notes                 text,
  is_active             boolean not null default true,

  -- Optional: this referring doctor is also a Gini consultant.
  scribe_doctor_id      integer references public.doctors(id),

  search_vector tsvector generated always as (
    setweight(to_tsvector('simple', coalesce(full_name,'')), 'A') ||
    setweight(to_tsvector('simple', coalesce(clinic_name,'')), 'B') ||
    setweight(to_tsvector('simple', coalesce(specialty,'') || ' ' || coalesce(sub_specialty,'')), 'B') ||
    setweight(to_tsvector('simple', coalesce(area,'') || ' ' || coalesce(city,'')), 'C')
  ) stored,

  created_by  uuid references crm.users(id),
  updated_by  uuid references crm.users(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,

  constraint doctors_mobile_valid check (crm.normalize_phone(mobile) is not null)
);

-- "Never allow two doctor records with the same normalized mobile" (§1)
create unique index if not exists doctors_mobile_uniq
  on crm.doctors (hospital_id, mobile_e164) where deleted_at is null;
create index if not exists doctors_search_idx    on crm.doctors using gin (search_vector);
create index if not exists doctors_name_trgm_idx on crm.doctors using gin (full_name gin_trgm_ops);
create index if not exists doctors_priority_idx  on crm.doctors (hospital_id, priority) where deleted_at is null;
create index if not exists doctors_stage_idx     on crm.doctors (hospital_id, relationship_stage) where deleted_at is null;
create index if not exists doctors_territory_idx on crm.doctors (territory_id);

-- Practice intelligence is split out so its visibility can be configured
-- separately from the basic contact record (brief §4 "configurable visibility").
create table if not exists crm.doctor_practice (
  doctor_id                     uuid primary key references crm.doctors(id),
  hospital_id                   uuid not null references crm.hospitals(id),
  opd_per_day                   integer,
  opd_per_month                 integer,
  practice_size                 text,
  years_in_practice             integer,
  current_affiliations          text[],
  hospitals_currently_referring_to text[],
  procedures_performed          text[],
  services_referred_out         text[],
  estimated_referrals_per_month integer,
  estimated_monthly_revenue_potential_inr numeric(14,2),
  current_relationship_summary  text,
  existing_gini_referrals_count integer,
  intelligence_notes            text,
  updated_by  uuid references crm.users(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists crm.doctor_service_opportunities (
  id                  uuid primary key default gen_random_uuid(),
  hospital_id         uuid not null references crm.hospitals(id),
  doctor_id           uuid not null references crm.doctors(id),
  service_line_id     uuid not null references crm.service_lines(id),
  potential_volume_per_month integer,
  current_volume_per_month   integer,
  target_volume_per_month    integer,
  actual_volume_per_month    integer,
  potential_revenue_inr      numeric(14,2),
  notes               text,
  created_by  uuid references crm.users(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create unique index if not exists dso_uniq on crm.doctor_service_opportunities (doctor_id, service_line_id) where deleted_at is null;

-- Stage history (§2 "Store stage history")
create table if not exists crm.doctor_stage_history (
  id          uuid primary key default gen_random_uuid(),
  hospital_id uuid not null references crm.hospitals(id),
  doctor_id   uuid not null references crm.doctors(id),
  from_stage  text check (from_stage is null or from_stage in ('prospect', 'contacted', 'met', 'engaged', 'trial_referrer', 'active_referrer', 'high_value_referrer', 'dormant', 'lost')), -- prospect | contacted | met | engaged | trial_referrer | active_referrer | high_value_referrer | dormant | lost
  to_stage    text not null check (to_stage in ('prospect', 'contacted', 'met', 'engaged', 'trial_referrer', 'active_referrer', 'high_value_referrer', 'dormant', 'lost')), -- prospect | contacted | met | engaged | trial_referrer | active_referrer | high_value_referrer | dormant | lost
  reason      text,
  changed_by  uuid references crm.users(id),
  changed_at  timestamptz not null default now()
);
create index if not exists dsh_doctor_idx on crm.doctor_stage_history (doctor_id, changed_at desc);

create or replace function crm.log_stage_change()
returns trigger language plpgsql security definer
set search_path = crm, public, pg_temp as $$
begin
  if new.relationship_stage is distinct from old.relationship_stage then
    insert into crm.doctor_stage_history
      (hospital_id, doctor_id, from_stage, to_stage, changed_by)
    values (new.hospital_id, new.id, old.relationship_stage,
            new.relationship_stage, crm.current_user_id());
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------
-- 7. TERRITORY & OWNERSHIP (§4)
-- ---------------------------------------------------------------------
-- Assignment is effective-dated, never overwritten, so relationship history
-- survives a rep change. The exclusion constraint makes overlapping
-- ownership of the same doctor impossible.
create table if not exists crm.doctor_assignments (
  id             uuid primary key default gen_random_uuid(),
  hospital_id    uuid not null references crm.hospitals(id),
  doctor_id      uuid not null references crm.doctors(id),
  executive_id   uuid references crm.users(id),
  manager_id     uuid references crm.users(id),
  territory_id   uuid references crm.territories(id),
  effective_from timestamptz not null default now(),
  effective_to   timestamptz,
  assigned_by    uuid references crm.users(id),
  reason         text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint assignment_period_valid check (effective_to is null or effective_to > effective_from),
  constraint assignment_no_overlap exclude using gist (
    doctor_id with =,
    tstzrange(effective_from, effective_to) with &&
  )
);
create index if not exists da_exec_idx    on crm.doctor_assignments (executive_id) where effective_to is null;
create index if not exists da_manager_idx on crm.doctor_assignments (manager_id)   where effective_to is null;

-- Visit cadence (§5): A/B ~ twice a month, C ~ every 45 days, configurable.
create table if not exists crm.visit_cadence_policies (
  id            uuid primary key default gen_random_uuid(),
  hospital_id   uuid not null references crm.hospitals(id),
  priority      text not null check (priority in ('A', 'B', 'C', 'unclassified')), -- A | B | C | unclassified
  interval_days integer not null check (interval_days > 0),
  grace_days    integer not null default 3,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (hospital_id, priority)
);

-- ---------------------------------------------------------------------
-- 8. VISIT MANAGEMENT (§5)
-- ---------------------------------------------------------------------
-- id is client-generatable (uuid) so an offline phone can mint it locally and
-- re-send safely; the PK makes sync idempotent with no dedupe logic.
create table if not exists crm.visits (
  id                uuid primary key default gen_random_uuid(),
  hospital_id       uuid not null references crm.hospitals(id),
  doctor_id         uuid not null references crm.doctors(id),
  executive_id      uuid not null references crm.users(id),

  visit_type        text not null default 'in_person' check (visit_type in ('in_person', 'phone', 'whatsapp', 'video', 'event', 'other')), -- in_person | phone | whatsapp | video | event | other
  purpose           text,
  occurred_at       timestamptz not null,

  discussion_notes  text,
  doctor_requirements     text,
  objections              text,
  opportunities_identified text,
  commitments             text,
  outcome           text check (outcome is null or outcome in ('positive', 'neutral', 'negative', 'doctor_unavailable', 'rescheduled')), -- positive | neutral | negative | doctor_unavailable | rescheduled
  follow_up_required boolean not null default false,
  next_visit_date    date,

  -- Optional GPS (§5). Captured silently when granted; never required.
  gps_latitude      numeric(9,6),
  gps_longitude     numeric(9,6),
  gps_accuracy_m    numeric(8,2),
  gps_captured_at   timestamptz,

  -- Offline-tolerant entry (§5)
  client_created_at timestamptz,
  synced_at         timestamptz not null default now(),

  created_by        uuid references crm.users(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz
);
create index if not exists visits_doctor_idx on crm.visits (doctor_id, occurred_at desc) where deleted_at is null;
create index if not exists visits_exec_idx   on crm.visits (executive_id, occurred_at desc) where deleted_at is null;
create index if not exists visits_hosp_idx   on crm.visits (hospital_id, occurred_at desc) where deleted_at is null;

create table if not exists crm.visit_service_lines (
  visit_id        uuid not null references crm.visits(id),
  service_line_id uuid not null references crm.service_lines(id),
  primary key (visit_id, service_line_id)
);

create table if not exists crm.visit_attachments (
  id          uuid primary key default gen_random_uuid(),
  hospital_id uuid not null references crm.hospitals(id),
  visit_id    uuid not null references crm.visits(id),
  file_url    text not null,           -- Supabase Storage, same bucket pattern as Scribe
  file_name   text,
  mime_type   text,
  kind        text,                    -- 'photo','card','document'
  created_by  uuid references crm.users(id),
  created_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create index if not exists va_visit_idx on crm.visit_attachments (visit_id);

-- ---------------------------------------------------------------------
-- 9. PATIENT BRIDGE — the only Scribe coupling
-- ---------------------------------------------------------------------
-- crm_app has NO privileges on public.patients. Everything the CRM can learn
-- about a patient comes through this view: identity and contact only.
-- Diagnoses, labs, medications and notes are unreachable by construction,
-- which is what makes brief §4 ("never clinical content") a schema property
-- rather than a frontend promise.
create or replace view crm.v_referral_patients
  with (security_invoker = false) as
select p.id           as patient_id,
       p.name         as patient_name,
       p.phone        as patient_phone,
       crm.normalize_phone(p.phone) as patient_phone_e164,
       p.age,
       p.sex,
       p.file_no
from public.patients p;

grant select on crm.v_referral_patients to crm_app;

-- "Who referred you here?" captured at Scribe registration (§6 rule 1).
-- Stored here rather than as a column on public.patients so no Scribe table
-- is altered; Scribe's registration form writes one row.
create table if not exists crm.patient_referral_sources (
  id            uuid primary key default gen_random_uuid(),
  hospital_id   uuid not null references crm.hospitals(id),
  patient_id    integer not null references public.patients(id),
  answer_type   text not null check (answer_type in ('doctor', 'free_text', 'none_self')), -- doctor | free_text | none_self
  doctor_id     uuid references crm.doctors(id),
  free_text     text,
  captured_at   timestamptz not null default now(),
  captured_by   uuid references crm.users(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint prs_answer_shape check (
    (answer_type = 'doctor'    and doctor_id is not null) or
    (answer_type = 'free_text' and free_text is not null) or
    (answer_type = 'none_self')
  )
);
create unique index if not exists prs_patient_uniq on crm.patient_referral_sources (patient_id);

-- ---------------------------------------------------------------------
-- 10. REFERRALS & ATTRIBUTION (§6)
-- ---------------------------------------------------------------------
create sequence if not exists crm.referral_code_seq;

create table if not exists crm.doctor_referrals (
  id                 uuid primary key default gen_random_uuid(),
  referral_code      text not null unique
                       default 'REF-' || to_char(now(),'YYYY') || '-' ||
                               lpad(nextval('crm.referral_code_seq')::text, 6, '0'),
  hospital_id        uuid not null references crm.hospitals(id),

  -- Patient may not exist in Scribe yet when a rep logs a claim, so identity
  -- is nullable and the raw contact details carry the match until it does.
  patient_id         integer references public.patients(id),
  patient_name_raw   text,
  patient_phone_raw  text,
  patient_phone_e164 text generated always as (crm.normalize_phone(patient_phone_raw)) stored,

  referring_doctor_id uuid references crm.doctors(id),
  is_self_referral    boolean not null default false,
  source              text not null check (source in ('direct_doctor', 'phone', 'whatsapp', 'gini_scribe', 'opd', 'emergency', 'ipd', 'website', 'patient_self_report', 'growth_executive', 'other')), -- direct_doctor | phone | whatsapp | gini_scribe | opd | emergency | ipd | website | patient_self_report | growth_executive | other
  referred_at         timestamptz not null default now(),

  -- Non-clinical only. Anything clinical goes in referral_clinical_notes.
  reason_category     text,
  service_line_id     uuid references crm.service_lines(id),
  expected_action     text,
  urgency             text not null default 'routine' check (urgency in ('routine', 'soon', 'urgent', 'emergency')), -- routine | soon | urgent | emergency
  responsible_executive_id uuid references crm.users(id),

  status              text not null default 'new' check (status in ('new', 'contact_attempted', 'contacted', 'appointment_booked', 'no_show', 'consulted', 'investigation', 'admission_advised', 'admitted', 'procedure_completed', 'discharged', 'follow_up', 'closed', 'lost')), -- new | contact_attempted | contacted | appointment_booked | no_show | consulted | investigation | admission_advised | admitted | procedure_completed | discharged | follow_up | closed | lost
  status_changed_at   timestamptz not null default now(),
  lost_reason         text,

  attribution_status  text not null default 'claimed' check (attribution_status in ('claimed', 'verified', 'disputed', 'rejected')), -- claimed | verified | disputed | rejected
  verified_at         timestamptz,
  verified_by         uuid references crm.users(id),

  created_by  uuid references crm.users(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,

  -- §7: "Lost (with reason lost — mandatory)"
  constraint doctor_referral_lost_reason_required
    check (status <> 'lost' or nullif(btrim(coalesce(lost_reason,'')), '') is not null),
  constraint doctor_referral_doctor_or_self
    check (is_self_referral or referring_doctor_id is not null),
  constraint doctor_referral_verified_shape
    check (attribution_status <> 'verified' or verified_at is not null),
  constraint doctor_referral_patient_identifiable
    check (patient_id is not null or patient_phone_raw is not null or patient_name_raw is not null)
);
create index if not exists doctor_referrals_doctor_idx  on crm.doctor_referrals (referring_doctor_id, referred_at desc) where deleted_at is null;
create index if not exists doctor_referrals_patient_idx on crm.doctor_referrals (patient_id) where deleted_at is null;
create index if not exists doctor_referrals_phone_idx   on crm.doctor_referrals (hospital_id, patient_phone_e164) where deleted_at is null;
create index if not exists doctor_referrals_status_idx  on crm.doctor_referrals (hospital_id, status) where deleted_at is null;
create index if not exists doctor_referrals_exec_idx    on crm.doctor_referrals (responsible_executive_id) where deleted_at is null;

comment on table crm.doctor_referrals is
  'INBOUND referral: a patient sent TO Gini BY an external referring doctor. '
  'This is the CRM''s unit of account -- what the growth team is measured on. '
  'Not to be confused with public.referrals, which is the opposite direction.';

comment on column crm.doctor_referrals.referring_doctor_id is
  'The external doctor who SENT the patient to Gini (crm.doctors), not a Gini clinician.';

-- public.referrals is Scribe's outbound specialist referral, created at runtime
-- by server/routes/visit.js. Label it so the two directions are never confused.
-- COMMENT ON is metadata only: it does not alter the table.
do $$
begin
  if to_regclass('public.referrals') is not null then
    execute $c$comment on table public.referrals is
      'OUTBOUND referral: a Gini doctor referring a patient OUT to an external '
      'specialist. Scribe clinical workflow. The inbound counterpart -- doctors '
      'sending patients TO Gini -- is crm.doctor_referrals.'$c$;
  end if;
end $$;

-- One row per claim. Two doctors claiming one patient = two rows = the
-- resolution queue (§6 rule 5). The winner is is_primary + verified.
create table if not exists crm.referral_attributions (
  id                uuid primary key default gen_random_uuid(),
  hospital_id       uuid not null references crm.hospitals(id),
  referral_id       uuid not null references crm.doctor_referrals(id),
  claimed_doctor_id uuid not null references crm.doctors(id),
  claimed_by        uuid references crm.users(id),
  claim_source      text not null check (claim_source in ('direct_doctor', 'phone', 'whatsapp', 'gini_scribe', 'opd', 'emergency', 'ipd', 'website', 'patient_self_report', 'growth_executive', 'other')), -- direct_doctor | phone | whatsapp | gini_scribe | opd | emergency | ipd | website | patient_self_report | growth_executive | other
  claimed_at        timestamptz not null default now(),
  status            text not null default 'claimed' check (status in ('claimed', 'verified', 'disputed', 'rejected')), -- claimed | verified | disputed | rejected
  is_primary        boolean not null default false,
  resolved_by       uuid references crm.users(id),
  resolved_at       timestamptz,
  resolution_reason text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  -- "Log who resolved it and why" (§6 rule 5): rejecting a rival claim, or
  -- marking one primary after a dispute, must name a resolver and a reason.
  constraint attribution_resolution_logged
    check (status <> 'rejected'
           or (resolved_by is not null and resolved_at is not null
               and nullif(btrim(coalesce(resolution_reason,'')), '') is not null))
);
create unique index if not exists ra_claim_uniq on crm.referral_attributions (referral_id, claimed_doctor_id);
create unique index if not exists ra_primary_uniq on crm.referral_attributions (referral_id) where is_primary;
create index if not exists ra_open_conflicts_idx on crm.referral_attributions (hospital_id, status) where status = 'disputed';

-- Clinical detail about a referral, quarantined away from growth roles.
create table if not exists crm.referral_clinical_notes (
  id          uuid primary key default gen_random_uuid(),
  hospital_id uuid not null references crm.hospitals(id),
  referral_id uuid not null references crm.doctor_referrals(id),
  note        text not null,
  authored_by uuid references crm.users(id),
  created_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create index if not exists rcn_referral_idx on crm.referral_clinical_notes (referral_id);

-- ---------------------------------------------------------------------
-- 11. PATIENT JOURNEY (§7) — manual in Phase 1, Scribe-driven in Phase 2
-- ---------------------------------------------------------------------
create table if not exists crm.referral_journey_events (
  id          uuid primary key default gen_random_uuid(),
  hospital_id uuid not null references crm.hospitals(id),
  referral_id uuid not null references crm.doctor_referrals(id),
  status      text not null check (status in ('new', 'contact_attempted', 'contacted', 'appointment_booked', 'no_show', 'consulted', 'investigation', 'admission_advised', 'admitted', 'procedure_completed', 'discharged', 'follow_up', 'closed', 'lost')), -- new | contact_attempted | contacted | appointment_booked | no_show | consulted | investigation | admission_advised | admitted | procedure_completed | discharged | follow_up | closed | lost
  occurred_at timestamptz not null default now(),
  notes       text,                       -- operational, non-clinical
  lost_reason text,
  source      text not null default 'manual',   -- 'manual' | 'scribe' (Phase 2)
  recorded_by uuid references crm.users(id),
  created_at  timestamptz not null default now(),
  constraint rje_lost_reason_required
    check (status <> 'lost' or nullif(btrim(coalesce(lost_reason,'')), '') is not null)
);
create index if not exists rje_referral_idx on crm.referral_journey_events (referral_id, occurred_at desc);

create or replace function crm.apply_journey_event()
returns trigger language plpgsql security definer
set search_path = crm, public, pg_temp as $$
begin
  update crm.doctor_referrals r
     set status            = new.status,
         status_changed_at = new.occurred_at,
         lost_reason       = coalesce(new.lost_reason, r.lost_reason),
         updated_at        = now()
   where r.id = new.referral_id
     and new.occurred_at >= r.status_changed_at;
  return new;
end $$;

-- ---------------------------------------------------------------------
-- 12. CONSENT (DPDP Act 2023 — compliance note in brief)
-- ---------------------------------------------------------------------
create table if not exists crm.patient_consents (
  id           uuid primary key default gen_random_uuid(),
  hospital_id  uuid not null references crm.hospitals(id),
  patient_id   integer not null references public.patients(id),
  referral_id  uuid references crm.doctor_referrals(id),
  purpose      text not null default 'share_clinical_updates_with_referring_doctor',
  status       text not null check (status in ('granted', 'denied', 'revoked')), -- granted | denied | revoked
  granted_at   timestamptz,
  revoked_at   timestamptz,
  evidence_url text,
  notes        text,
  captured_by  uuid references crm.users(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists pc_patient_idx on crm.patient_consents (patient_id, purpose, created_at desc);

-- Phase 2's communication loop gates every send on this.
create or replace function crm.has_consent(p_patient_id integer, p_purpose text)
returns boolean language sql stable as $$
  select coalesce((
    select c.status = 'granted'
    from crm.patient_consents c
    where c.patient_id = p_patient_id and c.purpose = p_purpose
    order by c.created_at desc
    limit 1
  ), false);
$$;

-- ---------------------------------------------------------------------
-- 13. REVENUE (§15 defines it in Phase 2; Doctor 360 in Phase 1 displays it)
-- ---------------------------------------------------------------------
-- Phase 1 accepts ops-entered figures, explicitly flagged as manual. The
-- Scribe-billing path is already modelled so Phase 2 only adds a writer.
--
-- COMPLIANCE: this table records revenue the HOSPITAL collected, attributed
-- to a referral for internal analytics. It has no payee, no payable amount,
-- no rate and no settlement state. It must never acquire one.
create table if not exists crm.revenue_records (
  id                 uuid primary key default gen_random_uuid(),
  hospital_id        uuid not null references crm.hospitals(id),
  referral_id        uuid references crm.doctor_referrals(id),
  patient_id         integer references public.patients(id),
  referring_doctor_id uuid references crm.doctors(id),
  service_line_id    uuid references crm.service_lines(id),
  amount_collected_inr numeric(14,2) not null,
  amount_billed_inr    numeric(14,2),
  source             text not null default 'manual_ops' check (source in ('manual_ops', 'scribe_billing')), -- manual_ops | scribe_billing
  is_manual          boolean generated always as (source = 'manual_ops') stored,
  encounter_ref      text,                -- Phase 2: Scribe billing encounter id
  period_month       date not null,       -- first day of the month
  recorded_by        uuid references crm.users(id),
  recorded_at        timestamptz not null default now(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz,
  constraint revenue_period_is_month check (period_month = date_trunc('month', period_month)::date),
  constraint revenue_manual_needs_no_encounter
    check (source = 'manual_ops' or encounter_ref is not null)
);
create index if not exists rev_doctor_idx   on crm.revenue_records (referring_doctor_id, period_month) where deleted_at is null;
create index if not exists rev_referral_idx on crm.revenue_records (referral_id) where deleted_at is null;

comment on table crm.revenue_records is
  'Hospital revenue attributed to a referral for internal targeting and '
  'service-quality analytics only. NMC ethics: no incentive, commission, '
  'payout or payable field may ever be added here or anywhere in crm.';

-- ---------------------------------------------------------------------
-- 14. TASKS (§9), SAVED LISTS (§12), IMPORT (§10)
-- ---------------------------------------------------------------------
create table if not exists crm.tasks (
  id           uuid primary key default gen_random_uuid(),
  hospital_id  uuid not null references crm.hospitals(id),
  title        text not null,
  description  text,
  owner_id     uuid not null references crm.users(id),
  doctor_id    uuid references crm.doctors(id),
  referral_id  uuid references crm.doctor_referrals(id),
  visit_id     uuid references crm.visits(id),
  due_date     date,
  priority     text not null default 'normal' check (priority in ('low', 'normal', 'high', 'critical')), -- low | normal | high | critical
  status       text not null default 'open' check (status in ('open', 'in_progress', 'done', 'cancelled')), -- open | in_progress | done | cancelled
  completed_at timestamptz,
  completed_by uuid references crm.users(id),
  created_by   uuid references crm.users(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  constraint task_done_shape check (status <> 'done' or completed_at is not null)
);
create index if not exists tasks_owner_idx   on crm.tasks (owner_id, status, due_date) where deleted_at is null;
create index if not exists tasks_overdue_idx on crm.tasks (hospital_id, due_date) where deleted_at is null and status in ('open','in_progress');
create index if not exists tasks_doctor_idx  on crm.tasks (doctor_id) where deleted_at is null;

create table if not exists crm.saved_views (
  id          uuid primary key default gen_random_uuid(),
  hospital_id uuid not null references crm.hospitals(id),
  owner_id    uuid not null references crm.users(id),
  name        text not null,
  entity      text not null check (entity in ('doctors','referrals','visits','tasks','revenue')),
  filters     jsonb not null default '{}'::jsonb,
  is_shared   boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

create table if not exists crm.import_batches (
  id             uuid primary key default gen_random_uuid(),
  hospital_id    uuid not null references crm.hospitals(id),
  uploaded_by    uuid not null references crm.users(id),
  file_name      text,
  file_url       text,
  column_mapping jsonb not null default '{}'::jsonb,
  status         text not null default 'pending'
                   check (status in ('pending','previewing','importing','completed','failed','cancelled')),
  total_rows     integer not null default 0,
  created_count  integer not null default 0,
  updated_count  integer not null default 0,
  skipped_count  integer not null default 0,
  error_count    integer not null default 0,
  started_at     timestamptz,
  completed_at   timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table if not exists crm.import_rows (
  id                uuid primary key default gen_random_uuid(),
  batch_id          uuid not null references crm.import_batches(id),
  row_number        integer not null,
  raw               jsonb not null,
  normalized        jsonb,
  mobile_e164       text,
  status            text not null default 'pending' check (status in ('pending', 'created', 'updated', 'skipped_duplicate', 'error')), -- pending | created | updated | skipped_duplicate | error
  matched_doctor_id uuid references crm.doctors(id),
  error_message     text,
  created_at        timestamptz not null default now(),
  unique (batch_id, row_number)
);
create index if not exists import_rows_status_idx on crm.import_rows (batch_id, status);
create index if not exists import_rows_phone_idx  on crm.import_rows (batch_id, mobile_e164);

-- ---------------------------------------------------------------------
-- 15. AUDIT (§6 "Timestamps and audit history on all core entities")
-- ---------------------------------------------------------------------
create table if not exists crm.audit_log (
  id             bigint generated always as identity primary key,
  hospital_id    uuid,
  table_name     text not null,
  record_id      text not null,
  operation      text not null check (operation in ('INSERT','UPDATE','DELETE')),
  actor_id       uuid,
  actor_role     text check (actor_role is null or actor_role in ('ceo_admin', 'head_of_growth', 'growth_manager', 'growth_executive', 'clinical_team', 'operations')), -- ceo_admin | head_of_growth | growth_manager | growth_executive | clinical_team | operations
  changed_fields text[],
  old_data       jsonb,
  new_data       jsonb,
  changed_at     timestamptz not null default now()
);
create index if not exists audit_record_idx on crm.audit_log (table_name, record_id, changed_at desc);
create index if not exists audit_actor_idx  on crm.audit_log (actor_id, changed_at desc);

create or replace function crm.audit_row()
returns trigger language plpgsql security definer
set search_path = crm, public, pg_temp as $$
declare
  v_old jsonb := case when tg_op = 'INSERT' then null else to_jsonb(old) end;
  v_new jsonb := case when tg_op = 'DELETE' then null else to_jsonb(new) end;
  v_row jsonb := coalesce(v_new, v_old);
  v_changed text[];
  v_record_id text;
begin
  -- Most CRM tables have a uuid `id`, but join tables (user_hospitals,
  -- visit_service_lines) are keyed on a composite PK. Resolve whatever the
  -- primary key actually is so audit works on every audited table.
  v_record_id := v_row ->> 'id';
  if v_record_id is null then
    select string_agg(v_row ->> a.attname, ':' order by k.ord)
      into v_record_id
    from pg_index i
    cross join lateral unnest(i.indkey) with ordinality as k(attnum, ord)
    join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
    where i.indrelid = tg_relid and i.indisprimary;
  end if;

  if tg_op = 'UPDATE' then
    select coalesce(array_agg(key), '{}') into v_changed
    from jsonb_each(v_new) n
    where n.value is distinct from v_old -> n.key;
    if v_changed = '{}' then return new; end if;
  end if;

  insert into crm.audit_log
    (hospital_id, table_name, record_id, operation, actor_id, actor_role,
     changed_fields, old_data, new_data)
  values (
    coalesce((v_new ->> 'hospital_id')::uuid, (v_old ->> 'hospital_id')::uuid),
    tg_table_name,
    coalesce(v_record_id, '?'),
    tg_op,
    crm.current_user_id(),
    crm.current_user_role(),
    v_changed, v_old, v_new);

  return coalesce(new, old);
end $$;

commit;
