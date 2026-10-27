CREATE OR REPLACE FUNCTION crm.accessible_doctor_ids()
RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = crm, public, pg_temp AS $$
  WITH me AS MATERIALIZED (SELECT crm.visible_user_ids() AS ids)
  SELECT a.doctor_id
    FROM crm.doctor_assignments a, me
   WHERE a.effective_to IS NULL
     AND (a.executive_id = ANY (me.ids) OR a.manager_id = ANY (me.ids));
$$;

GRANT EXECUTE ON FUNCTION crm.accessible_doctor_ids() TO crm_app;

DROP POLICY IF EXISTS doctors_read ON crm.doctors;
CREATE POLICY doctors_read ON crm.doctors FOR SELECT
  USING (hospital_id = ANY ((SELECT crm.current_hospital_ids())::uuid[])
         AND ((SELECT crm.sees_whole_universe())
              OR id IN (SELECT crm.accessible_doctor_ids())));

DROP POLICY IF EXISTS doctors_update ON crm.doctors;
CREATE POLICY doctors_update ON crm.doctors FOR UPDATE
  USING (hospital_id = ANY ((SELECT crm.current_hospital_ids())::uuid[])
         AND ((SELECT crm.sees_whole_universe())
              OR id IN (SELECT crm.accessible_doctor_ids())))
  WITH CHECK (hospital_id = ANY ((SELECT crm.current_hospital_ids())::uuid[])
              AND ((SELECT crm.sees_whole_universe())
                   OR id IN (SELECT crm.accessible_doctor_ids())));

DROP POLICY IF EXISTS visits_read ON crm.visits;
CREATE POLICY visits_read ON crm.visits FOR SELECT
  USING (hospital_id = ANY ((SELECT crm.current_hospital_ids())::uuid[])
         AND ((SELECT crm.sees_whole_universe())
              OR executive_id = ANY ((SELECT crm.visible_user_ids())::uuid[])
              OR doctor_id IN (SELECT crm.accessible_doctor_ids())));

ANALYZE crm.doctors;
ANALYZE crm.visits;
ANALYZE crm.doctor_assignments;
