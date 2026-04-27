// Verify: for every patient with an upcoming appointment, the medications
// table has active rows tagged to their LATEST healthray prescription's hr_id.

process.env.DATABASE_URL =
  "postgresql://postgres.vuukipgdegewpwucdgxa:!Jiyo100saal@aws-1-ap-south-1.pooler.supabase.com:6543/postgres";

const { default: pool } = await import("./server/config/db.js");

const { rows } = await pool.query(`
WITH future_pts AS (
  SELECT DISTINCT patient_id FROM appointments WHERE appointment_date >= CURRENT_DATE
),
latest_rx AS (
  SELECT DISTINCT ON (a.patient_id)
         a.patient_id, a.healthray_id, a.appointment_date,
         jsonb_array_length(a.healthray_medications) AS expected
  FROM appointments a
  WHERE a.healthray_id IS NOT NULL
    AND a.healthray_medications IS NOT NULL
    AND jsonb_array_length(a.healthray_medications) > 0
    AND a.patient_id IN (SELECT patient_id FROM future_pts)
  ORDER BY a.patient_id, a.appointment_date DESC, a.id DESC
),
tagged AS (
  SELECT m.patient_id, SUBSTRING(m.notes FROM 'healthray:([0-9]+)') AS hr_id,
         COUNT(*) FILTER (WHERE m.is_active = true) AS active_count
  FROM medications m
  WHERE m.source = 'healthray' AND m.notes LIKE 'healthray:%'
  GROUP BY m.patient_id, hr_id
)
SELECT l.patient_id, l.healthray_id, l.appointment_date,
       l.expected, COALESCE(t.active_count, 0) AS active
FROM latest_rx l
LEFT JOIN tagged t ON t.patient_id = l.patient_id AND t.hr_id = l.healthray_id::text
WHERE COALESCE(t.active_count, 0) < l.expected
ORDER BY l.patient_id;
`);

console.log(`Patients whose LATEST prescription is still under-synced: ${rows.length}`);
for (const r of rows) {
  console.log(
    `  pid=${r.patient_id} hr=${r.healthray_id} ${r.appointment_date} expected=${r.expected} active=${r.active}`,
  );
}
await pool.end();
