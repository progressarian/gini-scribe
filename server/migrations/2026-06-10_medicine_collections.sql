-- ============================================================
-- Medicine collection tracking (pharmacy fulfillment)
-- 2026-06-10
--
-- Records whether a patient collected each prescribed medicine at the pharmacy.
-- One row per (medicine, pickup-day); absence of a row = "pending" (not yet
-- marked). Re-mark same day = update; a later visit = a new row (history).
-- Additive only — nothing in `medications` is changed.
-- See docs/medicines-management/.
-- ============================================================

CREATE TABLE IF NOT EXISTS medicine_collections (
  id              SERIAL PRIMARY KEY,
  medication_id   INTEGER NOT NULL REFERENCES medications(id) ON DELETE CASCADE,
  patient_id      INTEGER NOT NULL REFERENCES patients(id),
  appointment_id  INTEGER REFERENCES appointments(id),   -- best-effort visit link (nullable)
  collected_date  DATE NOT NULL DEFAULT CURRENT_DATE,
  status          TEXT NOT NULL CHECK (status IN ('given', 'not_given', 'partial')),
  reason          TEXT,        -- out_of_stock | patient_declined | buying_outside | not_available | other
  qty_note        TEXT,        -- e.g. "15 of 30 tablets"
  marked_by       TEXT,
  marked_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (medication_id, collected_date)
);

CREATE INDEX IF NOT EXISTS idx_medcoll_patient_date
  ON medicine_collections (patient_id, collected_date);
CREATE INDEX IF NOT EXISTS idx_medcoll_date
  ON medicine_collections (collected_date);
CREATE INDEX IF NOT EXISTS idx_medcoll_appt
  ON medicine_collections (appointment_id);
