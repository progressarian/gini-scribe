CREATE OR REPLACE FUNCTION booking_approvals_withdraw_on_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.status IN ('cancelled', 'no_show')
     OR NEW.appointment_date IS DISTINCT FROM OLD.appointment_date
     OR NEW.time_slot IS DISTINCT FROM OLD.time_slot
     OR NEW.doctor_name IS DISTINCT FROM OLD.doctor_name THEN
    UPDATE booking_approvals
       SET status = 'withdrawn',
           decided_at = NOW(),
           reason = CASE WHEN NEW.status IN ('cancelled', 'no_show')
                         THEN 'Booking cancelled'
                         ELSE 'Booking moved to another date, time or doctor' END
     WHERE appointment_id = NEW.id AND status = 'pending';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_booking_approvals_withdraw_on_change ON appointments;
CREATE TRIGGER trg_booking_approvals_withdraw_on_change
  AFTER UPDATE OF status, appointment_date, time_slot, doctor_name ON appointments
  FOR EACH ROW EXECUTE FUNCTION booking_approvals_withdraw_on_change();
