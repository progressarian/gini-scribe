-- Patient blocklist. One flag on the canonical patient row, honoured by every
-- booking guard, the message senders and the patient-app session mint.
--
-- Keyed on patients.id, NOT phone and NOT file_no: phone is deliberately
-- non-unique (families share a number, 2026-05-18_patients_phone_non_unique.sql)
-- and HealthRay reassigns file_no to different people
-- (2026-07-14_patient_identity_health_id.sql). Blocking either would hit the
-- wrong person.
--
-- These six columns are written by /api/patient-blocks ONLY. No sync, upsert or
-- patient-edit path may set or clear them.
--
-- Design: docs/PATIENT_BLOCKLIST_PLAN.md
ALTER TABLE patients
  ADD COLUMN IF NOT EXISTS is_blocked          BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS blocked_reason_code TEXT,
  ADD COLUMN IF NOT EXISTS blocked_note        TEXT,
  ADD COLUMN IF NOT EXISTS blocked_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS blocked_by          TEXT,
  ADD COLUMN IF NOT EXISTS blocked_by_id       INTEGER;

CREATE INDEX IF NOT EXISTS idx_patients_blocked
  ON patients (id)
  WHERE is_blocked = TRUE;

-- Append-only history. A block is never silently reverted, so this carries no
-- revert machinery (unlike appointment_change_log). action is one of:
--   block | unblock | override_booking | synced_while_blocked
CREATE TABLE IF NOT EXISTS patient_block_log (
  id          SERIAL PRIMARY KEY,
  patient_id  INTEGER NOT NULL REFERENCES patients(id),
  action      TEXT    NOT NULL,
  reason_code TEXT,
  note        TEXT,
  actor_name  TEXT,
  actor_id    INTEGER,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_patient_block_log_patient
  ON patient_block_log (patient_id, created_at DESC);
