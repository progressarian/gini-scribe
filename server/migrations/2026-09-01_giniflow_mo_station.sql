-- ============================================================
-- Gini Flow — MO / SD station.
-- 2026-09-01
--
-- The station where the queue forms. Brief §4.3: queue, patient brief, plan
-- textarea, and three actions — Ready for Dr. Bhansali, Order tests, and Close
-- (green-category patients only, skipping the doctor).
--
-- Design: docs/gini-flow/08-MO-SD-STATION-PLAN.md
--
--   node migrations/_runOne.mjs migrations/2026-09-01_giniflow_mo_station.sql
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── The MO's working notes ─────────────────────────────────────────────────
-- One row per visit, updated in place. A draft is not history: the plan that
-- matters is the one standing at hand-off, and an MO interrupted mid-workup
-- should find what they typed, not a trail of revisions.
CREATE TABLE IF NOT EXISTS giniflow_sd_notes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id    UUID NOT NULL UNIQUE REFERENCES giniflow_visits(id) ON DELETE CASCADE,
  plan        TEXT,
  source      TEXT NOT NULL DEFAULT 'typed',   -- typed | voice
  authored_by INT REFERENCES doctors(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Prescription proposals (addendum v1.1, change ③) ───────────────────────
-- The MO proposes "Atchol 20mg → 40mg, LDL 127"; the doctor approves, adjusts
-- or rejects it in Phase 3. Deliberately NOT a prescription: this station must
-- never become a second prescribing path.
CREATE TABLE IF NOT EXISTS giniflow_rx_proposals (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id      UUID NOT NULL REFERENCES giniflow_visits(id) ON DELETE CASCADE,
  medicine_name TEXT NOT NULL,
  from_dose     TEXT,
  to_dose       TEXT,
  reason        TEXT,
  change_type   TEXT NOT NULL DEFAULT 'changed', -- continued|changed|new|stopped|paused
  proposed_by   INT REFERENCES doctors(id),
  status        TEXT NOT NULL DEFAULT 'proposed', -- proposed|approved|adjusted|rejected
  decided_by    INT REFERENCES doctors(id),
  decided_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_giniflow_rx_proposals_visit
  ON giniflow_rx_proposals (visit_id, created_at);

-- ── Test panels ────────────────────────────────────────────────────────────
-- Data, not code: the hospital adds a panel without a deploy, and the same
-- table answers "what is in the kidney panel". Contents from
-- gini-doctor-final.html s-tests.
CREATE TABLE IF NOT EXISTS giniflow_test_panels (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  panel_key     TEXT NOT NULL UNIQUE,
  label         TEXT NOT NULL,
  icon          TEXT,
  test_names    TEXT[] NOT NULL,
  display_order INT NOT NULL DEFAULT 0,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE
);

INSERT INTO giniflow_test_panels (panel_key, label, icon, test_names, display_order) VALUES
  ('diabetes', 'Diabetes panel', '🩸',
     ARRAY['HbA1c','FBS','Post-meal','HOMA-IR'], 1),
  ('lipid', 'Lipid panel', '💛',
     ARRAY['Total cholesterol','LDL','HDL','TG'], 2),
  ('kidney', 'Kidney panel', '🫘',
     ARRAY['Creatinine','eGFR','UACR','Urine R/M'], 3),
  ('thyroid', 'Thyroid panel', '🦋',
     ARRAY['TSH','FT3','FT4'], 4),
  ('cardiac', 'Cardiac panel', '❤️',
     ARRAY['ECG','NT-proBNP','hs-CRP'], 5),
  ('full', 'Full workup', '🩺',
     ARRAY['HbA1c','FBS','Post-meal','HOMA-IR','Total cholesterol','LDL','HDL','TG',
           'Creatinine','eGFR','UACR','Urine R/M','CBC','LFT','TSH','Vit D','Vit B12',
           'Fasting Insulin'], 6)
ON CONFLICT (panel_key) DO NOTHING;
