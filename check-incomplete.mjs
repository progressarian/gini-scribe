process.env.DATABASE_URL =
  "postgresql://postgres.vuukipgdegewpwucdgxa:!Jiyo100saal@aws-1-ap-south-1.pooler.supabase.com:6543/postgres";
const { default: pool } = await import("./server/config/db.js");

const PIDS = [1433, 3641, 3685, 4082];
for (const PID of PIDS) {
  console.log(`\n========== Patient ${PID} ==========`);
  const { rows: a } = await pool.query(
    `SELECT healthray_id, appointment_date, healthray_medications
     FROM appointments WHERE patient_id=$1 AND healthray_id IS NOT NULL
       AND jsonb_array_length(COALESCE(healthray_medications,'[]'::jsonb)) > 0
     ORDER BY appointment_date DESC LIMIT 1`,
    [PID],
  );
  if (!a[0]) continue;
  console.log(`Latest hr=${a[0].healthray_id} date=${a[0].appointment_date}`);
  console.log(`HR meds (${a[0].healthray_medications.length}):`);
  a[0].healthray_medications.forEach((m, i) =>
    console.log(`  ${i + 1}. ${m.name} | dose=${m.dose} | route=${m.route}`),
  );
  const { rows: m } = await pool.query(
    `SELECT name, dose, route, pharmacy_match, is_active, notes
     FROM medications WHERE patient_id=$1 AND source='healthray' ORDER BY is_active DESC, name`,
    [PID],
  );
  console.log(`DB medications rows (${m.length}):`);
  m.forEach((x) =>
    console.log(
      `  ${x.is_active ? "✅" : "⏸ "} ${x.name} ${x.dose || ""} | pm=${x.pharmacy_match} | ${x.notes}`,
    ),
  );
}
await pool.end();
