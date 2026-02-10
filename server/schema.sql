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
  role          TEXT DEFAULT 'MO',  -- 'MO','Consultant','Surgeon'
  speciality    TEXT,
  license_no    TEXT,
  phone         TEXT,
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
  since_year      INTEGER,            -- Year of diagnosis
  notes           TEXT,
  is_active       BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_diagnoses_patient ON diagnoses(patient_id);

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
  is_new          BOOLEAN DEFAULT FALSE,
  is_active       BOOLEAN DEFAULT TRUE,-- Still taking
  started_date    DATE,
  stopped_date    DATE,
  stop_reason     TEXT,                -- 'Side effect','Replaced','Goal met'
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_medications_patient ON medications(patient_id);
CREATE INDEX idx_medications_active ON medications(patient_id, is_active);

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
  source          TEXT DEFAULT 'lab',  -- 'lab','manual','scribe'
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_labs_patient ON lab_results(patient_id);
CREATE INDEX idx_labs_test ON lab_results(patient_id, test_name);
CREATE INDEX idx_labs_date ON lab_results(test_date);

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
  source          TEXT,                -- 'upload','scan','gini_system','external'
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_documents_patient ON documents(patient_id);

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
