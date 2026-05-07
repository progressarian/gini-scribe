-- Pre-visit symptoms logged by the patient from MyHealth Genie before
-- their booked OPD/visit. Stored on the appointments row so the doctor
-- sees them on /visit page when opening the corresponding consultation.
--
-- pre_visit_symptoms      — array of selected symptom labels (chips).
-- pre_visit_notes         — free-text "anything else?" from the patient.
-- pre_visit_symptoms_at   — when the patient submitted (null = not yet).

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS pre_visit_symptoms     TEXT[],
  ADD COLUMN IF NOT EXISTS pre_visit_notes        TEXT,
  ADD COLUMN IF NOT EXISTS pre_visit_symptoms_at  TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_appointments_pre_visit_symptoms_at
  ON appointments (pre_visit_symptoms_at)
  WHERE pre_visit_symptoms_at IS NOT NULL;
