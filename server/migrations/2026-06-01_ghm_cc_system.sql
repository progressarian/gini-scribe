-- ============================================================
-- GHM Appointment + CC Sheet System
-- 2026-06-01
-- All new tables / columns. Zero changes to existing schema.
-- Safe to re-run (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).
-- ============================================================

-- ── 1. Extend appointments with GHM booking fields ──────────
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS reporting_time_slot      TEXT,
  ADD COLUMN IF NOT EXISTS appointment_type         TEXT DEFAULT 'Physical',
  ADD COLUMN IF NOT EXISTS booking_date             DATE,
  ADD COLUMN IF NOT EXISTS booking_source           TEXT DEFAULT 'OBT',
  ADD COLUMN IF NOT EXISTS booked_by_name           TEXT,
  ADD COLUMN IF NOT EXISTS insurance_taken          TEXT,
  ADD COLUMN IF NOT EXISTS how_did_you_know         TEXT,
  ADD COLUMN IF NOT EXISTS referred_by_doctor_name  TEXT,
  ADD COLUMN IF NOT EXISTS earlier_slot_given       BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS show_no_show             TEXT,
  ADD COLUMN IF NOT EXISTS reason_no_online         TEXT,
  ADD COLUMN IF NOT EXISTS requested_by_cc          TEXT,
  ADD COLUMN IF NOT EXISTS cc_remark_date           DATE,
  ADD COLUMN IF NOT EXISTS whatsapp_message         TEXT,
  ADD COLUMN IF NOT EXISTS additional_whatsapp_msg  TEXT,
  ADD COLUMN IF NOT EXISTS will_get_test_at_gini    BOOLEAN,
  ADD COLUMN IF NOT EXISTS chief_complaint          TEXT,
  ADD COLUMN IF NOT EXISTS condition                TEXT,
  ADD COLUMN IF NOT EXISTS misc_notes               TEXT,
  ADD COLUMN IF NOT EXISTS reports_uploaded         BOOLEAN DEFAULT FALSE;

