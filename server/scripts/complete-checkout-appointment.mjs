import "../loadEnv.js";
import pool from "../config/db.js";
import {
  fetchAppointments,
  fetchDoctors,
  fetchMedicalRecords,
} from "../services/healthray/client.js";
import { markAppointmentAsSeen, syncDocuments } from "../services/healthray/db.js";
import { mapStatus } from "../services/healthray/mappers.js";

const [fileNo, date] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const apply = process.argv.includes("--apply");
if (!fileNo || !date) {
  console.error(
    "Usage: node scripts/complete-checkout-appointment.mjs <file_no> <YYYY-MM-DD> [--apply]",
  );
  process.exit(1);
}

const { rows } = await pool.query(
  `SELECT a.id, a.healthray_id, a.patient_id, a.status, a.doctor_name
     FROM appointments a JOIN patients p ON p.id = a.patient_id
    WHERE p.file_no = $1 AND a.appointment_date = $2::date AND a.healthray_id IS NOT NULL`,
  [fileNo, date],
);
if (rows.length !== 1) {
  console.error(
    `Expected one HealthRay appointment for ${fileNo} on ${date}, found ${rows.length}`,
  );
  process.exit(1);
}
const appt = rows[0];
console.log(`${fileNo} appointment ${appt.id} (${appt.doctor_name}): Scribe status ${appt.status}`);

const surname = (appt.doctor_name || "").trim().split(/\s+/).pop()?.toLowerCase();
const doctors = (await fetchDoctors()).filter((d) =>
  JSON.stringify(d).toLowerCase().includes(surname),
);
let live = null;
for (const d of doctors) {
  live = (await fetchAppointments(d.id, date)).find(
    (a) => String(a.id) === String(appt.healthray_id),
  );
  if (live) break;
}
const liveStatus = mapStatus(live?.status);
console.log(`HealthRay status: ${live?.status ?? "not found"} → ${liveStatus}`);
if (liveStatus !== "completed") {
  console.error("HealthRay does not say this visit is completed; nothing changed.");
  process.exit(1);
}

const records = (await fetchMedicalRecords(appt.healthray_id)) || [];
const rx = records.filter((r) => /prescription/i.test(r.record_type || r.type || ""));
console.log(`HealthRay Rx PDFs: ${rx.map((r) => r.file_name || r.name).join(", ") || "none"}`);
if (!rx.length) {
  console.error("No prescription PDF in HealthRay yet; the visit stays open until it lands.");
  process.exit(1);
}

if (!apply) {
  console.log(
    "\nDry run. Re-run with --apply to store the Rx PDF and mark the appointment completed.",
  );
  await pool.end();
  process.exit(0);
}

await syncDocuments(appt.patient_id, records, date, appt.healthray_id);
const { rows: stored } = await pool.query(
  `SELECT 1 FROM documents
    WHERE patient_id = $1 AND source = 'healthray' AND doc_type = 'prescription'
      AND notes LIKE $2 AND (storage_path IS NOT NULL OR file_url IS NOT NULL) LIMIT 1`,
  [appt.patient_id, `%healthray_appt:${appt.healthray_id}%`],
);
if (!stored.length) {
  console.error("The Rx PDF did not store; appointment left unchanged.");
  process.exit(1);
}
console.log("Rx PDF stored.");
await markAppointmentAsSeen(appt.id, "completed");
const { rows: after } = await pool.query(`SELECT status FROM appointments WHERE id = $1`, [
  appt.id,
]);
console.log(`Appointment ${appt.id} is now ${after[0].status}.`);
for (let i = 0; i < 90; i++) {
  const { rows: saved } = await pool.query(
    `SELECT 1 FROM documents WHERE patient_id = $1 AND source = 'visit' AND doc_type = 'prescription' AND storage_path IS NOT NULL
        AND created_at > NOW() - interval '5 minutes' LIMIT 1`,
    [appt.patient_id],
  );
  if (saved.length) {
    console.log("Scribe prescription saved.");
    break;
  }
  await new Promise((r) => setTimeout(r, 2000));
}
await pool.end();
