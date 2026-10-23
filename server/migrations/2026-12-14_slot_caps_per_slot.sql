ALTER TABLE doctor_slot_template_hours
  ADD COLUMN IF NOT EXISTS cap_within3 SMALLINT CHECK (cap_within3 BETWEEN 0 AND 99);

CREATE TABLE IF NOT EXISTS doctor_slot_template_slot_caps (
  id            SERIAL PRIMARY KEY,
  template_id   INTEGER NOT NULL REFERENCES doctor_slot_templates(id) ON DELETE CASCADE,
  weekday       SMALLINT NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  slot_start    TIME NOT NULL,
  cap_new       SMALLINT CHECK (cap_new BETWEEN 0 AND 99),
  cap_followup  SMALLINT CHECK (cap_followup BETWEEN 0 AND 99),
  cap_walkin    SMALLINT CHECK (cap_walkin BETWEEN 0 AND 99),
  cap_within3   SMALLINT CHECK (cap_within3 BETWEEN 0 AND 99),
  UNIQUE (template_id, weekday, slot_start)
);

DROP TRIGGER IF EXISTS trg_doctor_slot_template_slot_caps_frozen ON doctor_slot_template_slot_caps;
CREATE TRIGGER trg_doctor_slot_template_slot_caps_frozen
  BEFORE UPDATE ON doctor_slot_template_slot_caps
  FOR EACH ROW EXECUTE FUNCTION doctor_slot_template_parts_frozen();

CREATE TABLE IF NOT EXISTS doctor_slot_date_caps (
  id            SERIAL PRIMARY KEY,
  doctor_id     INTEGER NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  slot_date     DATE NOT NULL,
  slot_start    TIME NOT NULL,
  cap_new       SMALLINT CHECK (cap_new BETWEEN 0 AND 99),
  cap_followup  SMALLINT CHECK (cap_followup BETWEEN 0 AND 99),
  cap_walkin    SMALLINT CHECK (cap_walkin BETWEEN 0 AND 99),
  cap_within3   SMALLINT CHECK (cap_within3 BETWEEN 0 AND 99),
  reason        TEXT NOT NULL CHECK (btrim(reason) <> '' AND char_length(reason) <= 300),
  created_by    INTEGER REFERENCES doctors(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (doctor_id, slot_date, slot_start)
);

CREATE INDEX IF NOT EXISTS idx_doctor_slot_date_caps_doctor_date
  ON doctor_slot_date_caps (doctor_id, slot_date);

ALTER TABLE booking_approvals DROP CONSTRAINT IF EXISTS booking_approvals_patient_type_check;
ALTER TABLE booking_approvals
  ADD CONSTRAINT booking_approvals_patient_type_check
  CHECK (patient_type IN ('new', 'followup', 'walkin', 'within3'));

ALTER TABLE doctor_slot_template_slot_caps ENABLE ROW LEVEL SECURITY;
ALTER TABLE doctor_slot_template_slot_caps FORCE ROW LEVEL SECURITY;
REVOKE ALL ON doctor_slot_template_slot_caps FROM anon, authenticated;

ALTER TABLE doctor_slot_date_caps ENABLE ROW LEVEL SECURITY;
ALTER TABLE doctor_slot_date_caps FORCE ROW LEVEL SECURITY;
REVOKE ALL ON doctor_slot_date_caps FROM anon, authenticated;
