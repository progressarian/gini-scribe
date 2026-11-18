SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS giniflow_outside_removals (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('order', 'case')),
  ref TEXT NOT NULL,
  patient_id INT,
  tests TEXT[] NOT NULL DEFAULT ARRAY[]::text[],
  reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 300),
  removed_by INT REFERENCES doctors(id) ON DELETE SET NULL,
  removed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (kind, ref)
);
