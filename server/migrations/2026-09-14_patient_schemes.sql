-- ============================================================
-- Patient schemes become data (33-PATIENT-SCHEME-PLAN.md step 1).
-- 2026-09-14
--
-- The scheme a patient is billed under — CGHS, ECHS, Himachal Govt — was a
-- hardcoded array in shared/patientCategories.js. Adding ECHS was a code change
-- and a deploy, and the brief says more schemes are coming.
--
-- This table is the vocabulary. `code` is the join key every later feature hangs
-- off: scheme_test_prices, scheme_opd_fees, scheme_medicine_prices and the daily
-- cap all key on it. A new scheme is a row; a new priced domain is a table.
-- Neither is a schema change to anything that already works.
--
-- appointments.patient_category keeps its name, its values and its meaning, so
-- there is no data migration and the GHM sheet does not change. The codes below
-- are exactly the ones already in that column's vocabulary.
--
-- daily_cap is carried here from the start (step 4 reads it) because adding a
-- nullable int later is free but re-seeding the table is not. NULL = unlimited,
-- which is what every scheme means until somebody sets a ceiling.
--
-- Idempotent.
-- ============================================================

CREATE TABLE IF NOT EXISTS patient_schemes (
  code         TEXT PRIMARY KEY,
  label        TEXT NOT NULL,
  -- Reuses the pill colours the GHM sheet already renders, so the vocabulary
  -- moving to the database changes no styling.
  color        TEXT NOT NULL DEFAULT 'gray',
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  -- Prompt the desk for a card / beneficiary number. CGHS and ECHS are cards;
  -- Senior Citizen is not.
  requires_ref BOOLEAN NOT NULL DEFAULT FALSE,
  -- Hospital-wide ceiling per calendar day (plan D1). NULL = unlimited.
  daily_cap    INTEGER CHECK (daily_cap IS NULL OR daily_cap >= 0),
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The five already in shared/patientCategories.js, at their existing codes and
-- colours, plus ECHS. ON CONFLICT DO NOTHING so re-running never overwrites a
-- cap or a label an admin has since edited.
INSERT INTO patient_schemes (code, label, color, requires_ref, sort_order) VALUES
  ('cghs',             'CGHS',                'blue',   TRUE,  10),
  ('echs',             'ECHS',                'teal',   TRUE,  20),
  ('himachal_govt',    'Himachal Government', 'green',  FALSE, 30),
  ('senior_citizen',   'Senior Citizen',      'purple', FALSE, 40),
  ('special_discount', 'Special Discount',    'amber',  FALSE, 50)
ON CONFLICT (code) DO NOTHING;

-- The sheet's dropdown and pill filters read this in sort_order; an admin
-- retiring a scheme flips is_active rather than deleting, so historical
-- appointments keep resolving their label.
CREATE INDEX IF NOT EXISTS idx_patient_schemes_active
  ON patient_schemes (sort_order) WHERE is_active;
