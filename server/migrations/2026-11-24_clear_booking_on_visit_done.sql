CREATE OR REPLACE FUNCTION appointments_clear_kept_booking()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.preferred_date IS NOT NULL
     AND NEW.appointment_date IS NOT NULL
     AND NEW.preferred_date > NEW.appointment_date THEN
    RETURN NEW;
  END IF;

  INSERT INTO appointment_change_log (appointment_id, field, field_label, old_value, new_value, changed_by)
  SELECT NEW.id, f.field, f.label, f.old_value, NULL, 'Visit completed'
    FROM (VALUES
      ('booking_status', 'Booking Status', NEW.booking_status),
      ('preferred_date', 'Preferred Date', NEW.preferred_date::text),
      ('preferred_time_slot', 'Preferred Time', NEW.preferred_time_slot),
      ('preferred_doctor', 'Preferred Doctor', NEW.preferred_doctor)
    ) AS f(field, label, old_value)
   WHERE NULLIF(f.old_value, '') IS NOT NULL;

  NEW.booking_status := NULL;
  NEW.preferred_date := NULL;
  NEW.preferred_time_slot := NULL;
  NEW.preferred_doctor := NULL;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER appointments_clear_kept_booking
  BEFORE UPDATE OF status ON appointments
  FOR EACH ROW
  WHEN (NEW.status IN ('completed', 'seen')
        AND OLD.status IS DISTINCT FROM NEW.status
        AND NEW.booking_status = 'booked')
  EXECUTE FUNCTION appointments_clear_kept_booking();
