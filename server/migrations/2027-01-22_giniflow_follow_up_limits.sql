CREATE TABLE IF NOT EXISTS giniflow_follow_up_limits (
  id              SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  allowed_per_day INT CHECK (allowed_per_day IS NULL OR allowed_per_day > 0),
  max_per_day     INT CHECK (max_per_day IS NULL OR max_per_day > 0),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by      INT REFERENCES doctors(id),
  CONSTRAINT giniflow_follow_up_limits_allowed_within_max
    CHECK (allowed_per_day IS NULL OR max_per_day IS NULL OR allowed_per_day <= max_per_day)
);

INSERT INTO giniflow_follow_up_limits (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_giniflow_care_plans_next_visit_date
  ON giniflow_care_plans (next_visit_date) WHERE next_visit_date IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_appointments_patient_date
  ON appointments (patient_id, appointment_date DESC);
