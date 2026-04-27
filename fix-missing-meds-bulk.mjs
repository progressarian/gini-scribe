// Bulk-resync medications for every patient with an upcoming appointment whose
// past appointments have healthray_medications JSONB populated but missing
// from the medications table. Replays the cron's exact sync code path.

process.env.DATABASE_URL =
  "postgresql://postgres.vuukipgdegewpwucdgxa:!Jiyo100saal@aws-1-ap-south-1.pooler.supabase.com:6543/postgres";

const { syncMedications, stopStaleHealthrayMeds } = await import(
  "./server/services/healthray/db.js"
);
const { default: pool } = await import("./server/config/db.js");

// Reuse the same detection query — get unique patient_ids
const { rows: affected } = await pool.query(`
  WITH future_pts AS (
    SELECT DISTINCT patient_id FROM appointments WHERE appointment_date >= CURRENT_DATE
  ),
  prescriptions AS (
    SELECT a.patient_id, a.healthray_id, a.appointment_date,
           jsonb_array_length(a.healthray_medications) AS expected
    FROM appointments a
    WHERE a.healthray_id IS NOT NULL
      AND a.healthray_medications IS NOT NULL
      AND jsonb_array_length(a.healthray_medications) > 0
      AND a.patient_id IN (SELECT patient_id FROM future_pts)
  ),
  tagged AS (
    SELECT m.patient_id, SUBSTRING(m.notes FROM 'healthray:([0-9]+)') AS hr_id,
           COUNT(*) FILTER (WHERE m.is_active = true) AS active_count
    FROM medications m
    WHERE m.source = 'healthray' AND m.notes LIKE 'healthray:%'
    GROUP BY m.patient_id, hr_id
  )
  SELECT DISTINCT p.patient_id
  FROM prescriptions p
  LEFT JOIN tagged t ON t.patient_id = p.patient_id AND t.hr_id = p.healthray_id::text
  WHERE COALESCE(t.active_count, 0) = 0
  ORDER BY p.patient_id;
`);

console.log(`Patients to fix: ${affected.length}\n`);

let pIdx = 0;
let pOk = 0;
let pErr = 0;
let totalApptsSynced = 0;

for (const { patient_id } of affected) {
  pIdx++;
  try {
    // Pull every healthray prescription appt for this patient, oldest first.
    const { rows: appts } = await pool.query(
      `SELECT id, healthray_id, appointment_date, healthray_medications
       FROM appointments
       WHERE patient_id = $1
         AND healthray_id IS NOT NULL
         AND jsonb_array_length(COALESCE(healthray_medications,'[]'::jsonb)) > 0
       ORDER BY appointment_date ASC, id ASC`,
      [patient_id],
    );

    for (const a of appts) {
      await syncMedications(
        patient_id,
        a.healthray_id,
        a.appointment_date,
        a.healthray_medications,
      );
      await stopStaleHealthrayMeds(patient_id, a.healthray_id, a.appointment_date);
      totalApptsSynced++;
    }
    pOk++;
    if (pIdx % 10 === 0 || pIdx === affected.length) {
      console.log(
        `[${pIdx}/${affected.length}] ok — last patient_id=${patient_id} (${appts.length} appts)`,
      );
    }
  } catch (e) {
    pErr++;
    console.error(`✗ patient ${patient_id}: ${e.message}`);
  }
  await new Promise((r) => setTimeout(r, 50));
}

console.log(
  `\nDone. patients ok=${pOk} err=${pErr} | total appt-prescriptions resynced=${totalApptsSynced}`,
);

// Re-run detection to verify
const { rows: still } = await pool.query(`
  WITH future_pts AS (
    SELECT DISTINCT patient_id FROM appointments WHERE appointment_date >= CURRENT_DATE
  ),
  prescriptions AS (
    SELECT a.patient_id, a.healthray_id
    FROM appointments a
    WHERE a.healthray_id IS NOT NULL
      AND jsonb_array_length(COALESCE(a.healthray_medications,'[]'::jsonb)) > 0
      AND a.patient_id IN (SELECT patient_id FROM future_pts)
  ),
  tagged AS (
    SELECT m.patient_id, SUBSTRING(m.notes FROM 'healthray:([0-9]+)') AS hr_id,
           COUNT(*) FILTER (WHERE m.is_active = true) AS active_count
    FROM medications m WHERE m.source='healthray' AND m.notes LIKE 'healthray:%'
    GROUP BY m.patient_id, hr_id
  )
  SELECT COUNT(*)::int AS remaining
  FROM prescriptions p
  LEFT JOIN tagged t ON t.patient_id = p.patient_id AND t.hr_id = p.healthray_id::text
  WHERE COALESCE(t.active_count, 0) = 0;
`);
console.log(`Verification: prescriptions still missing meds = ${still[0].remaining}`);

await pool.end();
