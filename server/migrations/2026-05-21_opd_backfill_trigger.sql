-- Per-appointment OPD backfill: trigger + flag column
--
-- opd_backfilled_at marks an appointment whose clinical notes have already
-- been parsed (parsePrescriptionWithAi) and synced to the normalised
-- diagnoses / medications tables. Both the per-insert LISTEN/NOTIFY listener
-- and the 24h runDailyOpdBackfill use it to avoid re-spending Claude tokens
-- on already-processed rows.

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS opd_backfilled_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_appt_backfill_pending
  ON appointments (appointment_date)
  WHERE opd_backfilled_at IS NULL
    AND healthray_clinical_notes IS NOT NULL;

CREATE OR REPLACE FUNCTION notify_appt_inserted() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify(
    'appt_inserted',
    json_build_object(
      'appt_id',      NEW.id,
      'patient_id',   NEW.patient_id,
      'source',       COALESCE(NEW.source, ''),
      'healthray_id', NEW.healthray_id
    )::text
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_appt_notify_insert ON appointments;
CREATE TRIGGER trg_appt_notify_insert
  AFTER INSERT ON appointments
  FOR EACH ROW EXECUTE FUNCTION notify_appt_inserted();
