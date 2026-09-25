import "../loadEnv.js";
import pool from "../config/db.js";
import { fetchAppointments, fetchMedicalRecords } from "../services/healthray/client.js";
import {
  syncDocuments,
  markAppointmentAsSeen,
  maybeAutoSavePrescription,
} from "../services/healthray/db.js";

const apply = process.argv.includes("--apply");
const completeWithoutRx = process.argv.includes("--complete-without-rx");
const completedWithoutRx = [];
const daysArg = process.argv.find((a) => a.startsWith("--days="));
const days = Number(daysArg?.split("=")[1] || 7);
const onlyFile = process.argv.find((a) => a.startsWith("P_"));
const DONE_IN_HEALTHRAY = ["completed", "checkout"];

const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const { rows: stuck } = await pool.query(
  `SELECT a.id, a.appointment_date::text AS date, a.status, a.healthray_id, a.patient_id,
          a.doctor_name, p.file_no, p.name, d.healthray_id AS doctor_hr
     FROM appointments a
     JOIN patients p ON p.id = a.patient_id
     LEFT JOIN doctors d ON lower(btrim(d.name)) = lower(btrim(a.doctor_name))
    WHERE a.appointment_date < $1::date
      AND a.appointment_date >= $1::date - $2::int
      AND a.healthray_id IS NOT NULL
      AND a.status NOT IN ('completed', 'seen', 'cancelled', 'no_show')
      AND ($3::text IS NULL OR p.file_no = $3)
    ORDER BY a.appointment_date, a.doctor_name`,
  [today, days, onlyFile || null],
);
console.log(
  `${stuck.length} visit(s) in the last ${days} day(s) not completed in Scribe${onlyFile ? ` for ${onlyFile}` : ""}`,
);

const hasRxPdf = async (patientId, healthrayId) => {
  const { rows } = await pool.query(
    `SELECT 1 FROM documents
      WHERE patient_id = $1 AND source = 'healthray' AND doc_type = 'prescription'
        AND notes LIKE $2 AND (storage_path IS NOT NULL OR file_url IS NOT NULL)
      LIMIT 1`,
    [patientId, `%healthray_appt:${healthrayId}%`],
  );
  return rows.length > 0;
};

const scribeCopy = async (appointmentId) => {
  const { rows } = await pool.query(
    `SELECT 1 FROM documents d JOIN appointments ap ON ap.consultation_id = d.consultation_id
      WHERE ap.id = $1 AND d.source = 'visit' AND d.doc_type = 'prescription' LIMIT 1`,
    [appointmentId],
  );
  return rows.length > 0;
};

const dayLists = new Map();
const healthrayStatus = async (doctorHr, date, healthrayId) => {
  const key = `${doctorHr}|${date}`;
  if (!dayLists.has(key)) {
    const data = await fetchAppointments(doctorHr, date).catch((e) => {
      console.log(`  ! could not read ${date} list for doctor ${doctorHr}: ${e.message}`);
      return [];
    });
    const list = Array.isArray(data) ? data : data?.data || data?.appointments || data?.rows || [];
    dayLists.set(key, new Map(list.map((a) => [String(a.id), a.status])));
  }
  return dayLists.get(key).get(String(healthrayId)) ?? null;
};

const summary = { fixed: 0, wouldFix: 0, notDoneInHealthray: 0, noRx: 0, noDoctor: 0, failed: 0 };
for (const a of stuck) {
  const label = `${a.date} ${a.file_no} ${a.name} (${a.doctor_name}) — Scribe ${a.status}`;
  if (!a.doctor_hr) {
    summary.noDoctor++;
    console.log(`  skip ${label}: doctor not matched to HealthRay`);
    continue;
  }
  const live = await healthrayStatus(a.doctor_hr, a.date, a.healthray_id);
  if (!DONE_IN_HEALTHRAY.includes(String(live || "").toLowerCase())) {
    summary.notDoneInHealthray++;
    console.log(`  skip ${label}: HealthRay says ${live ?? "not found"}`);
    continue;
  }
  const records = await fetchMedicalRecords(a.healthray_id).catch(() => []);
  const list = Array.isArray(records) ? records : records?.data || [];
  const rx = list.filter((r) => /prescription/i.test(r.record_type || ""));
  if (!rx.length) {
    summary.noRx++;
    if (!completeWithoutRx) {
      console.log(`  skip ${label}: HealthRay ${live}, but no prescription uploaded`);
      continue;
    }
    if (!apply) {
      console.log(`  would complete ${label}: HealthRay ${live}, no prescription`);
      continue;
    }
    try {
      await markAppointmentAsSeen(a.id, "completed");
      completedWithoutRx.push(a);
      console.log(`  completed ${label}: HealthRay ${live}, no prescription`);
    } catch (e) {
      summary.failed++;
      console.log(`  FAILED ${label}: ${e.message}`);
    }
    continue;
  }
  if (!apply) {
    summary.wouldFix++;
    console.log(
      `  would fix ${label}: HealthRay ${live}, ${rx.length} prescription(s) to download → completed`,
    );
    continue;
  }
  try {
    await syncDocuments(a.patient_id, list, a.date, a.healthray_id);
    if (!(await hasRxPdf(a.patient_id, a.healthray_id))) {
      summary.failed++;
      console.log(`  FAILED ${label}: prescription did not download — left as ${a.status}`);
      continue;
    }
    await markAppointmentAsSeen(a.id, "completed");
    await new Promise((r) => setTimeout(r, 8000));
    if (!(await scribeCopy(a.id))) await maybeAutoSavePrescription(a.id);
    await pool.query(
      `UPDATE documents d
          SET doc_date = $2::date, title = regexp_replace(d.title, 'Visit — .*$', 'Visit — ' || $2)
         FROM appointments ap
        WHERE ap.id = $1 AND d.consultation_id = ap.consultation_id
          AND d.source = 'visit' AND d.doc_type = 'prescription'`,
      [a.id, a.date],
    );
    summary.fixed++;
    console.log(`  fixed ${label}: prescription downloaded, visit completed`);
  } catch (e) {
    summary.failed++;
    console.log(`  FAILED ${label}: ${e.message}`);
  }
}

if (completedWithoutRx.length) {
  await new Promise((r) => setTimeout(r, 30000));
  for (const a of completedWithoutRx) {
    await pool.query(
      `UPDATE documents d
          SET doc_date = $2::date, title = regexp_replace(d.title, 'Visit — .*$', 'Visit — ' || $2)
         FROM appointments ap
        WHERE ap.id = $1 AND d.consultation_id = ap.consultation_id
          AND d.source = 'visit' AND d.doc_type = 'prescription'`,
      [a.id, a.date],
    );
  }
  summary.completedWithoutRx = completedWithoutRx.length;
}
console.log(apply ? "\nApplied:" : "\nDry run (pass --apply to fix):", JSON.stringify(summary));
await pool.end();
