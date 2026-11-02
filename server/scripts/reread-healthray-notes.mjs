import "../loadEnv.js";
import pool from "../config/db.js";
import { backfillPatientOpd } from "../services/cron/healthraySync.js";
import { NOTES_READ_SQL } from "../services/healthray/notesRead.js";

const APPLY = process.argv.includes("--apply");
const dateArg = process.argv[process.argv.indexOf("--date") + 1];
const DATE_GIVEN = process.argv.includes("--date");
if (DATE_GIVEN && !/^\d{4}-\d{2}-\d{2}$/.test(dateArg ?? "")) {
  console.error("--date needs a day like 2026-10-31");
  process.exit(1);
}
const PAUSE_MS = 3000;
const listed = process.argv.slice(2).filter((a) => /^(P|GNI)[_-]\w+$/.test(a));
if (!listed.length && !DATE_GIVEN) {
  console.error(
    "Usage: node scripts/reread-healthray-notes.mjs [P_181110 ...] [--date 2026-10-31] [--apply]\n" +
      "  --date alone picks that day's patients whose notes were never read",
  );
  process.exit(1);
}

const { rows: dayRows } = await pool.query(
  `SELECT COALESCE($1::date, (NOW() AT TIME ZONE 'Asia/Kolkata')::date)::text AS day`,
  [DATE_GIVEN ? dateArg : null],
);
const DAY = dayRows[0].day;

const dbBusy = async () => {
  const { rows } = await pool.query(
    `SELECT count(*) FILTER (WHERE state = 'active')::int AS active,
            count(*) FILTER (WHERE state = 'idle in transaction')::int AS idle_txn,
            COALESCE(max(EXTRACT(EPOCH FROM NOW() - query_start)) FILTER (WHERE state = 'active'), 0)::int AS longest_s
       FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend'`,
  );
  const h = rows[0];
  return h.idle_txn > 3 || h.longest_s > 30 || h.active > 15 ? h : null;
};

const unreadOn = async (day) =>
  (
    await pool.query(
      `SELECT DISTINCT p.file_no
         FROM appointments a JOIN patients p ON p.id = a.patient_id
        WHERE a.appointment_date = $1::date
          AND LENGTH(a.healthray_clinical_notes) > 20
          AND NOT COALESCE(${NOTES_READ_SQL("a")}, FALSE)
          AND COALESCE(a.notes_read_status, '') <> 'skipped_date_mismatch'
        ORDER BY p.file_no`,
      [day],
    )
  ).rows.map((r) => r.file_no);

const busy = await dbBusy();
if (busy) {
  console.log(
    `Database looks busy (${busy.active} active, ${busy.idle_txn} idle-in-transaction, longest ${busy.longest_s}s) — try again later.`,
  );
  await pool.end();
  process.exit(2);
}

const FILE_NOS = listed.length ? listed : await unreadOn(DAY);
if (!FILE_NOS.length) {
  console.log(`No unread notes on ${DAY}.`);
  await pool.end();
  process.exit(0);
}

const clock = (t) =>
  t ? new Date(t).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false }) : "—";

const latestNotes = async (patientId) =>
  (
    await pool.query(
      `SELECT a.id, a.appointment_date::text AS appointment_date, a.opd_backfilled_at,
              length(a.healthray_clinical_notes) AS notes_len,
              jsonb_array_length(COALESCE(a.healthray_medications, '[]')) AS hr_meds,
              (a.appointment_date = $2::date) AS on_day
         FROM appointments a
        WHERE a.patient_id = $1
          AND a.healthray_clinical_notes IS NOT NULL
          AND LENGTH(a.healthray_clinical_notes) > 20
        ORDER BY a.appointment_date DESC NULLS LAST LIMIT 1`,
      [patientId, DAY],
    )
  ).rows[0] ?? null;

const medsToday = async (patientId) =>
  (
    await pool.query(
      `SELECT name, dose, timing FROM medications
        WHERE patient_id = $1 AND is_active
          AND last_prescribed_date = $2::date
        ORDER BY sort_order NULLS LAST, name`,
      [patientId, DAY],
    )
  ).rows;

console.log(
  `${APPLY ? "APPLY" : "DRY RUN"} — re-read the HealthRay notes of ${DAY}, one patient at a time (${FILE_NOS.length})\n`,
);

let first = true;
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
  if (!appt.on_day) {
    console.log(`  the latest notes are from ${appt.appointment_date}, not ${DAY} — skipped\n`);
    continue;
  }
  if (!APPLY) {
    console.log("  would re-read these notes now (no batch queue)\n");
    continue;
  }
  if (!first) {
    await new Promise((r) => setTimeout(r, PAUSE_MS));
    const nowBusy = await dbBusy();
    if (nowBusy) {
      console.log(
        "Database got busy — stopping here. Run the same command again later to continue.",
      );
      break;
    }
  }
  first = false;

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
  console.log(`  medicines found ${after.hr_meds}; on the list for ${DAY}: ${meds.length}`);
  for (const m of meds)
    console.log(`    - ${[m.name, m.dose, m.timing].filter(Boolean).join(" · ")}`);
  console.log("");
}

await pool.end();
