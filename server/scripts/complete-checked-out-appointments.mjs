import "../loadEnv.js";
import pool from "../config/db.js";
import { fetchAppointments } from "../services/healthray/client.js";
import { markAppointmentAsSeen, maybeAutoSavePrescription } from "../services/healthray/db.js";

const apply = process.argv.includes("--apply");
const apptIds = process.argv
  .slice(2)
  .filter((a) => /^\d+$/.test(a))
  .map(Number);
if (!apptIds.length) {
  console.error(
    "usage: node scripts/complete-checked-out-appointments.mjs <appointmentId>... [--apply]",
  );
  process.exit(1);
}

const date = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const { rows } = await pool.query(
  `SELECT a.id, a.file_no, a.patient_name, a.status, a.healthray_id, d.healthray_id AS doctor_hr
     FROM appointments a
     LEFT JOIN doctors d ON lower(btrim(d.name)) = lower(btrim(a.doctor_name))
    WHERE a.id = ANY($1) AND a.appointment_date = $2::date`,
  [apptIds, date],
);

const liveByDoctor = new Map();
const liveStatus = async (doctorHr, healthrayId) => {
  if (!liveByDoctor.has(doctorHr)) {
    const data = await fetchAppointments(doctorHr, date);
    const list = Array.isArray(data) ? data : data?.data || data?.appointments || data?.rows || [];
    liveByDoctor.set(doctorHr, new Map(list.map((a) => [String(a.id), a.status])));
  }
  return liveByDoctor.get(doctorHr).get(String(healthrayId)) ?? null;
};

for (const id of apptIds) {
  const r = rows.find((x) => x.id === id);
  if (!r) {
    console.log(`${id}: not an appointment today — skipped`);
    continue;
  }
  const label = `${id} ${r.file_no} ${r.patient_name}`;
  if (r.status === "completed") {
    if (!apply) {
      console.log(`${label}: already completed — Rx save re-runs with --apply`);
      continue;
    }
    await maybeAutoSavePrescription(id);
    console.log(`${label}: already completed — Rx save re-run`);
    continue;
  }
  if (!r.doctor_hr || !r.healthray_id) {
    console.log(`${label}: no HealthRay doctor/appointment id — skipped`);
    continue;
  }
  const live = await liveStatus(r.doctor_hr, r.healthray_id);
  if (live !== "Checkout") {
    console.log(`${label}: HealthRay says ${live ?? "not found"} — skipped`);
    continue;
  }
  if (!apply) {
    console.log(`${label}: ${r.status} → completed (dry run, pass --apply)`);
    continue;
  }
  await markAppointmentAsSeen(id, "completed");
  await maybeAutoSavePrescription(id);
  const after = await pool.query("SELECT status FROM appointments WHERE id=$1", [id]);
  console.log(`${label}: ${r.status} → ${after.rows[0].status}`);
}

await pool.end();
