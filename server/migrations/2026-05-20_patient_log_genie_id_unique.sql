-- Make ON CONFLICT (patient_id, genie_id) actually dedup on re-import.
-- Plain unique indexes — Postgres permits multiple NULLs in a unique index
-- so legacy rows with genie_id=NULL coexist freely, while every imported
-- row (which always carries a genie_id) is enforced unique.

CREATE UNIQUE INDEX IF NOT EXISTS idx_patient_vitals_log_genie
  ON patient_vitals_log(patient_id, genie_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_patient_meal_log_genie
  ON patient_meal_log(patient_id, genie_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_patient_activity_log_genie
  ON patient_activity_log(patient_id, genie_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_patient_symptom_log_genie
  ON patient_symptom_log(patient_id, genie_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_patient_med_log_genie
  ON patient_med_log(patient_id, genie_id);

-- meal_logs needs idempotency by (patient_id, source_id). Non-partial index;
-- Postgres allows multiple NULLs in unique indexes so legacy rows are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS idx_meal_logs_patient_source
  ON meal_logs(patient_id, source_id);

-- patient_reported_side_effects has no genie_id; dedup by (patient_id, name, reported_at).
-- Cheap protection against double-clicks; not strictly genie-aware.
CREATE UNIQUE INDEX IF NOT EXISTS idx_side_effects_dedup
  ON patient_reported_side_effects(patient_id, name, reported_at);
