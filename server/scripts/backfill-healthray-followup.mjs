import "dotenv/config";
import pool from "../config/db.js";
import { fetchDoctors, fetchAppointments } from "../services/healthray/client.js";
import { syncFollowUpDate } from "../services/healthray/db.js";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};
const APPLY = args.includes("--apply");
const DATES = (flag("dates") || "").split(",").filter(Boolean);
const FILE_NOS = (flag("file-no") || "").split(",").filter(Boolean);

if (!DATES.length) {
  console.error(
    "usage: node server/scripts/backfill-healthray-followup.mjs --dates 2026-05-25,2026-06-25 [--file-no P_130070,P_153850] [--apply]",
  );
  process.exit(1);
}

const toISTDate = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d)) return null;
  return new Date(d.getTime() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
};

const asRows = (r) =>
  Array.isArray(r)
    ? r
    : Array.isArray(r?.data)
      ? r.data
      : Array.isArray(r?.data?.data)
        ? r.data.data
        : [];

async function main() {
  const doctors = asRows(await fetchDoctors());
  console.log(
    `${APPLY ? "APPLY" : "DRY RUN"} — ${doctors.length} doctors, ${DATES.length} date(s)`,
  );

  let scanned = 0;
  let updated = 0;
  const changes = [];

  for (const date of DATES) {
    const seen = new Map();
    for (const doc of doctors) {
      for (let page = 1; page <= 5; page += 1) {
        const rows = asRows(await fetchAppointments(doc.id, date, page, 100));
        if (!rows.length) break;
        for (const appt of rows) seen.set(String(appt.id), appt);
        if (rows.length < 100) break;
      }
    }

    for (const [healthrayId, appt] of seen) {
      const followUpDate = toISTDate(appt.followup_days);
      if (!followUpDate) continue;

      const { rows } = await pool.query(
        `SELECT id, file_no, patient_name, appointment_date, biomarkers->>'followup' AS stored
           FROM appointments WHERE healthray_id = $1`,
        [healthrayId],
      );
      const local = rows[0];
      if (!local) continue;
      if (FILE_NOS.length && !FILE_NOS.includes(local.file_no)) continue;

      scanned += 1;
      if (local.stored === followUpDate) continue;

      changes.push({
        file_no: local.file_no,
        patient: local.patient_name,
        visit: String(local.appointment_date).slice(0, 10),
        stored: local.stored ?? "(none)",
        healthray: followUpDate,
      });
      if (APPLY && (await syncFollowUpDate(local.id, followUpDate))) updated += 1;
    }
  }

  if (changes.length) console.table(changes);
  console.log(
    `matched ${scanned} appointment(s); ${APPLY ? `${updated} updated` : `${changes.length} would change`}`,
  );
}

main()
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
