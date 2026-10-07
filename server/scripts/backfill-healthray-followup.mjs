import "dotenv/config";
import { writeFileSync } from "node:fs";
import pool from "../config/db.js";
import { fetchDoctors, fetchAppointments } from "../services/healthray/client.js";
import { syncFollowUpDate } from "../services/healthray/db.js";
import { ownFu } from "../services/ghmDayWindow.js";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};
const APPLY = args.includes("--apply");
const ONLY_MISSING = args.includes("--only-missing");
const FROM = flag("from");
const TO = flag("to");
const PAUSE_MS = Number(flag("pause-ms") || 0);
const CSV = flag("csv");
const FILE_NOS = (flag("file-no") || "").split(",").filter(Boolean);
const DOCTOR = (flag("doctor") || "").toLowerCase();

const dateRange = (from, to) => {
  const out = [];
  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); ) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
};
const DATES = FROM && TO ? dateRange(FROM, TO) : (flag("dates") || "").split(",").filter(Boolean);

if (!DATES.length) {
  console.error(
    "usage: node server/scripts/backfill-healthray-followup.mjs (--dates 2026-05-25,2026-06-25 | --from 2026-04-01 --to 2026-08-31) [--only-missing] [--pause-ms 3000] [--csv out.csv] [--file-no P_130070] [--doctor bhansali] [--apply]",
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const normName = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/^dr\.?\s*/, "")
    .replace(/[^a-z]/g, "");

const missingOn = async (date) => {
  const { rows } = await pool.query(
    `SELECT a.id, a.doctor_name FROM appointments a
      WHERE a.appointment_date = $1 AND a.healthray_id IS NOT NULL
        AND a.status IN ('seen', 'completed') AND ${ownFu("a")} IS NULL`,
    [date],
  );
  return {
    ids: new Set(rows.map((r) => r.id)),
    doctors: new Set(rows.map((r) => normName(r.doctor_name))),
  };
};

const csvCell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;

async function main() {
  const { rows: localDoctors } = await pool.query(
    `SELECT healthray_id::text AS hrid, name FROM doctors WHERE healthray_id IS NOT NULL`,
  );
  const localName = new Map(localDoctors.map((d) => [d.hrid, d.name]));
  const namesOf = (doc) => [normName(doc.doctor_name), normName(localName.get(String(doc.id)))];
  const allDoctors = asRows(await fetchDoctors()).filter(
    (doc) =>
      !DOCTOR ||
      String(doc.doctor_name || "")
        .toLowerCase()
        .includes(DOCTOR),
  );
  console.log(
    `${APPLY ? "APPLY" : "DRY RUN"} — ${allDoctors.length} doctors, ${DATES.length} date(s)${ONLY_MISSING ? ", only visits with no follow-up" : ""}`,
  );

  let scanned = 0;
  let updated = 0;
  let requests = 0;
  const changes = [];

  for (const date of DATES) {
    const missing = ONLY_MISSING ? await missingOn(date) : null;
    if (missing && !missing.ids.size) continue;
    const doctors = missing
      ? allDoctors.filter((doc) => namesOf(doc).some((n) => n && missing.doctors.has(n)))
      : allDoctors;

    const seen = new Map();
    for (const doc of doctors) {
      for (let page = 1; page <= 5; page += 1) {
        if (PAUSE_MS && requests) await sleep(PAUSE_MS);
        requests += 1;
        const rows = asRows(await fetchAppointments(doc.id, date, page, 100));
        if (!rows.length) break;
        for (const appt of rows) seen.set(String(appt.id), appt);
        if (rows.length < 100) break;
      }
    }

    let dayChanges = 0;
    for (const [healthrayId, appt] of seen) {
      const followUpDate = toISTDate(appt.followup_days);
      if (!followUpDate) continue;

      const { rows } = await pool.query(
        `SELECT id, file_no, patient_name, doctor_name, appointment_date,
                biomarkers->>'followup' AS stored
           FROM appointments WHERE healthray_id = $1`,
        [healthrayId],
      );
      const local = rows[0];
      if (!local) continue;
      if (FILE_NOS.length && !FILE_NOS.includes(local.file_no)) continue;
      if (missing && !missing.ids.has(local.id)) continue;

      scanned += 1;
      if (local.stored === followUpDate) continue;

      dayChanges += 1;
      changes.push({
        file_no: local.file_no,
        patient: local.patient_name,
        doctor: local.doctor_name,
        visit: String(local.appointment_date).slice(0, 10),
        stored: local.stored ?? "(none)",
        healthray: followUpDate,
      });
      if (APPLY && (await syncFollowUpDate(local.id, followUpDate))) updated += 1;
    }
    console.log(
      `${date}: ${doctors.length} doctor(s), ${missing ? `${missing.ids.size} missing, ` : ""}${dayChanges} ${APPLY ? "updated" : "would change"} — ${requests} requests so far`,
    );
  }

  if (CSV) {
    const header = ["file_no", "patient", "doctor", "visit", "stored", "healthray"];
    writeFileSync(
      CSV,
      [header.join(","), ...changes.map((c) => header.map((k) => csvCell(c[k])).join(","))].join(
        "\n",
      ),
    );
    console.log(`wrote ${changes.length} row(s) to ${CSV}`);
  } else if (changes.length) {
    console.table(changes);
  }
  console.log(
    `matched ${scanned} appointment(s); ${APPLY ? `${updated} updated` : `${changes.length} would change`}; ${requests} HealthRay requests`,
  );
}

main()
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
