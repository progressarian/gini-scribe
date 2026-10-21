import { AUTO_LAB_BILLING_SQL } from "./stepSql.js";
import { JOURNEY_START_SQL } from "../../../shared/giniflowStatus.js";

export const REST_SKIPPED_SQL = (v) => `EXISTS (
  SELECT 1 FROM doctors rd
   WHERE rd.vitals_rest = false
     AND rd.id = COALESCE(${v}.assigned_doctor_id,
       (SELECT COALESCE(ra.doctor_id,
                 (SELECT d.id FROM doctors d
                   WHERE lower(btrim(d.name)) = lower(btrim(ra.doctor_name))
                   ORDER BY d.is_active IS NOT FALSE DESC, d.id LIMIT 1))
          FROM appointments ra WHERE ra.id = ${v}.appointment_id)))`;

export const ON_VITALS_LEG_SQL = (v) => `NOT (
  EXISTS (SELECT 1 FROM giniflow_visit_steps ps
           WHERE ps.visit_id = ${v}.id AND NOT ${AUTO_LAB_BILLING_SQL("ps")})
  AND NOT EXISTS (
    SELECT 1 FROM giniflow_visit_steps ps
     WHERE ps.visit_id = ${v}.id AND ps.chain_status = 'with_vitals' AND ps.status <> 'skipped'
  ))`;

export const VITALS_STAGE_STATUSES = ["checked_in", "vitals_pending", "with_vitals"];

export const VITALS_FROM_SQL = (v) => `CASE
  WHEN ${v}.current_status IN ('checked_in', 'vitals_pending', 'with_vitals')
   AND ${ON_VITALS_LEG_SQL(v)}
  THEN (SELECT max(re.occurred_at) FROM giniflow_visit_events re
         WHERE re.visit_id = ${v}.id AND ${JOURNEY_START_SQL("re.status")})
END`;

export const wholeVitalsBudget = (budgetFor, category) => {
  const wait = budgetFor("checkin_to_vitals", category);
  const station = budgetFor("vitals", category);
  return wait === null || station === null ? (station ?? wait) : wait + station;
};
