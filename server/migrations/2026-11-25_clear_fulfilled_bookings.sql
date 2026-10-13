CREATE OR REPLACE FUNCTION appointments_clear_fulfilled_bookings()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  WITH fulfilled AS (
    SELECT b.id, b.booking_status, b.preferred_date, b.preferred_time_slot, b.preferred_doctor
      FROM appointments b
     WHERE b.id <> NEW.id
       AND b.patient_id = NEW.patient_id
       AND b.booking_status = 'booked'
       AND GREATEST(b.appointment_date, b.preferred_date) <= NEW.appointment_date
     FOR UPDATE
  )
  INSERT INTO appointment_change_log (appointment_id, field, field_label, old_value, new_value, changed_by)
  SELECT f.id, v.field, v.label, v.old_value, NULL, 'Visit completed'
    FROM fulfilled f
   CROSS JOIN LATERAL (VALUES
     ('booking_status', 'Booking Status', f.booking_status),
     ('preferred_date', 'Preferred Date', f.preferred_date::text),
     ('preferred_time_slot', 'Preferred Time', f.preferred_time_slot),
     ('preferred_doctor', 'Preferred Doctor', f.preferred_doctor)
   ) AS v(field, label, old_value)
   WHERE NULLIF(v.old_value, '') IS NOT NULL;

  UPDATE appointments b
     SET booking_status = NULL, preferred_date = NULL, preferred_time_slot = NULL,
         preferred_doctor = NULL, updated_at = NOW()
   WHERE b.id <> NEW.id
     AND b.patient_id = NEW.patient_id
     AND b.booking_status = 'booked'
     AND GREATEST(b.appointment_date, b.preferred_date) <= NEW.appointment_date;

  RETURN NULL;
END;
$$;

CREATE OR REPLACE TRIGGER appointments_clear_fulfilled_bookings
  AFTER UPDATE OF status ON appointments
  FOR EACH ROW
  WHEN (NEW.status IN ('completed', 'seen')
        AND OLD.status IS DISTINCT FROM NEW.status
        AND NEW.patient_id IS NOT NULL
        AND NEW.appointment_date IS NOT NULL
        AND LOWER(TRIM(COALESCE(NEW.doctor_name, ''))) <> 'dr. hospital admin')
  EXECUTE FUNCTION appointments_clear_fulfilled_bookings();
