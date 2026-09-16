-- LOCAL TEST ONLY — fixture data for the RLS verification suite.
-- Runs as superuser, which bypasses RLS (see NOTES.md, "Bootstrap").

insert into public.doctors (id, name, role) values
  (1,'Gurjot Narwal','Admin'), (2,'Virender Satija','Growth'),
  (3,'Area Manager','Growth'), (4,'Exec A','Growth'), (5,'Exec B','Growth'),
  (6,'Ops User','Ops'),        (7,'Clinical User','Consultant');
select setval('public.doctors_id_seq', 7);

insert into public.patients (id, name, phone, age, sex, file_no, notes) values
  (1,'Test Patient One','9876500001',54,'Male','GACH-1','HbA1c 10.6, on insulin');
select setval('public.patients_id_seq', 1);

insert into public.diagnoses (patient_id, label, status) values (1,'Type 2 DM','Uncontrolled');

with h as (select id from crm.hospitals where code='GACH')
insert into crm.users (id, full_name, role, scribe_doctor_id, manager_id) values
  ('11111111-1111-1111-1111-111111111111','CEO',            'ceo_admin',        1, null),
  ('22222222-2222-2222-2222-222222222222','Virender Satija','head_of_growth',   2, null),
  ('33333333-3333-3333-3333-333333333333','Area Manager',   'growth_manager',   3, '22222222-2222-2222-2222-222222222222'),
  ('44444444-4444-4444-4444-444444444444','Exec A',         'growth_executive', 4, '33333333-3333-3333-3333-333333333333'),
  ('55555555-5555-5555-5555-555555555555','Exec B',         'growth_executive', 5, '33333333-3333-3333-3333-333333333333'),
  ('66666666-6666-6666-6666-666666666666','Ops User',       'operations',       6, null),
  ('77777777-7777-7777-7777-777777777777','Clinical User',  'clinical_team',    7, null);

insert into crm.user_hospitals (user_id, hospital_id)
select u.id, h.id from crm.users u, crm.hospitals h where h.code='GACH';

-- Three doctors: one owned by Exec A, one by Exec B, one unassigned.
insert into crm.doctors (id, hospital_id, full_name, specialty, area, mobile, priority, relationship_stage)
select x.id, h.id, x.nm, x.sp, x.ar, x.mo, x.pr::crm.doctor_priority, 'prospect'
from crm.hospitals h,
 (values ('aaaaaaaa-0000-0000-0000-000000000001'::uuid,'Dr Owned By A','Orthopedics','Mohali','98765 00011','A'),
         ('aaaaaaaa-0000-0000-0000-000000000002'::uuid,'Dr Owned By B','Neurology','Kharar','+91 9876500012','B'),
         ('aaaaaaaa-0000-0000-0000-000000000003'::uuid,'Dr Unassigned','Cardiology','Patiala','09876500013','C')
 ) as x(id,nm,sp,ar,mo,pr)
where h.code='GACH';

insert into crm.doctor_assignments (hospital_id, doctor_id, executive_id, manager_id)
select h.id, x.doc, x.exec, '33333333-3333-3333-3333-333333333333'
from crm.hospitals h,
 (values ('aaaaaaaa-0000-0000-0000-000000000001'::uuid,'44444444-4444-4444-4444-444444444444'::uuid),
         ('aaaaaaaa-0000-0000-0000-000000000002'::uuid,'55555555-5555-5555-5555-555555555555'::uuid)
 ) as x(doc,exec)
where h.code='GACH';

insert into crm.doctor_referrals (id, hospital_id, patient_id, patient_name_raw, patient_phone_raw,
                           referring_doctor_id, source, responsible_executive_id, status)
select x.id, h.id, 1, 'Test Patient One', '9876500001', x.doc, 'direct_doctor', x.exec, 'new'
from crm.hospitals h,
 (values ('bbbbbbbb-0000-0000-0000-000000000001'::uuid,'aaaaaaaa-0000-0000-0000-000000000001'::uuid,'44444444-4444-4444-4444-444444444444'::uuid),
         ('bbbbbbbb-0000-0000-0000-000000000002'::uuid,'aaaaaaaa-0000-0000-0000-000000000002'::uuid,'55555555-5555-5555-5555-555555555555'::uuid)
 ) as x(id,doc,exec)
