// One-off backfill: mark appointments as 'seen' when HealthRay enrichment is
// complete (diagnoses + medications present) but status was never promoted.
// Root cause fixed in server/services/cron/healthraySync.js; this script
// repairs historical rows.

import "dotenv/config";
import { markAppointmentAsSeen } from "../services/healthray/db.js";
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const { rows } = await pool.query(`
  SELECT id, file_no, patient_name, status, appointment_date
  FROM appointments
  WHERE status NOT IN ('seen', 'cancelled', 'no_show')
    AND jsonb_array_length(COALESCE(healthray_diagnoses,'[]'::jsonb)) > 0
    AND jsonb_array_length(COALESCE(healthray_medications,'[]'::jsonb)) > 0
  ORDER BY appointment_date DESC
`);

console.log(`Found ${rows.length} appointments to backfill`);

let ok = 0;
let fail = 0;
for (const r of rows) {
  try {
    const result = await markAppointmentAsSeen(r.id);
    if (result) {
      ok++;
      if (ok % 25 === 0) console.log(`  ...${ok}/${rows.length} done`);
    } else {
      fail++;
      console.warn(`  skipped id=${r.id} (${r.file_no}) — markAppointmentAsSeen returned null`);
    }
  } catch (e) {
    fail++;
    console.error(`  FAIL id=${r.id} (${r.file_no}): ${e.message}`);
  }
}

console.log(`\nDone: ${ok} marked seen, ${fail} failed/skipped`);
await pool.end();
process.exit(0);
