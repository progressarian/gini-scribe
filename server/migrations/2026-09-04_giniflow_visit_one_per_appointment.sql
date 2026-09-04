-- One appointment may back at most one Gini Flow visit.
--
-- Without this, a patient record split (HealthRay minting a second `patients`
-- row for someone it already held, then re-pointing the appointment) left the
-- original visit orphaned and the sync created a second one. Both rendered as
-- cards; the orphan could never be moved by any station, because vitals and
-- events were recorded against the other patient_id.
--
-- Requires server/scripts/merge-ghost-giniflow-visits.mjs to have run first.

DO $$
DECLARE
  offenders INT;
BEGIN
  SELECT count(*) INTO offenders FROM (
    SELECT appointment_id FROM giniflow_visits
     WHERE appointment_id IS NOT NULL
     GROUP BY appointment_id HAVING count(*) > 1
  ) t;

  IF offenders > 0 THEN
    RAISE EXCEPTION
      'Cannot add uq_giniflow_visits_appointment: % appointment(s) still back more than one visit. Run: node scripts/merge-ghost-giniflow-visits.mjs --apply',
      offenders;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_giniflow_visits_appointment
  ON giniflow_visits (appointment_id)
  WHERE appointment_id IS NOT NULL;
