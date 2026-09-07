-- 31-MO-LED-CLOSURE-PLAN §6. The MO's attestation that they read the reports
-- and what they concluded. Nullable with no backfill: a visit closed before
-- this shipped has no attestation, which is the truth about it.
ALTER TABLE giniflow_sd_notes
  ADD COLUMN IF NOT EXISTS reports_reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reports_reviewed_by INTEGER REFERENCES doctors(id),
  ADD COLUMN IF NOT EXISTS reports_outcome     TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'giniflow_sd_notes_reports_outcome_chk'
  ) THEN
    ALTER TABLE giniflow_sd_notes
      ADD CONSTRAINT giniflow_sd_notes_reports_outcome_chk
      CHECK (reports_outcome IS NULL OR reports_outcome IN ('normal', 'needs_consultant'));
  END IF;
END $$;

ALTER TABLE giniflow_sd_notes
  ADD COLUMN IF NOT EXISTS reports_review_note TEXT;
