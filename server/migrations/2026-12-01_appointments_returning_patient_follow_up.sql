CREATE OR REPLACE FUNCTION appointment_is_new_type(visit_type TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT btrim(COALESCE(visit_type, '')) = '' OR lower(btrim(visit_type)) LIKE 'new%'
$$;

CREATE OR REPLACE FUNCTION appointment_patient_came_before(patient INT, on_date DATE)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM appointments prior
     WHERE prior.patient_id = patient
       AND prior.appointment_date < on_date
       AND prior.status IN ('seen', 'completed', 'checkedin', 'in_visit', 'in-progress')
       AND lower(btrim(COALESCE(prior.doctor_name, ''))) <> 'dr. hospital admin'
  )
$$;

CREATE OR REPLACE FUNCTION appointments_returning_patient_follow_up()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.patient_id IS NOT NULL
     AND NEW.appointment_date IS NOT NULL
     AND appointment_is_new_type(NEW.visit_type)
     AND appointment_patient_came_before(NEW.patient_id, NEW.appointment_date) THEN
    NEW.visit_type := 'Follow-Up';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS appointments_returning_patient_follow_up ON appointments;
CREATE TRIGGER appointments_returning_patient_follow_up
  BEFORE INSERT OR UPDATE OF visit_type, patient_id, appointment_date
  ON appointments
  FOR EACH ROW EXECUTE FUNCTION appointments_returning_patient_follow_up();

CREATE OR REPLACE FUNCTION appointments_attended_makes_later_follow_up()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.patient_id IS NOT NULL
     AND NEW.appointment_date IS NOT NULL
     AND NEW.status IN ('seen', 'completed', 'checkedin', 'in_visit', 'in-progress')
     AND lower(btrim(COALESCE(NEW.doctor_name, ''))) <> 'dr. hospital admin' THEN
    UPDATE appointments
       SET visit_type = 'Follow-Up', updated_at = NOW()
     WHERE patient_id = NEW.patient_id
       AND appointment_date > NEW.appointment_date
       AND appointment_is_new_type(visit_type);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS appointments_attended_makes_later_follow_up ON appointments;
CREATE TRIGGER appointments_attended_makes_later_follow_up
  AFTER INSERT OR UPDATE OF status, patient_id, appointment_date, doctor_name
  ON appointments
  FOR EACH ROW EXECUTE FUNCTION appointments_attended_makes_later_follow_up();
