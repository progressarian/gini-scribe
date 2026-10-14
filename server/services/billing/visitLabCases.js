import { CASE_NOT_CANCELLED_SQL } from "../giniflow/testsHold.js";

export const LAB_CASE_REGISTERED_AT_SQL = (lc) => `
  COALESCE(
    CASE WHEN ${lc}.raw_list_json->>'registered_at' ~ '^\\d{4}-\\d{2}-\\d{2}'
         THEN (${lc}.raw_list_json->>'registered_at')::timestamptz END,
    ${lc}.fetched_at)`;

export const VISIT_LAB_CASE_TESTS_SQL = (v) => `
  SELECT lc.case_no, btrim(n.test_name) AS test_name, ${LAB_CASE_REGISTERED_AT_SQL("lc")} AS registered_at
    FROM lab_cases lc
    CROSS JOIN LATERAL unnest(COALESCE(lc.test_names, '{}'::text[])) AS n(test_name)
   WHERE (lc.appointment_id = ${v}.appointment_id
          OR (lc.case_date = ${v}.visit_date
              AND (lc.patient_id = ${v}.patient_id
                   OR (lc.patient_id IS NULL
                       AND lc.raw_list_json->'patient'->>'healthray_uid' = ${v}.file_no))
              AND NOT EXISTS (SELECT 1 FROM giniflow_visits ov
                               WHERE ov.appointment_id = lc.appointment_id
                                 AND ov.id <> ${v}.id)))
     AND btrim(n.test_name) <> ''
     AND ${CASE_NOT_CANCELLED_SQL("lc")}`;
