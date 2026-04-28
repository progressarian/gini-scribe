-- Add genie_id to lab_results so syncPatientLogsFromGenie can upsert
-- patient-app self-logged labs (HbA1c, LDL, TSH, Haemoglobin, eGFR) from
-- the Genie Supabase project into scribe Postgres without creating dups.
--
-- Mirrors the patient_vitals_log.genie_id approach used for BP/Sugar/Weight.
-- Plain (non-partial) unique index: Postgres allows multiple NULLs in a
-- unique index, so existing rows with genie_id=NULL coexist freely while
-- non-NULL values are enforced unique. A partial index (WHERE genie_id IS
-- NOT NULL) would also work but requires the same predicate on every
-- ON CONFLICT clause, which is easy to forget.

ALTER TABLE lab_results ADD COLUMN IF NOT EXISTS genie_id UUID;

-- Drop the old partial index if a previous run created one — switching to
-- the plain index lets ON CONFLICT (genie_id) match without an index_predicate.
DROP INDEX IF EXISTS idx_lab_results_genie_id;

CREATE UNIQUE INDEX IF NOT EXISTS idx_lab_results_genie_id
  ON lab_results(genie_id);
