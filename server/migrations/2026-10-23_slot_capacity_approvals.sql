ALTER TABLE doctor_slot_template_hours
  ADD COLUMN IF NOT EXISTS cap_new      SMALLINT CHECK (cap_new BETWEEN 0 AND 99),
  ADD COLUMN IF NOT EXISTS cap_followup SMALLINT CHECK (cap_followup BETWEEN 0 AND 99),
  ADD COLUMN IF NOT EXISTS cap_walkin   SMALLINT CHECK (cap_walkin BETWEEN 0 AND 99);

CREATE TABLE IF NOT EXISTS booking_approvals (
  id                SERIAL PRIMARY KEY,
  appointment_id    INTEGER NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  doctor_id         INTEGER REFERENCES doctors(id) ON DELETE SET NULL,
  appointment_date  DATE NOT NULL,
  slot_label        TEXT NOT NULL,
  patient_type      TEXT NOT NULL CHECK (patient_type IN ('new', 'followup', 'walkin')),
  limit_at_request  SMALLINT NOT NULL,
  count_at_request  SMALLINT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
  requested_by      INTEGER REFERENCES doctors(id) ON DELETE SET NULL,
  requested_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_by        INTEGER REFERENCES doctors(id) ON DELETE SET NULL,
  decided_at        TIMESTAMPTZ,
  reason            TEXT CHECK (reason IS NULL OR char_length(reason) <= 300),
  CHECK ((status = 'pending') = (decided_at IS NULL)),
  CHECK (status <> 'rejected' OR btrim(COALESCE(reason, '')) <> '')
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_booking_approvals_pending
  ON booking_approvals (appointment_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_booking_approvals_status_date
  ON booking_approvals (status, appointment_date);
CREATE INDEX IF NOT EXISTS idx_booking_approvals_appointment
  ON booking_approvals (appointment_id);

CREATE OR REPLACE FUNCTION booking_approvals_decide_once()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'pending'
     AND NEW.id = OLD.id
     AND NEW.appointment_id = OLD.appointment_id
     AND NEW.patient_type = OLD.patient_type
     AND NEW.slot_label = OLD.slot_label
     AND NEW.appointment_date = OLD.appointment_date
     AND NEW.limit_at_request = OLD.limit_at_request
     AND NEW.count_at_request = OLD.count_at_request
     AND NEW.requested_by IS NOT DISTINCT FROM OLD.requested_by
     AND NEW.requested_at = OLD.requested_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'booking_approvals rows are decided once: only a pending request can change, and only its decision';
END;
$$;
DROP TRIGGER IF EXISTS trg_booking_approvals_decide_once ON booking_approvals;
CREATE TRIGGER trg_booking_approvals_decide_once
  BEFORE UPDATE ON booking_approvals
  FOR EACH ROW EXECUTE FUNCTION booking_approvals_decide_once();

ALTER TABLE booking_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_approvals FORCE ROW LEVEL SECURITY;
REVOKE ALL ON booking_approvals FROM anon, authenticated;
