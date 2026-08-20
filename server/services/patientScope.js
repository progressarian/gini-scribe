import pool from "../config/db.js";
import { hasOwnPatientList } from "../../shared/permissions.js";

// Who "owns" a patient: the doctor on their most recent appointment. There is no
// treating-doctor column anywhere — patients has none, refill requests have none,
// and dose_change_requests.doctor_id is the DECIDING doctor, written on approval,
// so it is null on exactly the pending rows a dashboard shows. The latest
// appointment is the only ownership the data actually carries.
//
// Resolved through appointments.patient_id (set on 99.9% of rows) rather than the
// file_no join: COALESCE(p.id, a.patient_id) cannot use an index and turned this
// into a 3s sequential scan per patient.

export function doctorScope(req) {
  const doctorId = req.doctor?.doctor_id ?? null;
  const mine = hasOwnPatientList(req.doctor?.role) && !!doctorId;
  return {
    mine,
    doctorId,
    fullName: req.doctor?.doctor_name || "",
    shortName: req.doctor?.short_name || "",
  };
}

// SQL predicate: "this patient's current doctor is me". `patientCol` is the
// caller's patient-id column; `i` is the 1-based index of the first of the three
// params this appends (doctor id, full name, short name).
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

export function scopeParams(scope) {
  return [scope.doctorId, scope.fullName, scope.shortName];
}

// For lists that come from Genie (alerts, messages) and so cannot be filtered in
// SQL: resolve which of these patients belong to the caller, then filter in JS.
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
