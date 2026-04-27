// Detect all patients where appointments.healthray_medications has entries
// but the medications table has zero ACTIVE rows tagged with that healthrayId.
// Scope: patients who also have an upcoming (future) appointment, so the gap
// affects their next visit.

process.env.DATABASE_URL =
  "postgresql://postgres.vuukipgdegewpwucdgxa:!Jiyo100saal@aws-1-ap-south-1.pooler.supabase.com:6543/postgres";

const { default: pool } = await import("./server/config/db.js");

const SQL = `
WITH future_pts AS (
  SELECT DISTINCT patient_id
  FROM appointments
  WHERE appointment_date >= CURRENT_DATE
),
prescriptions AS (
  SELECT a.patient_id, a.id AS appt_id, a.healthray_id, a.appointment_date,
         jsonb_array_length(a.healthray_medications) AS expected
  FROM appointments a
  WHERE a.healthray_id IS NOT NULL
    AND a.healthray_medications IS NOT NULL
    AND jsonb_array_length(a.healthray_medications) > 0
    AND a.patient_id IN (SELECT patient_id FROM future_pts)
),
tagged AS (
  SELECT m.patient_id,
         SUBSTRING(m.notes FROM 'healthray:([0-9]+)') AS hr_id,
         COUNT(*) FILTER (WHERE m.is_active = true) AS active_count
  FROM medications m
  WHERE m.source = 'healthray' AND m.notes LIKE 'healthray:%'
  GROUP BY m.patient_id, hr_id
)
SELECT p.patient_id, p.appt_id, p.healthray_id, p.appointment_date,
       p.expected, COALESCE(t.active_count, 0) AS active_for_this_hr
FROM prescriptions p
LEFT JOIN tagged t
  ON t.patient_id = p.patient_id AND t.hr_id = p.healthray_id::text
WHERE COALESCE(t.active_count, 0) = 0
ORDER BY p.patient_id, p.appointment_date;
`;

const { rows } = await pool.query(SQL);
console.log(`\nAffected prescription rows: ${rows.length}`);
const byPatient = new Map();
for (const r of rows) {
  if (!byPatient.has(r.patient_id)) byPatient.set(r.patient_id, []);
  byPatient.get(r.patient_id).push(r);
}
console.log(`Affected unique patients: ${byPatient.size}\n`);
for (const [pid, list] of byPatient) {
  console.log(`Patient ${pid}: ${list.length} appt(s) missing`);
  for (const r of list) {
    console.log(
      `  - ${r.appointment_date} hr_id=${r.healthray_id} expected=${r.expected} active=${r.active_for_this_hr}`,
    );
  }
}
await pool.end();
