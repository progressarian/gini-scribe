import pool from "../config/db.js";

const ATTENDED = `'{"seen","completed","checkedin","in_visit","in-progress"}'::text[]`;

const SQL = `
WITH visits AS (
  SELECT patient_id, doctor, d FROM (
    SELECT c.patient_id, NULLIF(TRIM(c.con_name), '') AS doctor, c.visit_date::date AS d
      FROM consultations c WHERE c.patient_id IS NOT NULL
    UNION
    SELECT a.patient_id, NULLIF(TRIM(a.doctor_name), ''), a.appointment_date
      FROM appointments a
     WHERE a.patient_id IS NOT NULL AND a.appointment_date IS NOT NULL
       AND a.status = ANY(${ATTENDED})
  ) t
  WHERE doctor IS NOT NULL AND d IS NOT NULL
),
latest AS (
  SELECT DISTINCT ON (patient_id) patient_id, doctor, d
    FROM visits ORDER BY patient_id, d DESC, doctor
),
tally AS (
  SELECT patient_id, doctor, COUNT(*)::int AS visits FROM visits GROUP BY 1, 2
),
most_seen AS (
  SELECT DISTINCT ON (patient_id) patient_id, doctor, visits
    FROM tally ORDER BY patient_id, visits DESC, doctor
)
SELECT NULLIF(BTRIM(regexp_replace(p.name, '[[:space:]]+', ' ', 'g')), '') AS name,
       p.file_no,
       p.sex,
       COALESCE(
         CASE WHEN p.dob IS NOT NULL THEN date_part('year', age(p.dob))::int END,
         p.age
       ) AS age,
       p.dob::text AS dob,
       p.phone,
       ARRAY_TO_STRING(
         ARRAY(SELECT DISTINCT a FROM unnest(COALESCE(p.alt_phone, '{}')) a
                WHERE NULLIF(BTRIM(a), '') IS NOT NULL AND a IS DISTINCT FROM p.phone),
         ', '
       ) AS alt_phones,
       NULLIF(BTRIM(regexp_replace(p.address, '[[:space:]]+', ' ', 'g')), '') AS address,
       l.doctor AS latest_doctor,
       l.d::text AS last_visit,
       m.doctor AS most_seen_doctor,
       m.visits AS most_seen_visits,
       p.created_at::date::text AS registered_on,
       COALESCE(p.is_blocked, FALSE) AS is_blocked
  FROM patients p
  LEFT JOIN latest l ON l.patient_id = p.id
  LEFT JOIN most_seen m ON m.patient_id = p.id
 ORDER BY BTRIM(regexp_replace(p.name, '[[:space:]]+', ' ', 'g')) NULLS LAST, p.file_no NULLS LAST, p.id`;

export async function patientDirectory(db = pool) {
  const { rows } = await db.query(SQL);
  return rows;
}
