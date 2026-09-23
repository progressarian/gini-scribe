import "../loadEnv.js";
import pool from "../config/db.js";
import { fetchAppointments } from "../services/healthray/client.js";

const apptIds = process.argv.slice(2);
const date = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const { rows } = await pool.query(
  `SELECT DISTINCT d.healthray_id AS doctor_hr, a.doctor_name
     FROM appointments a JOIN doctors d ON lower(btrim(d.name)) = lower(btrim(a.doctor_name))
    WHERE a.healthray_id = ANY($1) AND d.healthray_id IS NOT NULL`,
  [apptIds],
);
for (const d of rows) {
  const data = await fetchAppointments(d.doctor_hr, date);
  const list = Array.isArray(data) ? data : data?.data || data?.appointments || data?.rows || [];
  for (const a of list) {
    if (!apptIds.includes(String(a.id))) continue;
    const statusish = Object.fromEntries(
      Object.entries(a).filter(([k, v]) => /status|check|tag|stage/i.test(k) && (typeof v !== "object" || v === null)),
    );
    console.log(d.doctor_name, a.id, JSON.stringify(statusish));
  }
}
await pool.end();
