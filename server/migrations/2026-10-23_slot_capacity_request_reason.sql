ALTER TABLE booking_approvals
  ADD COLUMN IF NOT EXISTS request_reason TEXT
    CHECK (request_reason IS NULL OR char_length(request_reason) <= 300);

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
     AND NEW.requested_at = OLD.requested_at
     AND NEW.request_reason IS NOT DISTINCT FROM OLD.request_reason THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'booking_approvals rows are decided once: only a pending request can change, and only its decision';
END;
$$;
