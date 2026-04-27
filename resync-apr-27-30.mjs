// Re-run the HealthRay sync for appointments on Apr 27, 28, 29, 30 2026.
// Clears the JSONB fast-path on each affected appointment so the re-parse
// goes through Claude with the new temperature: 0 + brand/unit fidelity prompt.

process.env.DATABASE_URL =
  "postgresql://postgres.vuukipgdegewpwucdgxa:!Jiyo100saal@aws-1-ap-south-1.pooler.supabase.com:6543/postgres";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error(
    "ERROR: ANTHROPIC_API_KEY env var not set — re-extraction needs Claude. Re-run with the prod key.",
  );
  process.exit(1);
}

const { syncWalkingAppointmentsByDate } = await import(
  "./server/services/cron/healthraySync.js"
);
const { default: pool } = await import("./server/config/db.js");

const DATES = ["2026-04-27", "2026-04-28", "2026-04-29", "2026-04-30"];

// Clear the JSONB fast-path on appointments on these dates so re-parse runs.
const { rowCount: cleared } = await pool.query(
  `UPDATE appointments
   SET healthray_diagnoses    = '[]'::jsonb,
       healthray_medications  = '[]'::jsonb,
       updated_at             = NOW()
   WHERE appointment_date = ANY($1::date[])
     AND healthray_clinical_notes IS NOT NULL`,
  [DATES],
);
console.log(`Cleared fast-path on ${cleared} appointments\n`);

const results = [];
for (const d of DATES) {
  console.log(`→ Syncing ${d} ...`);
  try {
    const r = await syncWalkingAppointmentsByDate(d);
    console.log(`   done:`, JSON.stringify(r));
    results.push({ date: d, ok: true, ...r });
  } catch (e) {
    console.error(`   FAILED: ${e.message}`);
    results.push({ date: d, ok: false, error: e.message });
  }
}

console.log("\nSummary:");
for (const r of results) console.log(JSON.stringify(r));

await pool.end();
