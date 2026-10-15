CREATE TABLE IF NOT EXISTS rx_parameter_overrides (
  patient_id integer NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  visit_date date NOT NULL,
  rows jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (patient_id, visit_date)
);
