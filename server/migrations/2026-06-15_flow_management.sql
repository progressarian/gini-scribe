-- ============================================================
-- Patient Flow Management module — core schema + seeds
-- 2026-06-15
--
-- A self-contained, ordered patient-journey + step-timing engine.
-- All tables are `flow_`-prefixed and additive: nothing in the existing
-- clinical / OPD / station_tracking tables is touched. Reuses the existing
-- `patients` and `doctors` tables by FK for lookups.
--
-- See docs/FLOW_MANAGEMENT_PLAN.md (rev 3).
-- Idempotent: safe to re-run (IF NOT EXISTS + ON CONFLICT DO NOTHING).
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()

-- ── 1. Configurable visit-type benchmarks ──────────────────────────────────
CREATE TABLE IF NOT EXISTS flow_visit_types (
  id            TEXT PRIMARY KEY,        -- 'FU_APPT', 'FU_APPT_TESTS', 'NEW_APPT', 'FU_WALK', 'NEW_WALK'
  label         TEXT NOT NULL,
  max_time_min  INT  NOT NULL,
  color         TEXT,
  is_flexible   BOOLEAN DEFAULT false,   -- walk-ins can adjust per day
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO flow_visit_types (id, label, max_time_min, color, is_flexible) VALUES
  ('FU_APPT',       'F/U Appt',         45,  'tl', false),
  ('FU_APPT_TESTS', 'F/U Appt + Tests', 90,  'lv', false),
  ('NEW_APPT',      'New Appt',         90,  'sk', false),
  ('FU_WALK',       'Walk-in F/U',      90,  'am', true),
  ('NEW_WALK',      'Walk-in New',      120, 're', true)
ON CONFLICT (id) DO NOTHING;

-- ── 2. Catalog of all possible steps ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS flow_step_catalog (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  default_duration_min INT  NOT NULL,
  station              TEXT NOT NULL,
  assigned_role        TEXT NOT NULL,
  display_order        INT,
  is_active            BOOLEAN DEFAULT true
);

INSERT INTO flow_step_catalog (id, name, default_duration_min, station, assigned_role, display_order) VALUES
  ('vitals',        'Vitals (Weight/BP/Pulse)', 8,  'Vitals Station',  'vitals_associate', 1),
  ('mo_assessment', 'MO Assessment',            5,  'MO Room',         'mo',               2),
  ('blood_sample',  'Blood Sample',             5,  'Lab',             'lab_tech',         3),
  ('abi',           'ABI Test',                 10, 'Lab',             'lab_tech',         4),
  ('vpt',           'VPT Test',                 7,  'Lab',             'lab_tech',         5),
  ('fundus',        'Fundus Imaging',           7,  'Lab',             'lab_tech',         6),
  ('ecg',           'ECG',                      10, 'Lab',             'lab_tech',         7),
  ('echo',          'Echo',                     15, 'Lab',             'lab_tech',         8),
  ('tmt',           'TMT',                      20, 'Lab',             'lab_tech',         9),
  ('xray',          'X-Ray',                    10, 'Lab',             'lab_tech',         10),
  ('wait_sd',       'Wait for SD',              10, 'Waiting Area',    'flow_coordinator', 11),
  ('sd_consult',    'SD Consultation',          15, 'SD Room',         'sd',               12),
  ('wait_chief',    'Wait for Chief',           8,  'Waiting Area',    'flow_coordinator', 13),
  ('chief_consult', 'Chief Consultation',       12, 'Chief Room',      'chief',            14),
  ('dietitian',     'Dietitian',                10, 'Dietitian Room',  'dietitian',        15),
  ('rx_explain',    'Prescription Explain',     5,  'Nursing Station', 'nurse',            16),
  ('billing',       'Billing',                  5,  'Billing Counter', 'billing',          17),
  ('pharmacy',      'Pharmacy / Exit',          5,  'Pharmacy',        'pharmacist',       18)
ON CONFLICT (id) DO NOTHING;

-- ── 3. Lightweight non-doctor station staff (plan §3.7 option A) ────────────
-- SD/Chief/MO assignment uses the existing `doctors` table; this table holds
-- the station staff (vitals/lab/nurse/pharmacy/dietitian) who aren't doctors.
CREATE TABLE IF NOT EXISTS flow_staff (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  role       TEXT NOT NULL,              -- matches flow_step_catalog.assigned_role
  is_active  BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Generic, role-based seed entries so the assignment dropdowns are usable
-- out of the box. Replace with real staff names via admin later (no names
-- hardcoded in prompts/logic — this is editable data).
INSERT INTO flow_staff (name, role) VALUES
  ('Vitals Associate', 'vitals_associate'),
  ('Lab Team',         'lab_tech'),
  ('Nurse',            'nurse'),
  ('Dietitian',        'dietitian'),
  ('Pharmacy Counter', 'pharmacist'),
  ('Billing Counter',  'billing')
ON CONFLICT DO NOTHING;

-- ── 4. Default journeys per visit type ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS flow_step_templates (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_type_id        TEXT NOT NULL REFERENCES flow_visit_types(id),
  step_catalog_id      TEXT NOT NULL REFERENCES flow_step_catalog(id),
  step_order           INT  NOT NULL,
  is_default           BOOLEAN DEFAULT true,    -- included by default
  is_optional          BOOLEAN DEFAULT false,   -- can be toggled at check-in
  condition_key        TEXT,                    -- 'needs_tests' | 'needs_chief' | 'needs_diet'
  override_duration_min INT,
  UNIQUE (visit_type_id, step_order)
);

INSERT INTO flow_step_templates (visit_type_id, step_catalog_id, step_order, condition_key) VALUES
  -- FU_APPT
  ('FU_APPT', 'vitals', 1, NULL),
  ('FU_APPT', 'mo_assessment', 2, NULL),
  ('FU_APPT', 'wait_sd', 3, NULL),
  ('FU_APPT', 'sd_consult', 4, NULL),
  ('FU_APPT', 'rx_explain', 5, NULL),
  ('FU_APPT', 'billing', 6, NULL),
  ('FU_APPT', 'pharmacy', 7, NULL),
  -- FU_APPT_TESTS
  ('FU_APPT_TESTS', 'vitals', 1, NULL),
  ('FU_APPT_TESTS', 'mo_assessment', 2, NULL),
  ('FU_APPT_TESTS', 'blood_sample', 3, 'needs_tests'),
  ('FU_APPT_TESTS', 'wait_sd', 4, NULL),
  ('FU_APPT_TESTS', 'sd_consult', 5, NULL),
  ('FU_APPT_TESTS', 'rx_explain', 6, NULL),
  ('FU_APPT_TESTS', 'billing', 7, NULL),
  ('FU_APPT_TESTS', 'pharmacy', 8, NULL),
  -- NEW_APPT
  ('NEW_APPT', 'vitals', 1, NULL),
  ('NEW_APPT', 'mo_assessment', 2, NULL),
  ('NEW_APPT', 'blood_sample', 3, 'needs_tests'),
  ('NEW_APPT', 'wait_sd', 4, NULL),
  ('NEW_APPT', 'sd_consult', 5, NULL),
  ('NEW_APPT', 'wait_chief', 6, 'needs_chief'),
  ('NEW_APPT', 'chief_consult', 7, 'needs_chief'),
  ('NEW_APPT', 'rx_explain', 8, NULL),
  ('NEW_APPT', 'billing', 9, NULL),
  ('NEW_APPT', 'pharmacy', 10, NULL),
  -- FU_WALK
  ('FU_WALK', 'vitals', 1, NULL),
  ('FU_WALK', 'mo_assessment', 2, NULL),
  ('FU_WALK', 'wait_sd', 3, NULL),
  ('FU_WALK', 'sd_consult', 4, NULL),
  ('FU_WALK', 'rx_explain', 5, NULL),
  ('FU_WALK', 'billing', 6, NULL),
  ('FU_WALK', 'pharmacy', 7, NULL),
  -- NEW_WALK
  ('NEW_WALK', 'vitals', 1, NULL),
  ('NEW_WALK', 'mo_assessment', 2, NULL),
  ('NEW_WALK', 'blood_sample', 3, 'needs_tests'),
  ('NEW_WALK', 'wait_sd', 4, NULL),
  ('NEW_WALK', 'sd_consult', 5, NULL),
  ('NEW_WALK', 'wait_chief', 6, 'needs_chief'),
  ('NEW_WALK', 'chief_consult', 7, 'needs_chief'),
  ('NEW_WALK', 'dietitian', 8, 'needs_diet'),
  ('NEW_WALK', 'rx_explain', 9, NULL),
  ('NEW_WALK', 'billing', 10, NULL),
  ('NEW_WALK', 'pharmacy', 11, NULL)
ON CONFLICT (visit_type_id, step_order) DO NOTHING;

-- ── 5. One row per visit ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS flow_visits (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id          TEXT NOT NULL,                          -- file number (display / patient link)
  patient_db_id       INT REFERENCES patients(id),            -- FK to existing patients (nullable for fresh walk-ins)
  appointment_id      INT REFERENCES appointments(id),        -- link to booking when one exists
  patient_name        TEXT NOT NULL,
  patient_phone       TEXT,
  patient_age_sex     TEXT,                                   -- '71M', '44F'
  visit_type_id       TEXT NOT NULL REFERENCES flow_visit_types(id),
  visit_date          DATE DEFAULT CURRENT_DATE,
  appointment_time    TEXT,
  has_tests_available BOOLEAN DEFAULT false,
  patient_status      TEXT CHECK (patient_status IN ('improving','same','worse','new_patient')),
  checkin_time        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  max_time_min        INT NOT NULL,
  suggested_wait_min  INT,
  estimated_completion TIMESTAMPTZ,
  actual_completion   TIMESTAMPTZ,
  current_step_id     UUID,
  current_step_order  INT DEFAULT 0,
  status              TEXT DEFAULT 'in_progress' CHECK (status IN ('in_progress','completed','cancelled')),
  is_vip              BOOLEAN DEFAULT false,
  notes               TEXT,
  visit_token         TEXT UNIQUE,
  whatsapp_sent       BOOLEAN DEFAULT false,
  checked_in_by       TEXT,
  assigned_sd         INT REFERENCES doctors(id),
  assigned_sd_name    TEXT,
  assigned_chief      INT REFERENCES doctors(id),
  assigned_chief_name TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_flow_visits_date     ON flow_visits(visit_date);
CREATE INDEX IF NOT EXISTS idx_flow_visits_status   ON flow_visits(status);
CREATE INDEX IF NOT EXISTS idx_flow_visits_patient  ON flow_visits(patient_id);
CREATE INDEX IF NOT EXISTS idx_flow_visits_patient_db_id ON flow_visits(patient_db_id);
CREATE INDEX IF NOT EXISTS idx_flow_visits_appointment  ON flow_visits(appointment_id);
CREATE INDEX IF NOT EXISTS idx_flow_visits_token    ON flow_visits(visit_token);

-- ── 6. Actual steps for each visit ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS flow_visit_steps (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id            UUID NOT NULL REFERENCES flow_visits(id) ON DELETE CASCADE,
  step_catalog_id     TEXT REFERENCES flow_step_catalog(id),  -- nullable: ad-hoc Custom steps
  step_order          INT  NOT NULL,
  step_name           TEXT NOT NULL,
  planned_duration_min INT NOT NULL,
  actual_duration_min  INT,
  station             TEXT NOT NULL,
  assigned_role       TEXT NOT NULL,
  assigned_staff_id   TEXT,
  assigned_staff_name TEXT,
  status              TEXT DEFAULT 'pending'
                      CHECK (status IN ('pending','ready','in_progress','completed','skipped')),
  started_at          TIMESTAMPTZ,
  completed_at        TIMESTAMPTZ,
  data                JSONB DEFAULT '{}',
  notes               TEXT,
  UNIQUE (visit_id, step_order)
);

CREATE INDEX IF NOT EXISTS idx_fvs_visit    ON flow_visit_steps(visit_id);
CREATE INDEX IF NOT EXISTS idx_fvs_status   ON flow_visit_steps(status);
CREATE INDEX IF NOT EXISTS idx_fvs_assigned ON flow_visit_steps(assigned_role, status);

-- ── 7. Audit log for analytics ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS flow_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id     UUID REFERENCES flow_visits(id) ON DELETE CASCADE,
  event_type   TEXT NOT NULL,   -- checkin | step_started | step_completed | step_skipped | visit_completed | duration_edited | reassigned | step_added | step_removed | whatsapp_sent
  step_order   INT,
  details      JSONB,
  triggered_by TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fe_visit ON flow_events(visit_id);
CREATE INDEX IF NOT EXISTS idx_fe_type  ON flow_events(event_type);
