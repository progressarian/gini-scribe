-- Gini Clinical Scribe — Database Schema
-- Designed for: outcomes tracking, historical data, MyHealth Genie, PatientLoop

-- ============ PATIENTS ============
CREATE TABLE IF NOT EXISTS patients (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  phone         TEXT,
  dob           DATE,
  age           INTEGER,
  sex           TEXT CHECK (sex IN ('Male','Female','Other')),
  file_no       TEXT,              -- Gini hospital file number
  abha_id       TEXT,              -- ABHA health ID (XX-XXXX-XXXX-XXXX)
  health_id     TEXT,              -- MyHealth Genie ID (future)
  aadhaar       TEXT,              -- Aadhaar number (encrypted in production)
  govt_id       TEXT,              -- Passport, DL, Voter ID, PAN
  govt_id_type  TEXT,              -- 'Passport','DrivingLicense','VoterID','PAN'
  email         TEXT,
  address       TEXT,
  blood_group   TEXT,
  emergency_contact TEXT,
  emergency_phone   TEXT,
  notes         TEXT,              -- Any general notes about patient
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(phone),                   -- Phone is primary lookup
  UNIQUE(file_no),                 -- File number is unique
  UNIQUE(abha_id)
);
CREATE INDEX idx_patients_phone ON patients(phone);
CREATE INDEX idx_patients_file ON patients(file_no);
CREATE INDEX idx_patients_abha ON patients(abha_id);
CREATE INDEX idx_patients_name ON patients(name);

