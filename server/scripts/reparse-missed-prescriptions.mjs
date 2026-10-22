import "../loadEnv.js";
import pool from "../config/db.js";
import { parsePrescriptionWithAi } from "../services/healthray/parser.js";
import { syncLabResults, syncBiomarkersFromLatestLabs } from "../services/healthray/db.js";
import { analyzeFollowUpDates, applyOpdParse } from "../services/cron/healthraySync.js";

const args = process.argv.slice(2);
const write = args.includes("--write");
const [from, to] = args.filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
const BATCH = 10;

if (!from || !to) {
  console.error("Usage: node scripts/reparse-missed-prescriptions.mjs <from> <to> [--write]");
  process.exit(1);
}

const MEDS_IN_NOTE = String.raw`(\mTAB\M|\mCAP\M|\mINJ\M|MEDICATION)`;

async function findCandidates() {
  const { rows } = await pool.query(
    `SELECT a.id, a.patient_id, a.healthray_id, a.appointment_date::text AS day,
            a.healthray_clinical_notes AS note, p.file_no, p.name,
            (SELECT count(*)::int FROM medications m
              WHERE m.patient_id = a.patient_id AND m.is_active) AS active_now,
            EXISTS (SELECT 1 FROM appointments later
                     WHERE later.patient_id = a.patient_id
                       AND later.appointment_date > a.appointment_date
                       AND LENGTH(COALESCE(later.healthray_clinical_notes, '')) > 20) AS has_later_visit
       FROM appointments a
       JOIN patients p ON p.id = a.patient_id
      WHERE a.appointment_date BETWEEN $1::date AND $2::date
        AND a.status = 'completed'
        AND a.healthray_id IS NOT NULL
        AND LENGTH(COALESCE(a.healthray_clinical_notes, '')) > 20
        AND a.healthray_clinical_notes ~* $3
        AND jsonb_array_length(COALESCE(a.healthray_medications, '[]'::jsonb)) = 0
      ORDER BY a.appointment_date, p.file_no`,
    [from, to, MEDS_IN_NOTE],
  );
  const take = [];
  const skip = [];
  for (const r of rows) {
    const dates = analyzeFollowUpDates(r.note, r.day);
    if (r.has_later_visit) skip.push({ ...r, why: "has a later visit" });
    else if (dates.hasAny && !dates.matchesApptDate)
      skip.push({ ...r, why: "note has no follow-up block for this date" });
    else take.push(r);
  }
  return { take, skip };
}

async function reparse(r) {
  const parsed = await parsePrescriptionWithAi(r.note, r.day);
  if (!parsed) throw new Error(`${r.file_no}: parse returned nothing`);
  const meds = parsed.medications || [];
  if (!meds.length) return { meds: 0, skipped: true };
  if (parsed.labs?.length && analyzeFollowUpDates(r.note, r.day).matchesApptDate) {
    parsed.labs = parsed.labs.filter((lab) => lab.date !== "today");
  }
  await applyOpdParse(
    { patientId: r.patient_id, healthrayId: r.healthray_id, appointmentDate: r.day, apptId: r.id },
    parsed,
  );
  await syncLabResults(r.patient_id, r.id, r.day, parsed.labs || [], r.note);
  await syncBiomarkersFromLatestLabs(r.patient_id, r.id);
  return { meds: meds.length, labs: (parsed.labs || []).length };
}

try {
  const { take, skip } = await findCandidates();
  console.log(`${from} → ${to}: ${take.length} to re-parse, ${skip.length} skipped`);
  for (const r of take) {
    console.log(
      `  ${r.day}  ${r.file_no.padEnd(10)} active now ${String(r.active_now).padStart(2)}  ${r.name}`,
    );
  }
  if (skip.length) console.log("skipped:");
  for (const r of skip) console.log(`  ${r.day}  ${r.file_no.padEnd(10)} ${r.why}  ${r.name}`);

  if (!write) {
    console.log("dry run; pass --write to re-parse and apply");
  } else {
    let done = 0;
    let empty = 0;
    for (let i = 0; i < take.length; i += BATCH) {
      for (const r of take.slice(i, i + BATCH)) {
        const result = await reparse(r);
        if (result.skipped) {
          empty++;
          console.log(`  ${r.file_no}: parse found no medicines; left as is`);
        } else {
          done++;
          console.log(`  ${r.file_no}: ${result.meds} medicine(s), ${result.labs} lab value(s)`);
        }
      }
      console.log(
        `batch ${i / BATCH + 1}: ${done} applied, ${empty} empty, ${take.length - i - Math.min(BATCH, take.length - i)} left`,
      );
    }
  }
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
  process.exit();
}
