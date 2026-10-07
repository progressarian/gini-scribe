CREATE TABLE IF NOT EXISTS obt_call_assignments (
  work_date      DATE NOT NULL,
  patient_id     INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  assigned_to_id INTEGER NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  assigned_by_id INTEGER REFERENCES doctors(id) ON DELETE SET NULL,
  assigned_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (work_date, patient_id)
);

CREATE INDEX IF NOT EXISTS idx_obt_call_assignments_member
  ON obt_call_assignments (work_date, assigned_to_id);