where h.code='GACH';

insert into crm.referral_clinical_notes (hospital_id, referral_id, note, authored_by)
select h.id, 'bbbbbbbb-0000-0000-0000-000000000001', 'Suspected diabetic foot ulcer, needs debridement.',
       '77777777-7777-7777-7777-777777777777'
from crm.hospitals h where h.code='GACH';

insert into crm.visits (hospital_id, doctor_id, executive_id, visit_type, occurred_at, outcome)
select h.id, 'aaaaaaaa-0000-0000-0000-000000000001', '44444444-4444-4444-4444-444444444444',
       'in_person', now() - interval '40 days', 'positive'
from crm.hospitals h where h.code='GACH';

-- Practice intelligence for all three doctors, so "Exec A sees 1" is a real
-- filter rather than a count of an empty table.
insert into crm.doctor_practice (doctor_id, hospital_id, opd_per_day, intelligence_notes)
select d.id, d.hospital_id, 40, 'Refers ICU cases to a competitor today.'
from crm.doctors d;

-- A contested referral: two doctors claim the same patient (§6 rule 5).
insert into crm.referral_attributions (hospital_id, referral_id, claimed_doctor_id, claimed_by, claim_source, status)
select h.id, 'bbbbbbbb-0000-0000-0000-000000000001', x.doc, x.usr, 'growth_executive', 'disputed'
from crm.hospitals h,
 (values ('aaaaaaaa-0000-0000-0000-000000000001'::uuid,'44444444-4444-4444-4444-444444444444'::uuid),
         ('aaaaaaaa-0000-0000-0000-000000000002'::uuid,'55555555-5555-5555-5555-555555555555'::uuid)
 ) as x(doc,usr)
where h.code='GACH';

-- Consent on file, so the "hidden from growth roles" test filters a real row.
insert into crm.patient_consents (hospital_id, patient_id, referral_id, status, granted_at, captured_by)
select h.id, 1, 'bbbbbbbb-0000-0000-0000-000000000001', 'granted', now(),
       '66666666-6666-6666-6666-666666666666'
from crm.hospitals h where h.code='GACH';

-- Ops-entered revenue against Exec B's doctor, so Exec A must not see it.
insert into crm.revenue_records (hospital_id, referral_id, patient_id, referring_doctor_id,
                                 amount_collected_inr, source, period_month, recorded_by)
select h.id, 'bbbbbbbb-0000-0000-0000-000000000002', 1, 'aaaaaaaa-0000-0000-0000-000000000002',
       125000, 'manual_ops', date_trunc('month', now())::date, '66666666-6666-6666-6666-666666666666'
from crm.hospitals h where h.code='GACH';

-- Fan-out fixture: Dr Unassigned gets 3 referrals and 2 revenue rows. A view
-- that joins both to crm.doctors in one pass reports 6 referrals and double
-- the revenue; the correct answer is 3 and 90000.
insert into crm.doctor_referrals (hospital_id, patient_id, patient_name_raw, patient_phone_raw,
                           referring_doctor_id, source, status, status_changed_at)
select h.id, 1, 'Fanout Patient', '9876500099',
       'aaaaaaaa-0000-0000-0000-000000000003', 'direct_doctor', x.st::crm.referral_status, now()
from crm.hospitals h, (values ('new'),('consulted'),('admitted')) as x(st)
where h.code='GACH';

insert into crm.revenue_records (hospital_id, patient_id, referring_doctor_id,
                                 amount_collected_inr, source, period_month, recorded_by)
select h.id, 1, 'aaaaaaaa-0000-0000-0000-000000000003', x.amt, 'manual_ops',
       date_trunc('month', now())::date, '66666666-6666-6666-6666-666666666666'
from crm.hospitals h, (values (40000),(50000)) as x(amt)
where h.code='GACH';
