CREATE OR REPLACE FUNCTION skip_sunday(d DATE)
RETURNS DATE
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE WHEN EXTRACT(ISODOW FROM d) = 7 THEN d + 1 ELSE d END
$$;

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
  RETURN skip_sunday(COALESCE(
    follow_up_date,
    from_biomarkers,
    CASE WHEN healthray_follow_up->>'date' ~ '^\d{4}-\d{2}-\d{2}$'
         THEN (healthray_follow_up->>'date')::date END,
    CASE WHEN appointment_date IS NOT NULL
          AND btrim(lower(healthray_follow_up->>'timing')) ~ '^[0-9]{1,2} *(day|week|month|year)s?$'
         THEN (appointment_date + btrim(lower(healthray_follow_up->>'timing'))::interval)::date END
  ));
END;
$$;
