/**
 * Backfill lab_results rows for labs that were parsed out of HealthRay clinical
 * notes but never persisted.
 *
 * Between 2026-08-01 and the rawText scope fix, syncAppointment() threw a
 * ReferenceError on the syncLabResults() call, so every note-derived lab (HbA1c,
 * FBS, PPBS, VPT, …) stayed stranded in appointments.healthray_labs and never
 * reached lab_results. Structured lab-case results (source='lab_healthray') were
 * unaffected — this only replays the note-derived ones.
 *
 * Re-runs syncLabResults() with the stored note as rawText, so the
 * collectNoteDates() guard applies exactly as it does in a live sync: a lab date
 * the extractor invented is still rejected. Existing rows from higher-priority
 * sources are never overwritten (syncLabResults skips any slot whose row is not
 * source='healthray').
 *
 * Usage:
 *   # Dry run — report what would be written, no DB writes (default)
 *   node server/scripts/backfill-note-labs.mjs
 *   node server/scripts/backfill-note-labs.mjs --since=2026-08-01
 *   node server/scripts/backfill-note-labs.mjs --file=P_181273
 *
 *   # Apply
 *   node server/scripts/backfill-note-labs.mjs --since=2026-08-01 --apply
 */
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

dotenv.config({
  path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".env"),
});

const { default: pool } = await import("../config/db.js");
const { syncLabResults } = await import("../services/healthray/db.js");
const { toISTDate } = await import("../services/healthray/mappers.js");
const { parseLabDate, collectNoteDates } = await import("../utils/labDate.js");
const { normalizeTestName } = await import("../utils/labNormalization.js");

// Mirrors NON_LAB_CANONICALS in services/healthray/db.js — vitals/demographics
// the extractor sometimes lists among "labs" and syncLabResults drops.
const NON_LAB = new Set(
  [
    "BP",
    "Blood Pressure",
    "Systolic BP",
    "Diastolic BP",
    "Height",
    "Weight",
    "BMI",
    "W.C",
    "WC",
    "Waist",
    "BF",
    "Body Fat",
    "PULSE",
    "Pulse",
    "SpO2",
    "age",
    "AGE",
    "Age",
  ].map((s) => s.toLowerCase()),
);

const arg = (name, fallback = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : fallback;
};
const APPLY = process.argv.includes("--apply");
const SINCE = arg("since", "2026-08-01");
const FILE_NO = arg("file");

const params = [SINCE];
let where = `a.appointment_date >= $1
             AND a.healthray_labs IS NOT NULL
             AND jsonb_array_length(a.healthray_labs) > 0
             AND a.patient_id IS NOT NULL`;
if (FILE_NO) {
  params.push(FILE_NO);
  where += ` AND a.file_no = $${params.length}`;
}

const { rows: appts } = await pool.query(
  `SELECT a.id, a.patient_id, a.file_no, a.appointment_date,
          a.healthray_labs, a.healthray_clinical_notes
     FROM appointments a
    WHERE ${where}
    ORDER BY a.appointment_date, a.id`,
  params,
);

console.log(
  `${APPLY ? "APPLY" : "DRY RUN"} — ${appts.length} appointments with note-derived labs since ${SINCE}` +
    (FILE_NO ? ` (file_no=${FILE_NO})` : ""),
);

const stats = {
  appts: 0,
  insert: 0,
  heal: 0,
  keptOther: 0,
  droppedDate: 0,
  droppedUndated: 0,
  droppedNonLab: 0,
};
const byTest = {};
let processed = 0;

async function processAppt(appt) {
  const apptDate = toISTDate(appt.appointment_date);
  const note = appt.healthray_clinical_notes || null;
  const allowed = note ? collectNoteDates(note) : null;
  if (allowed && apptDate) allowed.add(apptDate);

  let touched = 0;
  for (const lab of appt.healthray_labs || []) {
    const val = parseFloat(lab.value);
    if (isNaN(val)) continue;
    const canonical = normalizeTestName(lab.test);
    if (NON_LAB.has(String(canonical).toLowerCase())) {
      stats.droppedNonLab++;
      continue;
    }
    if (!lab.date) {
      stats.droppedUndated++;
      continue;
    }
    const labDate = parseLabDate(lab.date, apptDate);
    if (!labDate) {
      stats.droppedUndated++;
      continue;
    }
    if (allowed && !allowed.has(labDate)) {
      stats.droppedDate++;
      continue;
    }
    // Mirror syncLabResults' slot check so the dry run reports real outcomes.
    const { rows } = await pool.query(
      `SELECT source, result FROM lab_results
        WHERE patient_id = $1 AND canonical_name = $2
          AND test_date IS NOT DISTINCT FROM $3::date
        LIMIT 1`,
      [appt.patient_id, canonical, labDate],
    );
    const row = rows[0];
    if (!row) {
      stats.insert++;
      byTest[canonical] = (byTest[canonical] || 0) + 1;
      touched++;
    } else if (row.source !== "healthray") {
      stats.keptOther++;
    } else if (Number(row.result) !== val) {
      stats.heal++;
      touched++;
    }
  }

  if (touched) stats.appts++;
  processed++;
  if (processed % 25 === 0) {
    console.log(
      `  …${processed}/${appts.length} appts — ${stats.insert} inserts, ${stats.heal} healed`,
    );
  }
  if (APPLY && touched) {
    await syncLabResults(appt.patient_id, appt.id, apptDate, appt.healthray_labs, note);
  }
}

// Appointments are spread across LANES workers so the run doesn't take hours on
// a remote pooler (every lab costs at least one round-trip). Lane assignment is
// by patient_id, so all appointments for one patient stay in the same lane and
// run in date order — two of the same patient's visits must never write the
// same (canonical, date) slot concurrently.
const LANES = Number(arg("lanes", "6"));
const lanes = Array.from({ length: LANES }, () => []);
for (const appt of appts) lanes[appt.patient_id % LANES].push(appt);

await Promise.all(
  lanes.map(async (lane) => {
    for (const appt of lane) await processAppt(appt);
  }),
);

console.log(`\nappointments affected      : ${stats.appts}`);
console.log(`rows to insert             : ${stats.insert}`);
console.log(`stale 'healthray' rows healed: ${stats.heal}`);
console.log(`slots left to a better source: ${stats.keptOther}`);
console.log(`dropped — date not in note : ${stats.droppedDate}`);
console.log(`dropped — undated/unparseable: ${stats.droppedUndated}`);
console.log(`dropped — vital, not a lab  : ${stats.droppedNonLab}`);
console.log("\ninserts by test:");
for (const [t, n] of Object.entries(byTest)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 20)) {
  console.log(`  ${t.padEnd(28)} ${n}`);
}
if (!APPLY) console.log("\nNo writes were made. Re-run with --apply to persist.");

await pool.end();
