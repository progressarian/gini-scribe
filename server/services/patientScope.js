import pool from "../config/db.js";
import { hasOwnPatientList, normalizeRole, ROLES } from "../../shared/permissions.js";

export function doctorScope(req) {
  const assisted = req.assistedDoctor;
  const doctorId = assisted?.id ?? req.doctor?.doctor_id ?? null;
  const mine = hasOwnPatientList(req.doctor?.role) && !!doctorId;
  return {
    mine,
    doctorId,
    fullName: (assisted ? assisted.name : req.doctor?.doctor_name) || "",
    shortName: (assisted ? assisted.short_name : req.doctor?.short_name) || "",
  };
}
export function latestDoctorIs(patientCol, i) {
  return `EXISTS (
    SELECT 1 FROM (
      SELECT a.doctor_id, a.doctor_name
        FROM appointments a
       WHERE a.patient_id = ${patientCol}
         AND NULLIF(TRIM(a.doctor_name), '') IS NOT NULL
       ORDER BY a.appointment_date DESC NULLS LAST, a.id DESC
       LIMIT 1
    ) latest
    WHERE latest.doctor_id = $${i}
       OR ($${i + 1} <> '' AND latest.doctor_name ILIKE $${i + 1})
       OR ($${i + 2} <> '' AND latest.doctor_name ILIKE $${i + 2})
  )`;
}

export function opdScope(req) {
  const scope = doctorScope(req);
  return {
    ...scope,
    mine:
      [ROLES.CONSULTANT, ROLES.RX_MO].includes(normalizeRole(req.doctor?.role)) && !!scope.doctorId,
  };
}

export function opdRowIsMine(alias, i) {
  return `(
    ${alias}.doctor_id = $${i}
    OR ($${i + 1} <> '' AND ${alias}.doctor_name ILIKE $${i + 1})
    OR ($${i + 2} <> '' AND ${alias}.doctor_name ILIKE $${i + 2})
    OR (${alias}.doctor_id IS NULL AND NULLIF(TRIM(${alias}.doctor_name), '') IS NULL)
    OR ${alias}.status = 'no_show'
  )`;
}

export function scopeParams(scope) {
  return [scope.doctorId, scope.fullName, scope.shortName];
}

export async function myPatientIds(scope, patientIds) {
  const ids = [...new Set(patientIds.map(Number).filter(Number.isInteger))];
  if (!scope.mine || !ids.length) return null;
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (a.patient_id) a.patient_id, a.doctor_id, a.doctor_name
       FROM appointments a
      WHERE a.patient_id = ANY($1::int[])
        AND NULLIF(TRIM(a.doctor_name), '') IS NOT NULL
      ORDER BY a.patient_id, a.appointment_date DESC NULLS LAST, a.id DESC`,
    [ids],
  );
  const full = scope.fullName.toLowerCase();
  const short = scope.shortName.toLowerCase();
  const mine = new Set();
  for (const r of rows) {
    const name = (r.doctor_name || "").toLowerCase();
    if (r.doctor_id === scope.doctorId || (full && name === full) || (short && name === short))
      mine.add(r.patient_id);
  }
  return mine;
}
