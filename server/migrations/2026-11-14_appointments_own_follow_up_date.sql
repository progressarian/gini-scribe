ALTER TABLE appointments ADD COLUMN IF NOT EXISTS own_follow_up_date DATE;

CREATE OR REPLACE FUNCTION appointment_own_follow_up(
  follow_up_date DATE,
  biomarkers JSONB,
  healthray_follow_up JSONB,
  appointment_date DATE
)
RETURNS DATE
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  from_biomarkers DATE;
BEGIN
  BEGIN
    from_biomarkers := NULLIF(biomarkers->>'followup', '')::date;
  EXCEPTION WHEN others THEN
    from_biomarkers := NULL;
  END;
  RETURN COALESCE(
    follow_up_date,
    from_biomarkers,
    CASE WHEN healthray_follow_up->>'date' ~ '^\d{4}-\d{2}-\d{2}$'
         THEN (healthray_follow_up->>'date')::date END,
    CASE WHEN appointment_date IS NOT NULL
          AND btrim(lower(healthray_follow_up->>'timing')) ~ '^[0-9]{1,2} *(day|week|month|year)s?$'
         THEN (appointment_date + btrim(lower(healthray_follow_up->>'timing'))::interval)::date END
  );
END;
$$;

CREATE OR REPLACE FUNCTION appointments_own_follow_up_stamp()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.own_follow_up_date := appointment_own_follow_up(
    NEW.follow_up_date, NEW.biomarkers, NEW.healthray_follow_up, NEW.appointment_date
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS appointments_own_follow_up_stamp ON appointments;
CREATE TRIGGER appointments_own_follow_up_stamp
  BEFORE INSERT OR UPDATE OF follow_up_date, biomarkers, healthray_follow_up, appointment_date
  ON appointments
  FOR EACH ROW EXECUTE FUNCTION appointments_own_follow_up_stamp();

UPDATE appointments
   SET own_follow_up_date = appointment_own_follow_up(
         follow_up_date, biomarkers, healthray_follow_up, appointment_date)
 WHERE own_follow_up_date IS DISTINCT FROM appointment_own_follow_up(
         follow_up_date, biomarkers, healthray_follow_up, appointment_date);

CREATE INDEX IF NOT EXISTS idx_appointments_own_follow_up_date
  ON appointments (own_follow_up_date) WHERE own_follow_up_date IS NOT NULL;
