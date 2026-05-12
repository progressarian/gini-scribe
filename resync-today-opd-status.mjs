// Re-run today's HealthRay sync with the updated status gating logic.
// The fix in a315ecb only promotes appointments to 'completed' when:
//   1. HealthRay reports the appointment as checkout/completed AND
//   2. A printable Rx PDF (storage_path or file_url) has been received locally.
//
// This script:
//   1. Diagnostics — lists today's HealthRay-sourced appointments currently
//      marked 'completed' or 'seen' that do NOT have a printable Rx PDF
//      (i.e. were wrongly promoted before the fix).
//   2. Triggers syncWalkingAppointments() for today so the updated logic
//      re-evaluates every appointment with fresh HealthRay data.

import "dotenv/config";

const { syncWalkingAppointments } = await import(
  "./server/services/cron/healthraySync.js"
);
const { default: pool } = await import("./server/config/db.js");
const { toISTDate } = await import("./server/services/healthray/mappers.js");

const today = toISTDate(new Date().toISOString());
console.log(`\nTarget date (IST): ${today}\n`);

// 1. Diagnostic — wrongly promoted appointments
const { rows: wrong } = await pool.query(
  `SELECT a.id, a.file_no, a.status, a.healthray_id,
          (SELECT COUNT(*) FROM documents d
            WHERE d.patient_id = a.patient_id
              AND d.source = 'healthray'
              AND d.doc_type = 'prescription'
              AND d.notes LIKE '%healthray_appt:' || a.healthray_id || '%'
              AND (d.storage_path IS NOT NULL OR d.file_url IS NOT NULL)) AS rx_pdf_count
     FROM appointments a
    WHERE a.appointment_date = $1
      AND a.status IN ('completed','seen')
      AND a.healthray_id IS NOT NULL
   ORDER BY a.id`,
  [today],
);
const noPdf = wrong.filter((r) => Number(r.rx_pdf_count) === 0);
console.log(
  `Today: ${wrong.length} appts marked completed/seen; ${noPdf.length} of those have NO printable Rx PDF (would not be promoted under new logic).`,
);
if (noPdf.length) {
  console.log("Sample (up to 10):");
  for (const r of noPdf.slice(0, 10)) {
    console.log(`  - id=${r.id} file_no=${r.file_no} status=${r.status} healthray_id=${r.healthray_id}`);
  }
}

// 2. Trigger today sync with the new gating logic
console.log("\nKicking off syncWalkingAppointments() for today...");
const start = Date.now();
const result = await syncWalkingAppointments();
const elapsed = ((Date.now() - start) / 1000).toFixed(1);
console.log(`\nDone in ${elapsed}s:`);
console.log(JSON.stringify(result, null, 2));

await pool.end();
process.exit(0);