-- ── 2. Care Coordinators ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS cc_agents (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  is_active  BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
INSERT INTO cc_agents (name) VALUES
  ('Aman'),('Raghvi'),('Kamal'),
  ('Navjot'),('Bharti'),('Charanjeet')
ON CONFLICT (name) DO NOTHING;

-- ── 3. Clinic Holidays ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS clinic_holidays (
  id           SERIAL PRIMARY KEY,
  holiday_date DATE NOT NULL UNIQUE,
  remarks      TEXT,
  entry_date   DATE DEFAULT CURRENT_DATE,
  created_by   TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_clinic_holidays_date ON clinic_holidays(holiday_date);

-- ── 4. Appointment Slot Configuration ───────────────────────
CREATE TABLE IF NOT EXISTS appointment_slots (
  id             SERIAL PRIMARY KEY,
  doctor_name    TEXT NOT NULL,
  slot_date      DATE NOT NULL,
  time_slot      TEXT NOT NULL,
  slot_type      TEXT DEFAULT 'regular',
  total_capacity INTEGER DEFAULT 5,
  booked_count   INTEGER DEFAULT 0,
  is_blocked     BOOLEAN DEFAULT FALSE,
  block_reason   TEXT,
  UNIQUE(doctor_name, slot_date, time_slot)
);
CREATE INDEX IF NOT EXISTS idx_slots_date_doctor ON appointment_slots(slot_date, doctor_name);

-- ── 5. Patient Journey / Station Tracking ───────────────────
CREATE TABLE IF NOT EXISTS station_tracking (
  id                      SERIAL PRIMARY KEY,
  appointment_id          INTEGER REFERENCES appointments(id) ON DELETE CASCADE,
  patient_id              INTEGER REFERENCES patients(id),
  visit_date              DATE NOT NULL DEFAULT CURRENT_DATE,
  doctor_name             TEXT,
  cc_name                 TEXT,
  ghm_checkin_time        TIMESTAMPTZ,
  patient_greet_time      TIMESTAMPTZ,
  last_updated_status     TEXT,
  last_updated_time       TIMESTAMPTZ,
  vitals_planned          TIME,
  vitals_checkin          TIMESTAMPTZ,
  vitals_checkout         TIMESTAMPTZ,
  rx_planned              TIME,
  rx_checkin              TIMESTAMPTZ,
  rx_checkout             TIMESTAMPTZ,
  rx_explained_by         TEXT,
  dm_planned              TIME,
  dm_checkin              TIMESTAMPTZ,
  dm_checkout             TIMESTAMPTZ,
  ce_planned              TIME,
  ce_checkin              TIMESTAMPTZ,
  ce_checkout             TIMESTAMPTZ,
  counsel_planned         TIME,
  counsel_checkin         TIMESTAMPTZ,
  counsel_checkout        TIMESTAMPTZ,
  journey_time_mins       INTEGER,
  reasons_for_waiting     TEXT,
  followup_appt_booked    BOOLEAN,
  followup_appt_no_reason TEXT,
  followup_appt_date      DATE,
  followup_appt_time      TEXT,
  followup_appt_with      TEXT,
  enrolled_in_programs    TEXT,
  weight_loss_medicine    BOOLEAN DEFAULT FALSE,
  followup_consult_other  TEXT,
  to_be_seen_by_bhansali  BOOLEAN DEFAULT FALSE,
  created_at              TIMESTAMPTZ DEFAULT NOW(),
  updated_at              TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_station_appt ON station_tracking(appointment_id);
CREATE INDEX IF NOT EXISTS idx_station_date ON station_tracking(visit_date);

-- ── 6. CC Calling Log ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cc_calling_log (
  id                       SERIAL PRIMARY KEY,
  call_type                TEXT NOT NULL DEFAULT 'pre_visit',
  patient_id               INTEGER REFERENCES patients(id),
  file_no                  TEXT,
  patient_name             TEXT,
  dob                      TEXT,
  mobile                   TEXT,
  condition                TEXT,
  visit_date               DATE,
  visit_type               TEXT,
  cc_assigned              TEXT,
  outcome_data             TEXT,
  pt_recovery              TEXT,
  follow_visit_date        DATE,
  follow_up_appt_time      TEXT,
  fundus_status            TEXT,
  additional_followup_date DATE,
  gap_days                 INTEGER,
  call_made_by             TEXT,
  calling_date             DATE,
  call_duration_mins       REAL,
  call_done                BOOLEAN DEFAULT FALSE,
  improvement_status       TEXT,
  appt_booked_on           DATE,
  appt_time_slot           TEXT,
  appt_type                TEXT,
  appt_not_booked_reason   TEXT,
  medical_issues_noted     BOOLEAN DEFAULT FALSE,
  ticket_no                TEXT,
  followup_tests_status    TEXT,
  notes                    TEXT,
  is_on_insulin            BOOLEAN,
  show_no_show             TEXT,
  week_num                 INTEGER,
  month_num                INTEGER,
  created_at               TIMESTAMPTZ DEFAULT NOW(),
  updated_at               TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cc_log_visit_date  ON cc_calling_log(visit_date);
CREATE INDEX IF NOT EXISTS idx_cc_log_call_type   ON cc_calling_log(call_type);
CREATE INDEX IF NOT EXISTS idx_cc_log_cc_assigned ON cc_calling_log(cc_assigned);
CREATE INDEX IF NOT EXISTS idx_cc_log_file_no     ON cc_calling_log(file_no);

-- ── 7. Cancellations / Reschedules ──────────────────────────
CREATE TABLE IF NOT EXISTS appointment_cancellations (
  id                      SERIAL PRIMARY KEY,
  original_appointment_id INTEGER REFERENCES appointments(id),
  cancel_type             TEXT,
  reason                  TEXT,
  appointment_date        DATE,
  appointment_time        TEXT,
  file_no                 TEXT,
  patient_name            TEXT,
  mobile                  TEXT,
  address                 TEXT,
  doctor_name             TEXT,
  condition               TEXT,
  booking_date            DATE,
  appointment_type        TEXT,
  visit_type              TEXT,
  visit_number            INTEGER,
  booked_by               TEXT,
  comments                TEXT,
  outcome                 TEXT,
  requested_by_cc         TEXT,
  cc_remark_date          DATE,
  rescheduled_to_date     DATE,
  rescheduled_to_time     TEXT,
  whatsapp_message        TEXT,
  week_num                INTEGER,
  month_num               INTEGER,
  created_at              TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cancel_appt_date ON appointment_cancellations(appointment_date);
CREATE INDEX IF NOT EXISTS idx_cancel_file_no   ON appointment_cancellations(file_no);

-- ── 8. Walk-in Bookings ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS walkin_bookings (
  id                          SERIAL PRIMARY KEY,
  walkin_date                 DATE NOT NULL,
  time_slot                   TEXT,
  file_no                     TEXT,
  patient_name                TEXT,
  contact_number              TEXT,
  visit_type                  TEXT DEFAULT 'New',
  agent_name                  TEXT,
  reason_for_booking          TEXT,
  standard_instruction        TEXT,
  last_visit_date             DATE,
  misc                        TEXT,
  whatsapp_message            TEXT,
  additional_whatsapp_message TEXT,
  created_at                  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_walkin_date ON walkin_bookings(walkin_date);

-- ── 9. OBT Call Status ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS obt_call_status (
  id               SERIAL PRIMARY KEY,
  appointment_id   INTEGER REFERENCES appointments(id),
  call_date        DATE NOT NULL DEFAULT CURRENT_DATE,
  appointment_date DATE,
  appointment_time TEXT,
  file_no          TEXT,
  patient_name     TEXT,
  gender           TEXT,
  dob              TEXT,
  mobile           TEXT,
  address          TEXT,
  visit_type       TEXT,
  condition        TEXT,
  chief_complaint  TEXT,
  mo_assigned      TEXT,
  call_status      TEXT DEFAULT 'Pending',
  suggested_blood_test TEXT,
  notes            TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_obt_call_date ON obt_call_status(call_date);
CREATE INDEX IF NOT EXISTS idx_obt_appt_date ON obt_call_status(appointment_date);

-- ── 10. Special Patient Alerts ───────────────────────────────
CREATE TABLE IF NOT EXISTS patient_special_alerts (
  id               SERIAL PRIMARY KEY,
  file_no          TEXT,
  patient_id       INTEGER REFERENCES patients(id),
  patient_name     TEXT,
  alert_type       TEXT NOT NULL DEFAULT 'scheduling',
  remarks          TEXT NOT NULL,
  preferred_slots  TEXT,
  additional_doctor TEXT,
  priority_patient BOOLEAN DEFAULT FALSE,
  preferred_date   TEXT,
  avoid_booking    BOOLEAN DEFAULT FALSE,
  is_active        BOOLEAN DEFAULT TRUE,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_alerts_file_no ON patient_special_alerts(file_no);

-- ── 11. App Install Tracking ─────────────────────────────────
CREATE TABLE IF NOT EXISTS app_install_tracking (
  id               SERIAL PRIMARY KEY,
  patient_id       INTEGER REFERENCES patients(id),
  file_no          TEXT UNIQUE,
  patient_name     TEXT,
  app_installed    BOOLEAN DEFAULT FALSE,
  profile_created  BOOLEAN DEFAULT FALSE,
  install_date     DATE,
  registered_by_cc TEXT,
  notes            TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_app_install_file ON app_install_tracking(file_no);

-- ── 12. Diabetes Champions ───────────────────────────────────
CREATE TABLE IF NOT EXISTS diabetes_champions (
  id            SERIAL PRIMARY KEY,
  creation_date DATE,
  file_no       TEXT,
  patient_id    INTEGER REFERENCES patients(id),
  patient_name  TEXT NOT NULL,
  mobile        TEXT,
  email         TEXT,
  outcome       TEXT,
  tagged_on_fb  BOOLEAN DEFAULT FALSE,
  comments      TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_champions_file_no ON diabetes_champions(file_no);
