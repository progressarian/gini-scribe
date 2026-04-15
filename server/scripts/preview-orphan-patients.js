/**
 * Preview patients/appointments missing a valid hospital-issued file_no
 * (must match /^P_\d+$/). Read-only — prints counts and rows, deletes nothing.
 *
 * Also lists today's OPD appointments (or --date=YYYY-MM-DD) whose appointment
 * row OR linked patient row has a missing/invalid file_no — the same set
 * surfaced by GET /api/opd/appointments?date=...
 *
 * Run:
 *   node server/scripts/preview-orphan-patients.js
 *   node server/scripts/preview-orphan-patients.js --date=2026-04-15
 *   node server/scripts/preview-orphan-patients.js --date=2026-04-15 --delete-orphan-appts
 *     (deletes the appointments listed in the "Appointments on <date>" section
 *      whose appt.file_no AND linked patient.file_no are both missing/invalid —
 *      those have no valid hospital ID to reconcile against.)
 */
import { fileURLToPath } from "url";
import { dirname, join } from "path";
const __dirname = dirname(fileURLToPath(import.meta.url));

const dotenv = await import("dotenv");
dotenv.config({ path: join(__dirname, "..", ".env") });

const { default: pool } = await import("../config/db.js");

const INVALID_FILE_NO = `(file_no IS NULL OR file_no = '' OR file_no !~* '^P_\\d+$')`;

function parseDateArg() {
  const arg = process.argv.find((a) => a.startsWith("--date="));
  if (arg) return arg.split("=")[1];
  return new Date().toISOString().slice(0, 10);
}
const TARGET_DATE = parseDateArg();
const DELETE_ORPHAN_APPTS = process.argv.includes("--delete-orphan-appts");

const RELATED_TABLES = [
  "appointments",
  "consultations",
  "documents",
  "medications",
  "diagnoses",
  "vitals",
  "lab_results",
];

async function run() {
  const { rows: all } = await pool.query(
    `SELECT id, name, phone, file_no, created_at
       FROM patients
      WHERE ${INVALID_FILE_NO}
      ORDER BY created_at DESC`,
  );

  console.log(`\nTotal patients with missing/invalid file_no: ${all.length}`);
  if (all.length > 0) {
    console.log("\nSample (up to 50):");
    console.table(all.slice(0, 50));
  }

  const notExistsClauses = RELATED_TABLES.map(
    (t) => `NOT EXISTS (SELECT 1 FROM ${t} WHERE patient_id = patients.id)`,
  ).join("\n        AND ");

  const { rows: orphans } = await pool.query(
    `SELECT id, name, phone, file_no, created_at
       FROM patients
      WHERE ${INVALID_FILE_NO}
        AND ${notExistsClauses}
      ORDER BY created_at DESC`,
  );

  console.log(
    `\nSafe-to-delete (no related records in ${RELATED_TABLES.join(", ")}): ${orphans.length}`,
  );
  if (orphans.length > 0) {
    console.log("\nSample (up to 50):");
    console.table(orphans.slice(0, 50));
  }

  console.log(`\n── Appointments on ${TARGET_DATE} with missing/invalid file_no ──`);
  const { rows: apptRows } = await pool.query(
    `SELECT a.id           AS appointment_id,
            a.patient_id,
            a.file_no      AS appt_file_no,
            a.patient_name,
            a.phone        AS appt_phone,
            a.status,
            a.source,
            a.time_slot,
            p.file_no      AS patient_file_no,
            p.name         AS patient_name_db,
            p.phone        AS patient_phone_db
       FROM appointments a
       LEFT JOIN patients p ON p.id = a.patient_id
      WHERE a.appointment_date = $1
        AND ((a.file_no IS NULL OR a.file_no = '' OR a.file_no !~* '^P_\\d+$')
             OR (a.patient_id IS NOT NULL
                 AND (p.file_no IS NULL OR p.file_no = '' OR p.file_no !~* '^P_\\d+$')))
      ORDER BY a.time_slot NULLS LAST, a.created_at`,
    [TARGET_DATE],
  );
  console.log(`Count: ${apptRows.length}`);
  if (apptRows.length > 0) console.table(apptRows);

  if (DELETE_ORPHAN_APPTS) {
    const deletable = apptRows.filter(
      (r) =>
        (!r.appt_file_no || !/^P_\d+$/i.test(r.appt_file_no)) &&
        (!r.patient_file_no || !/^P_\d+$/i.test(r.patient_file_no)),
    );
    if (deletable.length === 0) {
      console.log("\n--delete-orphan-appts: nothing matches the strict criteria. Skipping.");
    } else {
      const ids = deletable.map((r) => r.appointment_id);
      console.log(
        `\n--delete-orphan-appts: deleting ${ids.length} appointment(s): ${ids.join(", ")}`,
      );
      const del = await pool.query(
        `DELETE FROM appointments WHERE id = ANY($1::int[]) RETURNING id`,
        [ids],
      );
      console.log(`Deleted ${del.rowCount} row(s).`);
    }
  }

  console.log("\nPer-table related-row counts for the invalid-file_no patients:");
  for (const t of RELATED_TABLES) {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n
         FROM ${t}
        WHERE patient_id IN (SELECT id FROM patients WHERE ${INVALID_FILE_NO})`,
    );
    console.log(`  ${t.padEnd(16)} ${rows[0].n}`);
  }
}

run()
  .catch((e) => {
    console.error("ERROR:", e.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
