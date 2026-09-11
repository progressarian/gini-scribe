import "../loadEnv.js";
import pool from "../config/db.js";
import { fetchDoctors, fetchAppointments } from "../services/healthray/client.js";

const date = process.argv[2] || new Date().toISOString().slice(0, 10);
const apply = process.argv.includes("--apply");

const doctors = await fetchDoctors();
const list = doctors?.data || doctors?.doctors || doctors || [];
console.log(`${date}: ${list.length} doctors`);

const seen = new Map();
for (const d of list) {
  const id = d.id ?? d.doctor_id;
  if (!id) continue;
  let page = 1;
  for (;;) {
    const res = await fetchAppointments(id, date, page);
    const appts = Array.isArray(res) ? res : res?.data?.appointments || res?.appointments || res?.data || [];
    if (!Array.isArray(appts) || !appts.length) break;
    for (const a of appts) {
      const hpid = a.patient?.id ?? a.self_user_id;
      if (a.id && hpid) seen.set(String(a.id), String(hpid));
    }
    if (appts.length < 100) break;
    page++;
  }
}
console.log(`HealthRay returned patient ids for ${seen.size} appointment(s)`);

const { rows } = await pool.query(
  `SELECT id, healthray_id FROM appointments
    WHERE appointment_date::date = $1::date AND healthray_patient_id IS NULL
      AND healthray_id IS NOT NULL`,
  [date],
);
const fillable = rows.filter((r) => seen.has(String(r.healthray_id)));
console.log(`${rows.length} rows missing the id locally, ${fillable.length} fillable`);

if (!apply) {
  console.log("DRY RUN — re-run with --apply to write.");
  process.exit(0);
}

let wrote = 0;
for (const r of fillable) {
  const { rowCount } = await pool.query(
    `UPDATE appointments SET healthray_patient_id = $2, updated_at = NOW()
      WHERE id = $1 AND healthray_patient_id IS NULL`,
    [r.id, seen.get(String(r.healthray_id))],
  );
  wrote += rowCount;
}
console.log(`filled ${wrote} row(s)`);
process.exit(0);
