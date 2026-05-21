// One-off: for every patient with an appointment on 2026-05-22 or 2026-05-23,
// run backfillPatientOpd(patientId) so their latest historical clinical
// notes get re-parsed + synced into JSONB + diagnoses/medications tables.
//
// Context: those 65 appointments came in from the Google Sheets sync as
// future scheduled visits with NO local clinical notes. They were inserted
// before the new AFTER INSERT trigger / listener was deployed, so the
// listener never fired for them. We simulate the listener here.

import "./server/loadEnv.js";
import pool from "./server/config/db.js";
import { backfillPatientOpd } from "./server/services/cron/healthraySync.js";

const DATES = ["2026-05-22", "2026-05-23"];
const FORCE = process.argv.includes("--force");

async function main() {
  console.log(`Per-patient backfill targets: ${DATES.join(", ")}   (force=${FORCE})`);

  const { rows: patients } = await pool.query(
    `SELECT DISTINCT a.patient_id, p.file_no, p.name
       FROM appointments a
       JOIN patients p ON p.id = a.patient_id
      WHERE a.appointment_date::date = ANY($1::date[])
        AND a.patient_id IS NOT NULL
      ORDER BY a.patient_id`,
    [DATES],
  );

  console.log(`Found ${patients.length} distinct patients\n`);
  if (!patients.length) {
    await pool.end();
    return;
  }

  let parsed = 0,
    skipped = 0,
    noNotes = 0,
    failed = 0,
    errored = 0;

  for (const p of patients) {
    const tag = `pat=${p.patient_id} ${p.file_no || "(no file_no)"} ${p.name || ""}`.trim();
    try {
      const r = await backfillPatientOpd(p.patient_id, { force: FORCE });
      if (r.status === "parsed") {
        parsed++;
        console.log(`  ✓ ${tag} → parsed (appt ${r.apptId})`);
      } else if (r.status === "skipped") {
        skipped++;
        console.log(`  · ${tag} → already backfilled (appt ${r.apptId})`);
      } else if (r.status === "no_notes") {
        noNotes++;
        console.log(`  · ${tag} → no clinical notes anywhere`);
      } else if (r.status === "parse_failed") {
        failed++;
        console.log(`  ✗ ${tag} → parse_failed (appt ${r.apptId})`);
      }
    } catch (e) {
      errored++;
      console.error(`  ! ${tag} → ${e.message}`);
    }
    // Throttle so we don't hammer Claude/DB.
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log(
    `\nDone. parsed=${parsed}  skipped=${skipped}  no_notes=${noNotes}  parse_failed=${failed}  errored=${errored}  total=${patients.length}`,
  );
  await pool.end();
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
