import pool from "../../config/db.js";
import { hasCapability, CAPABILITIES } from "../../../shared/permissions.js";
import { patientTypeOf, patientTypeSql } from "../../../shared/slotCapacity.js";

export { overLimitFor } from "../../../shared/slotCapacity.js";
import { DONE_OR_INPROGRESS, isSlotAvailable } from "../availability.js";
import { approvalsReady, requestReasonReady } from "./approvalStore.js";

const istToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

export async function overLimit(appointmentId, { client = pool } = {}) {
  if (!(await approvalsReady(client))) return null;
  const { rows } = await client.query(
    `SELECT a.id, a.appointment_date::text AS date, a.time_slot, a.status, a.healthray_id,
            resolve_doctor_id(a.doctor_name) AS doctor_id, ${patientTypeSql("a")} AS patient_type
       FROM appointments a WHERE a.id = $1`,
    [appointmentId],
  );
  const a = rows[0];
  if (!a || a.healthray_id || !a.doctor_id || !a.date || !a.time_slot) return null;
  if (a.date < istToday() || DONE_OR_INPROGRESS.includes(String(a.status || "").toLowerCase()))
    return null;
  const v = await isSlotAvailable(a.doctor_id, a.date, a.time_slot, { client });
  const limit = v.caps?.[a.patient_type];
  const count = v.counts?.[a.patient_type] ?? 0;
  if (limit == null || count <= limit) return null;
  return {
    appointment_id: a.id,
    doctor_id: a.doctor_id,
    date: a.date,
    slot_label: v.slot_label,
    patient_type: a.patient_type,
    limit,
    count,
  };
}

export const cleanReason = (raw) =>
  String(raw ?? "")
    .trim()
    .slice(0, 300) || null;

export async function holdIfOverLimit(
  appointmentId,
  { actor = null, client = pool, reason = null } = {},
) {
  const over = await overLimit(appointmentId, { client });
  if (!over) return null;
  const existing = await client.query(
    `SELECT id, status, patient_type, limit_at_request AS limit FROM booking_approvals
      WHERE appointment_id = $1 AND slot_label = $2 AND appointment_date = $3::date
        AND patient_type = $4 AND status IN ('pending', 'approved')
      ORDER BY id DESC LIMIT 1`,
    [over.appointment_id, over.slot_label, over.date, over.patient_type],
  );
  if (existing.rows[0]) return existing.rows[0];
  const approver = hasCapability(actor?.role, CAPABILITIES.BOOKING_APPROVE);
  const asked = cleanReason(reason);
  const withReason = !!asked && (await requestReasonReady(client));
  const { rows } = await client.query(
    `INSERT INTO booking_approvals
       (appointment_id, doctor_id, appointment_date, slot_label, patient_type,
        limit_at_request, count_at_request, status, requested_by, decided_by, decided_at, reason
        ${withReason ? ", request_reason" : ""})
     VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8, $9, $10, $11, $12 ${withReason ? ", $13" : ""})
     RETURNING id, status, patient_type, limit_at_request AS limit`,
    [
      over.appointment_id,
      over.doctor_id,
      over.date,
      over.slot_label,
      over.patient_type,
      over.limit,
      over.count - 1,
      approver ? "approved" : "pending",
      actor?.doctor_id ?? null,
      approver ? (actor?.doctor_id ?? null) : null,
      approver ? new Date() : null,
      approver ? "Booked over the limit by someone who can approve" : null,
      ...(withReason ? [asked] : []),
    ],
  );
  return rows[0];
}

export async function patientTypeFor(
  { patientId, fileNo, date, walkin, visitType, appointmentId },
  { client = pool } = {},
) {
  if (appointmentId) {
    const { rows } = await client.query(
      `SELECT ${patientTypeSql("a")} AS t FROM appointments a WHERE a.id = $1`,
      [appointmentId],
    );
    if (rows[0]) return rows[0].t;
  }
  if (walkin) return "walkin";
  let id = Number(patientId) > 0 ? Number(patientId) : null;
  if (!id && fileNo)
    id =
      (
        await client.query("SELECT id FROM patients WHERE file_no = $1 ORDER BY id DESC LIMIT 1", [
          fileNo,
        ])
      ).rows[0]?.id ?? null;
  if (!id) return patientTypeOf({ patient_id: null, visit_type: visitType });
  const { rows } = await client.query(
    "SELECT appointment_patient_came_before($1, $2::date) AS came",
    [id, date],
  );
  return rows[0].came ? "followup" : "new";
}

export async function slotOfAppointment(appointmentId, doctorId, date, { client = pool } = {}) {
  const { rows } = await client.query(
    `SELECT appointment_date::text AS date, time_slot, resolve_doctor_id(doctor_name) AS doctor_id
       FROM appointments WHERE id = $1`,
    [appointmentId],
  );
  const a = rows[0];
  if (!a || a.doctor_id !== doctorId || a.date !== date || !a.time_slot) return null;
  return (await isSlotAvailable(doctorId, date, a.time_slot, { client })).slot_label || null;
}
