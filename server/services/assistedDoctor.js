import pool from "../config/db.js";

const CACHE_MS = 60_000;
const cache = new Map();

export function clearAssistedCache() {
  cache.clear();
}

export async function assistedDoctorOf(doctorId, db = pool) {
  if (!doctorId) return null;
  const hit = cache.get(doctorId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const { rows } = await db.query(
    `SELECT a.id, a.name, a.short_name
       FROM doctors d
       JOIN doctors a ON a.id = d.assists_doctor_id AND COALESCE(a.is_active, TRUE)
      WHERE d.id = $1`,
    [doctorId],
  );
  const value = rows[0] || null;
  cache.set(doctorId, { at: Date.now(), value });
  return value;
}

export async function isAssignedPatient(patientId, moId, { today = false } = {}, db = pool) {
  if (!patientId || !moId) return false;
  const { rows } = await db.query(
    `SELECT EXISTS (
       SELECT 1 FROM giniflow_visits v
        WHERE v.patient_id = $1
          AND v.rx_mo_id = $2
          AND (NOT $3 OR v.visit_date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date)
     ) AS ok`,
    [patientId, moId, today],
  );
  return rows[0].ok;
}

export const ASSIGNED_TODAY_SQL = (patientCol, moParam) => `${patientCol} IN (
  SELECT v.patient_id FROM giniflow_visits v
   WHERE v.rx_mo_id = ${moParam}
     AND v.visit_date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date)`;
