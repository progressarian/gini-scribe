import pool from "../config/db.js";

export const LEAD_STATUS = "lead";

export const isLeadId = (rawId) => Number(rawId) < 0;

export async function findLeadId(patientId, db = pool) {
  const r = await db.query(
    `SELECT id FROM appointments WHERE patient_id=$1 AND appointment_date IS NULL LIMIT 1`,
    [patientId],
  );
  return r.rows[0]?.id ?? null;
}

export async function createLead(patientId, db = pool) {
  const ins = await db.query(
    `INSERT INTO appointments
       (patient_id, patient_name, file_no, phone, alt_phone, age, sex,
        appointment_date, status, booking_source, booking_date)
     SELECT p.id, p.name, p.file_no, p.phone, p.alt_phone, p.age, p.sex,
            NULL, $2, 'OBT', CURRENT_DATE
       FROM patients p
      WHERE p.id=$1 AND NOT COALESCE(p.is_blocked, FALSE)
     ON CONFLICT (patient_id) WHERE appointment_date IS NULL DO NOTHING
     RETURNING id`,
    [patientId, LEAD_STATUS],
  );
  return ins.rows[0]?.id ?? (await findLeadId(patientId, db));
}

export async function resolveAppointmentId(rawId, { create = false, db = pool } = {}) {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id === 0) return null;
  if (id > 0) return id;
  const patientId = -id;
  return (await findLeadId(patientId, db)) ?? (create ? await createLead(patientId, db) : null);
}
const LEAD_FIELDS = new Set([
  "call_status",
  "call_made_by",
  "call_date",
  "call_notes",
  "call_reschedule_date",
  "preferred_date",
  "preferred_doctor",
  "preferred_time_slot",
  "patient_category",
  "home_collection",
]);

export const opensLead = (body) => Object.keys(body || {}).some((k) => LEAD_FIELDS.has(k));
