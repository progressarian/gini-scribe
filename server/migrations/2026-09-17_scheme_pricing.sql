-- ============================================================
-- Scheme pricing (33-PATIENT-SCHEME-PLAN.md steps 5–7).
-- 2026-09-17
--
-- Rule R2 from the plan: ONE OVERRIDE TABLE PER PRICED DOMAIN, never a column
-- per scheme. A new scheme is a row in patient_schemes; a new priced domain is
-- a new table here. Neither is a schema change to anything that already works.
--
-- Rule R3: resolution is always "override if present, else the base price".
-- Schemes differ on some items, not all, so these tables stay small and
-- onboarding a scheme is not forty rows of re-entry.
--
-- All three ship EMPTY. The hospital's rate card has not landed yet, and a
-- scheme override invented here would be worse than none — it would look
-- authoritative. server/services/pricing.js falls back to the base price for
-- every row that is missing, which is exactly today's behaviour.
--
-- Idempotent.
-- ============================================================

-- ── Tests / investigations ─────────────────────────────────────────────────
-- giniflow_test_catalog.test_name is UNIQUE, so a scheme dimension cannot live
-- on that table; a companion keyed on the same name is the only shape.
CREATE TABLE IF NOT EXISTS scheme_test_prices (
  scheme_code TEXT NOT NULL REFERENCES patient_schemes(code) ON DELETE CASCADE,
  test_name   TEXT NOT NULL,
  price       NUMERIC(10, 2) NOT NULL CHECK (price >= 0),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (scheme_code, test_name)
);

-- ── OPD consultation fee ───────────────────────────────────────────────────
-- Display only (plan D3): HealthRay raises the OPD bill and exposes no write
-- path, so Gini shows the right number at check-in and at the billing step for
-- the person keying it in. Reconciliation is deliberately not in scope.
--
-- doctor_id NULL = the scheme's default for that visit type; a row WITH a
-- doctor is that consultant's rate. Resolution takes the more specific one.
CREATE TABLE IF NOT EXISTS scheme_opd_fees (
  scheme_code TEXT NOT NULL REFERENCES patient_schemes(code) ON DELETE CASCADE,
  doctor_id   INTEGER REFERENCES doctors(id) ON DELETE CASCADE,
  visit_type  TEXT NOT NULL,
  fee         NUMERIC(10, 2) NOT NULL CHECK (fee >= 0),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A partial unique index rather than a primary key: NULL doctor_id is the
-- scheme default, and NULLs do not compare equal in a UNIQUE constraint, so
-- without this two "default" rows for the same scheme+visit_type could coexist
-- and the resolver would silently pick one.
CREATE UNIQUE INDEX IF NOT EXISTS idx_scheme_opd_fees_default
  ON scheme_opd_fees (scheme_code, visit_type) WHERE doctor_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_scheme_opd_fees_doctor
  ON scheme_opd_fees (scheme_code, visit_type, doctor_id) WHERE doctor_id IS NOT NULL;

-- ── Medicines ──────────────────────────────────────────────────────────────
-- The base catalogue does not exist yet: nothing in the pharmacy path has ever
-- had a price (plan §4c). This is that catalogue, keyed on the canonical name
-- medications.pharmacy_match already normalises to, so a brand and its variants
-- price once.
--
-- 9,964 distinct medicines have been prescribed; 2,129 in the last 60 days. A
-- flat list is not the way in — the top 200 by volume cover 80% of
-- prescriptions (plan D6), so this fills by use, and `source` says which rows
-- are real, exactly as giniflow_test_catalog does.
CREATE TABLE IF NOT EXISTS medicine_catalog (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  price      NUMERIC(10, 2) CHECK (price IS NULL OR price >= 0),
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  -- NULL price + 'unpriced' means "we know this medicine, nobody has costed it
  -- yet". Honest, and visible: the counter is told rather than shown a zero.
  source     TEXT NOT NULL DEFAULT 'unpriced',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS scheme_medicine_prices (
  scheme_code   TEXT NOT NULL REFERENCES patient_schemes(code) ON DELETE CASCADE,
  medicine_name TEXT NOT NULL,
  price         NUMERIC(10, 2) NOT NULL CHECK (price >= 0),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (scheme_code, medicine_name)
);

-- ── The scheme travels with the order ──────────────────────────────────────
-- The tag lives on `appointments`; a lab order had no way to see it. Snapshotted
-- at order time for the same reason the line price is: a scheme corrected next
-- week must not re-price last week's settled order (plan §4a).
ALTER TABLE giniflow_lab_orders
  ADD COLUMN IF NOT EXISTS scheme_code TEXT;