-- ============ DOCTORS ============
CREATE TABLE IF NOT EXISTS doctors (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  short_name    TEXT,                -- Short display name
  role          TEXT DEFAULT 'MO',  -- 'MO','Consultant','Surgeon'
  specialty     TEXT,
  license_no    TEXT,
  phone         TEXT,
  pin           TEXT,                -- bcrypt-hashed PIN for login
  is_active     BOOLEAN DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ============ CONSULTATIONS ============
-- One row per visit. Contains structured JSON + transcripts
CREATE TABLE IF NOT EXISTS consultations (
  id              SERIAL PRIMARY KEY,
  patient_id      INTEGER NOT NULL REFERENCES patients(id),
  visit_date      DATE NOT NULL DEFAULT CURRENT_DATE,
  visit_type      TEXT DEFAULT 'OPD',  -- 'OPD','IPD','Follow-up','Emergency','Tele'
  mo_doctor_id    INTEGER REFERENCES doctors(id),
  con_doctor_id   INTEGER REFERENCES doctors(id),
  mo_name         TEXT,                -- Fallback if doctor not in table
  con_name        TEXT,

  -- Raw transcripts (preserved for audit / re-processing)
  quick_transcript  TEXT,
  mo_transcript     TEXT,
  con_transcript    TEXT,

  -- Structured data (JSON blobs from AI)
  mo_data         JSONB,              -- Full MO structured output
  con_data        JSONB,              -- Full Consultant structured output

  -- Status
  status          TEXT DEFAULT 'draft', -- 'draft','completed','printed','sent'
  plan_edits      JSONB,              -- Any edits made to the plan before printing

  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_consultations_patient ON consultations(patient_id);
CREATE INDEX idx_consultations_date ON consultations(visit_date);

-- ============ VITALS ============
-- Per consultation. Tracks trends over time.
CREATE TABLE IF NOT EXISTS vitals (
  id              SERIAL PRIMARY KEY,
  patient_id      INTEGER NOT NULL REFERENCES patients(id),
  consultation_id INTEGER REFERENCES consultations(id),
  recorded_at     TIMESTAMPTZ DEFAULT NOW(),
  bp_sys          REAL,
  bp_dia          REAL,
  pulse           REAL,
  temp            REAL,
  spo2            REAL,
  weight          REAL,
  height          REAL,
  bmi             REAL,
  rbs             REAL,              -- Random blood sugar (if taken in OPD)
  notes           TEXT
);
CREATE INDEX idx_vitals_patient ON vitals(patient_id);

-- ============ DIAGNOSES ============
-- Active diagnosis tracking per patient. Status changes over time.
CREATE TABLE IF NOT EXISTS diagnoses (
  id              SERIAL PRIMARY KEY,
  patient_id      INTEGER NOT NULL REFERENCES patients(id),
  consultation_id INTEGER REFERENCES consultations(id),  -- When first diagnosed or status changed
  diagnosis_id    TEXT NOT NULL,       -- 'dm2','htn','cad','ckd','hypo','obesity','dyslipidemia'
  label           TEXT NOT NULL,       -- 'Type 2 DM (Since 2010)'
  status          TEXT NOT NULL,       -- 'Controlled','Uncontrolled','New','Resolved'
  category        TEXT,                -- 'primary','complication','comorbidity','external','monitoring'
  complication_type TEXT,              -- 'nephropathy','neuropathy','retinopathy','foot','other'
  external_doctor TEXT,                -- Doctor name for external diagnoses
  key_value       TEXT,                -- e.g. 'HbA1c 10.6%', 'UACR 88 mg/g'
  trend           TEXT,                -- e.g. '48→62→88'
  since_year      INTEGER,            -- Year of diagnosis
  sort_order      INTEGER DEFAULT 0,   -- Manual ordering within category
  notes           TEXT,
  is_active       BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_diagnoses_patient ON diagnoses(patient_id);
CREATE INDEX idx_diagnoses_category ON diagnoses(patient_id, category);

-- ============ MEDICATIONS ============
-- Prescription history. Every medication ever prescribed.
CREATE TABLE IF NOT EXISTS medications (
  id              SERIAL PRIMARY KEY,
  patient_id      INTEGER NOT NULL REFERENCES patients(id),
  consultation_id INTEGER REFERENCES consultations(id),
  name            TEXT NOT NULL,       -- Brand name as prescribed
  pharmacy_match  TEXT,                -- Matched Gini pharmacy brand
  composition     TEXT,                -- Generic name / composition
  dose            TEXT,
  frequency       TEXT,                -- 'OD','BD','TDS','QID','SOS'
  timing          TEXT,                -- 'Before breakfast','After meals','At bedtime'
  route           TEXT DEFAULT 'Oral', -- 'Oral','IV','IM','SC','Topical','Inhaled'
  for_diagnosis   TEXT[],              -- ['dm2','htn']
  med_group       TEXT,                -- 'diabetes','kidney','bp','lipids','thyroid','supplement','external'
  drug_class      TEXT,                -- 'insulin','metformin','sglt2','glp1','dpp4','su','other'
  external_doctor TEXT,                -- For external medications
  clinical_note   TEXT,                -- e.g. 'Renal protection — UACR 88'
  sort_order      INTEGER DEFAULT 0,   -- Manual ordering within group
  is_new          BOOLEAN DEFAULT FALSE,
  is_active       BOOLEAN DEFAULT TRUE,-- Still taking
  started_date    DATE,
  last_prescribed_date DATE,
  stopped_date    DATE,
  stop_reason     TEXT,                -- 'Side effect','Replaced','Goal met'
  notes           TEXT,
  parent_medication_id INTEGER REFERENCES medications(id) ON DELETE SET NULL,
  support_condition    TEXT,           -- 'for nausea Day 1-2', 'SOS for diarrhoea'
  days_of_week    INTEGER[],           -- [0..6] (Sun..Sat); null when not weekly
  common_side_effects JSONB DEFAULT '[]'::jsonb, -- [{name, desc, severity}] up to 3 entries
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_medications_patient ON medications(patient_id);
CREATE INDEX idx_medications_active ON medications(patient_id, is_active);
CREATE INDEX idx_medications_group ON medications(patient_id, med_group);
CREATE INDEX idx_medications_parent ON medications(parent_medication_id);

-- ============ LAB RESULTS ============
-- Individual test results. Tracks biomarker trends.
CREATE TABLE IF NOT EXISTS lab_results (
  id              SERIAL PRIMARY KEY,
  patient_id      INTEGER NOT NULL REFERENCES patients(id),
  consultation_id INTEGER REFERENCES consultations(id),
  test_date       DATE DEFAULT CURRENT_DATE,
  panel_name      TEXT,                -- 'CBC','RFT','Lipid Profile','Thyroid'
  test_name       TEXT NOT NULL,       -- 'HbA1c','eGFR','TSH','LDL'
  result          REAL,
  result_text     TEXT,                -- For non-numeric results
  unit            TEXT,
  flag            TEXT,                -- 'HIGH','LOW',null
  ref_range       TEXT,                -- '0.4-4.0'
  is_critical     BOOLEAN DEFAULT FALSE,
  source          TEXT DEFAULT 'lab',  -- 'lab','manual','scribe','import','vitals_sheet'
  canonical_name  TEXT,                -- Normalized test name for reliable querying
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_labs_patient ON lab_results(patient_id);
CREATE INDEX idx_labs_test ON lab_results(patient_id, test_name);
CREATE INDEX idx_labs_date ON lab_results(test_date);
CREATE INDEX idx_lab_canonical ON lab_results(patient_id, canonical_name);
-- One reading per (patient, canonical test, date). Partial — leaves raw lab
-- feeds (source='lab') unconstrained in case external feeds legitimately
-- carry multiple readings per day.
CREATE UNIQUE INDEX IF NOT EXISTS uq_lab_results_per_date
  ON lab_results (patient_id, canonical_name, test_date)
  WHERE canonical_name IS NOT NULL
    AND source IN ('report_extract','manual','opd','healthray','prescription_parsed','lab_healthray','vitals_sheet','scribe','import');

-- ============ DOCUMENTS / REPORTS ============
-- Uploaded PDFs, images, previous prescriptions
CREATE TABLE IF NOT EXISTS documents (
  id              SERIAL PRIMARY KEY,
  patient_id      INTEGER NOT NULL REFERENCES patients(id),
  consultation_id INTEGER REFERENCES consultations(id),
  doc_type        TEXT NOT NULL,       -- 'lab_report','prescription','discharge','imaging','other'
  title           TEXT,
  file_name       TEXT,
  file_url        TEXT,                -- S3/storage URL
  file_data       BYTEA,              -- Or store directly (for small files)
  mime_type       TEXT,
  extracted_text  TEXT,                -- OCR / AI extracted text
  extracted_data  JSONB,              -- Structured data from the document
  doc_date        DATE,                -- Date on the document
  source          TEXT,                -- 'upload','scan','gini_system','external','patient_upload'
  uploaded_by_patient BOOLEAN NOT NULL DEFAULT FALSE, -- true when sent from the patient app (myhealthgenie)
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_documents_patient ON documents(patient_id);
CREATE INDEX IF NOT EXISTS idx_documents_uploaded_by_patient
  ON documents(patient_id)
  WHERE uploaded_by_patient = TRUE;

-- ============ GOALS ============
-- Health goals with tracking
CREATE TABLE IF NOT EXISTS goals (
  id              SERIAL PRIMARY KEY,
  patient_id      INTEGER NOT NULL REFERENCES patients(id),
  consultation_id INTEGER REFERENCES consultations(id),
  marker          TEXT NOT NULL,       -- 'HbA1c','BP','Weight','LDL'
  current_value   TEXT,
  target_value    TEXT,
  timeline        TEXT,                -- '3 months','6 weeks'
  priority        TEXT,                -- 'critical','high','medium'
  status          TEXT DEFAULT 'active', -- 'active','achieved','missed','revised'
  achieved_date   DATE,
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_goals_patient ON goals(patient_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_goals_consultation_marker
  ON goals(consultation_id, marker)
  WHERE consultation_id IS NOT NULL;

-- ============ COMPLICATIONS ============
CREATE TABLE IF NOT EXISTS complications (
  id              SERIAL PRIMARY KEY,
  patient_id      INTEGER NOT NULL REFERENCES patients(id),
  consultation_id INTEGER REFERENCES consultations(id),
  name            TEXT NOT NULL,       -- 'Nephropathy','Retinopathy','Neuropathy'
  status          TEXT,                -- '+','-','screening'
  detail          TEXT,                -- 'eGFR 29, CKD Stage 4'
  severity        TEXT,                -- 'high','low'
  is_active       BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_complications_patient ON complications(patient_id);

-- ============ ACTIVE VISITS ============
-- Tracks which doctor currently has an active visit open (survives page refresh)
CREATE TABLE IF NOT EXISTS active_visits (
  id              SERIAL PRIMARY KEY,
  doctor_id       INTEGER REFERENCES doctors(id),
  doctor_name     TEXT NOT NULL,
  patient_id      INTEGER REFERENCES patients(id),
  appointment_id  INTEGER REFERENCES appointments(id),
  visit_type      TEXT DEFAULT 'new',  -- 'new' or 'followup'
  status          TEXT DEFAULT 'scheduled', -- 'scheduled','in-progress','completed','cancelled','no_show'
  route           TEXT,                -- current route e.g. '/intake', '/fu-load'
  started_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_active_visits_doctor ON active_visits(doctor_id);

-- ============ VIEWS for common queries ============

-- Latest vitals per patient
CREATE OR REPLACE VIEW v_latest_vitals AS
SELECT DISTINCT ON (patient_id)
  patient_id, bp_sys, bp_dia, pulse, spo2, weight, height, bmi, recorded_at
FROM vitals
ORDER BY patient_id, recorded_at DESC;

-- Latest HbA1c per patient
CREATE OR REPLACE VIEW v_latest_hba1c AS
SELECT DISTINCT ON (patient_id)
  patient_id, result AS hba1c, test_date, flag
FROM lab_results
WHERE test_name = 'HbA1c'
ORDER BY patient_id, test_date DESC;

-- Active medications per patient
CREATE OR REPLACE VIEW v_active_meds AS
SELECT patient_id, name, pharmacy_match, composition, dose, frequency, timing, for_diagnosis, started_date
FROM medications
WHERE is_active = TRUE
ORDER BY patient_id, name;

-- Patient summary (for search / dashboard)
CREATE OR REPLACE VIEW v_patient_summary AS
SELECT
  p.id, p.name, p.phone, p.age, p.sex, p.file_no, p.abha_id, p.health_id,
  (SELECT COUNT(*) FROM consultations c WHERE c.patient_id = p.id) AS visit_count,
  (SELECT MAX(visit_date) FROM consultations c WHERE c.patient_id = p.id) AS last_visit,
  (SELECT string_agg(DISTINCT d.diagnosis_id, ',') FROM diagnoses d WHERE d.patient_id = p.id AND d.is_active) AS active_diagnoses
FROM patients p;

-- ============ HELPER FUNCTIONS ============

-- Auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_patients_updated BEFORE UPDATE ON patients FOR EACH ROW EXECUTE FUNCTION update_timestamp();
CREATE TRIGGER trg_consultations_updated BEFORE UPDATE ON consultations FOR EACH ROW EXECUTE FUNCTION update_timestamp();
CREATE TRIGGER trg_diagnoses_updated BEFORE UPDATE ON diagnoses FOR EACH ROW EXECUTE FUNCTION update_timestamp();
CREATE TRIGGER trg_goals_updated BEFORE UPDATE ON goals FOR EACH ROW EXECUTE FUNCTION update_timestamp();

CREATE TABLE IF NOT EXISTS patient_vitals_log (
    id              SERIAL PRIMARY KEY,
    patient_id      INTEGER NOT NULL REFERENCES patients(id),
    genie_id        TEXT,                -- Genie Supabase row UUID (for dedup)
    recorded_date   DATE NOT NULL,
    reading_time    TEXT,
    bp_systolic     REAL,
    bp_diastolic    REAL,
    rbs             REAL,
    meal_type       TEXT,                -- Fasting/After breakfast/Random etc.
    weight_kg       REAL,
    pulse           REAL,
    spo2            REAL,
    body_fat        REAL,
    muscle_mass     REAL,
    bmi             REAL,
    waist           REAL,
    source          TEXT DEFAULT 'genie',
    synced_at       TIMESTAMPTZ DEFAULT NOW(),
    created_at      TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pvl_genie 
ON patient_vitals_log(genie_id) 
WHERE genie_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pvl_patient 
ON patient_vitals_log(patient_id);

CREATE INDEX IF NOT EXISTS idx_pvl_date 
ON patient_vitals_log(patient_id, recorded_date);

CREATE TABLE IF NOT EXISTS patient_activity_log (
    id                SERIAL PRIMARY KEY,
    patient_id        INTEGER NOT NULL REFERENCES patients(id),
    genie_id          TEXT,
    activity_type     TEXT NOT NULL,      -- Exercise, Sleep, Mood, Body
    value             TEXT,
    value2            TEXT,
    context           TEXT,
    duration_minutes  REAL,
    mood_score        REAL,
    log_date          DATE NOT NULL,
    log_time          TEXT,
    source            TEXT DEFAULT 'genie',
    synced_at         TIMESTAMPTZ DEFAULT NOW(),
    created_at        TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pal_genie 
ON patient_activity_log(genie_id) 
WHERE genie_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pal_patient 
ON patient_activity_log(patient_id);

CREATE INDEX IF NOT EXISTS idx_pal_date 
ON patient_activity_log(patient_id, log_date);



CREATE TABLE IF NOT EXISTS patient_symptom_log (
    id                SERIAL PRIMARY KEY,
    patient_id        INTEGER NOT NULL REFERENCES patients(id),
    genie_id          TEXT,
    symptom           TEXT NOT NULL,
    severity          REAL,                -- 1-10
    body_area         TEXT,
    context           TEXT,
    notes             TEXT,
    follow_up_needed  BOOLEAN DEFAULT FALSE,
    log_date          DATE NOT NULL,
    log_time          TEXT,
    source            TEXT DEFAULT 'genie',
    synced_at         TIMESTAMPTZ DEFAULT NOW(),
    created_at        TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_psl_genie 
ON patient_symptom_log(genie_id) 
WHERE genie_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_psl_patient 
ON patient_symptom_log(patient_id);

CREATE INDEX IF NOT EXISTS idx_psl_date 
ON patient_symptom_log(patient_id, log_date);



CREATE TABLE IF NOT EXISTS patient_med_log (
    id                   SERIAL PRIMARY KEY,
    patient_id           INTEGER NOT NULL REFERENCES patients(id),
    genie_id             TEXT,
    medication_name      TEXT,        -- Denormalized med name (from Genie join)
    medication_dose      TEXT,
    genie_medication_id  TEXT,        -- Genie's medication UUID
    log_date             DATE NOT NULL,
    dose_time            TEXT,
    status               TEXT,        -- 'taken'
    source               TEXT DEFAULT 'genie',
    synced_at            TIMESTAMPTZ DEFAULT NOW(),
    created_at           TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pml_genie 
ON patient_med_log(genie_id) 
WHERE genie_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pml_patient 
ON patient_med_log(patient_id);

CREATE INDEX IF NOT EXISTS idx_pml_date 
ON patient_med_log(patient_id, log_date);


CREATE TABLE IF NOT EXISTS patient_meal_log (
    id            SERIAL PRIMARY KEY,
    patient_id    INTEGER NOT NULL REFERENCES patients(id),
    genie_id      TEXT,
    meal_type     TEXT,        -- breakfast, lunch, snack, dinner
    description   TEXT,
    calories      REAL,
    protein_g     REAL,
    carbs_g       REAL,
    fat_g         REAL,
    log_date      DATE NOT NULL,
    source        TEXT DEFAULT 'genie',
    synced_at     TIMESTAMPTZ DEFAULT NOW(),
    created_at    TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pmeal_genie 
ON patient_meal_log(genie_id) 
WHERE genie_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pmeal_patient 
ON patient_meal_log(patient_id);

CREATE INDEX IF NOT EXISTS idx_pmeal_date 
ON patient_meal_log(patient_id, log_date);
