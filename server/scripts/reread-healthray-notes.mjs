import "../loadEnv.js";
import pool from "../config/db.js";
import { backfillPatientOpd } from "../services/cron/healthraySync.js";

const APPLY = process.argv.includes("--apply");
const FILE_NOS = process.argv.slice(2).filter((a) => /^(P|GNI)[_-]\w+$/.test(a));
if (!FILE_NOS.length) {
  console.error("Usage: node scripts/reread-healthray-notes.mjs P_181110 P_181814 [...] [--apply]");
  process.exit(1);
}

const clock = (t) =>
  t ? new Date(t).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false }) : "—";

const latestNotes = async (patientId) =>
  (
    await pool.query(
      `SELECT a.id, a.appointment_date::text AS appointment_date, a.opd_backfilled_at,
              length(a.healthray_clinical_notes) AS notes_len,
              jsonb_array_length(COALESCE(a.healthray_medications, '[]')) AS hr_meds,
              (a.appointment_date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date) AS today
         FROM appointments a
        WHERE a.patient_id = $1
          AND a.healthray_clinical_notes IS NOT NULL
          AND LENGTH(a.healthray_clinical_notes) > 20
        ORDER BY a.appointment_date DESC NULLS LAST LIMIT 1`,
      [patientId],
    )
  ).rows[0] ?? null;

const medsToday = async (patientId) =>
  (
    await pool.query(
      `SELECT name, dose, timing FROM medications
        WHERE patient_id = $1 AND is_active
          AND last_prescribed_date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date
        ORDER BY sort_order NULLS LAST, name`,
      [patientId],
    )
  ).rows;

console.log(
  `${APPLY ? "APPLY" : "DRY RUN"} — re-read today's HealthRay notes, one patient at a time\n`,
);

for (const fileNo of FILE_NOS) {
  const { rows } = await pool.query(`SELECT id, name FROM patients WHERE file_no = $1`, [fileNo]);
  if (rows.length !== 1) {
    console.log(`${fileNo}: ${rows.length ? "more than one chart" : "no chart"} — skipped\n`);
    continue;
  }
  const patient = rows[0];
  const appt = await latestNotes(patient.id);
  if (!appt) {
    console.log(`${fileNo} ${patient.name}: no HealthRay notes — skipped\n`);
    continue;
  }
  console.log(`${fileNo} ${patient.name}`);
  console.log(
    `  notes from ${appt.appointment_date} (${appt.notes_len} chars), last read ${clock(appt.opd_backfilled_at)}, medicines found ${appt.hr_meds}`,
  );
  if (!appt.today) {
    console.log("  the latest notes are not from today — skipped\n");
    continue;
  }
  if (!APPLY) {
    console.log("  would re-read these notes now (no batch queue)\n");
    continue;
  }

  const result = await backfillPatientOpd(patient.id, {
    force: true,
    allowBatch: false,
    origin: "manual_reread",
  });
  const after = await latestNotes(patient.id);
  const meds = await medsToday(patient.id);
  console.log(`  result: ${result.status}`);
  if (result.status !== "parsed") {
    console.log("  not read — check the Anthropic credit/key and the worker log, then run again\n");
    console.log("Stopping at the first patient that could not be read.");
    break;
  }
  console.log(`  medicines found ${after.hr_meds}; on the list for today: ${meds.length}`);
  for (const m of meds)
    console.log(`    - ${[m.name, m.dose, m.timing].filter(Boolean).join(" · ")}`);
  console.log("");
}

await pool.end();
