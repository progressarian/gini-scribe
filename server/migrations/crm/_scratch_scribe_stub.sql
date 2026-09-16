-- LOCAL TEST ONLY. Minimal stand-in for the two Scribe tables the CRM
-- foreign-keys to, copied field-for-field from server/schema.sql. This file
-- is never applied to Supabase — those tables already exist there.
create table if not exists public.patients (
  id            serial primary key,
  name          text not null,
  phone         text,
  dob           date,
  age           integer,
  sex           text check (sex in ('Male','Female','Other')),
  file_no       text,
  abha_id       text,
  health_id     text,
  email         text,
  address       text,
  -- clinical-adjacent columns the CRM must never be able to read
  notes         text,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now(),
  unique(phone), unique(file_no), unique(abha_id)
);

create table if not exists public.doctors (
  id          serial primary key,
  name        text not null,
  short_name  text,
  role        text default 'MO',
  specialty   text,
  license_no  text,
  phone       text,
  pin         text,
  is_active   boolean default true,
  created_at  timestamptz default now()
);

-- A clinical table, present only to prove crm_app cannot reach it.
create table if not exists public.diagnoses (
  id          serial primary key,
  patient_id  integer not null references public.patients(id),
  label       text not null,
  status      text
);
