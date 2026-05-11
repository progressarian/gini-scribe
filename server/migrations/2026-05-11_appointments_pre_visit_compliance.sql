-- Pre-visit medication-compliance log entered by the patient from
-- MyHealth Genie before their booked OPD/visit. Stored on the
-- `appointments` row alongside `pre_visit_symptoms` so the doctor sees
-- it on /visit page when opening the corresponding consultation.
--
-- pre_visit_compliance     — JSONB array of compliance items the patient
--                            self-reported. Each item: { medication: TEXT,
--                            schedule: TEXT, adherence: TEXT, notes: TEXT }
--                            where `adherence` is one of:
--                              'always' | 'mostly' | 'sometimes' | 'missed'.
--                            The doctor's own OPD compliance lives in
--                            `appointments.compliance` (JSONB object) — kept
--                            on a separate column so neither side overwrites
--                            the other.
-- pre_visit_compliance_at  — when the patient submitted (null = not yet).
--
-- Idempotent — safe to re-run.

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS pre_visit_compliance    JSONB,
  ADD COLUMN IF NOT EXISTS pre_visit_compliance_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_appointments_pre_visit_compliance_at
  ON appointments (pre_visit_compliance_at)
  WHERE pre_visit_compliance_at IS NOT NULL;
