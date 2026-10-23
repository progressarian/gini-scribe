import pool from "../../config/db.js";
import { logAppointmentEvent } from "../appointmentHistory.js";
import { approvalsReady } from "./approvalStore.js";

const istToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

const httpError = (status, message) => Object.assign(new Error(message), { status });

export async function approvalCounts({ client = pool } = {}) {
  if (!(await approvalsReady(client))) return { pending: 0, overdue: 0 };
  const { rows } = await client.query(
    `SELECT count(*)::int AS pending,
            count(*) FILTER (WHERE appointment_date <= $1::date)::int AS overdue
       FROM booking_approvals WHERE status = 'pending'`,
    [istToday()],
  );
  return rows[0];
}

export async function myDecidedRequests(doctorId, { client = pool } = {}) {
  if (!doctorId || !(await approvalsReady(client))) return [];
  const { rows } = await client.query(
    `SELECT ba.id, ba.appointment_id, ba.appointment_date::text, ba.slot_label, ba.patient_type,
            ba.limit_at_request AS limit, ba.status, ba.reason, ba.decided_at,
            dc.name AS decided_by, d.name AS doctor_name, a.patient_name, a.file_no, a.phone,
            a.time_slot AS current_slot
       FROM booking_approvals ba
       JOIN appointments a ON a.id = ba.appointment_id
       LEFT JOIN doctors d ON d.id = ba.doctor_id
       LEFT JOIN doctors dc ON dc.id = ba.decided_by
      WHERE ba.requested_by = $1
        AND ba.status IN ('approved', 'rejected')
        AND ba.decided_by IS DISTINCT FROM ba.requested_by
        AND ba.decided_at > NOW() - INTERVAL '7 days'
      ORDER BY ba.decided_at DESC
      LIMIT 100`,
    [doctorId],
  );
  return rows;
}

export async function listApprovals(view, { client = pool } = {}) {
  if (!(await approvalsReady(client))) return [];
  const pending = view !== "decided";
  const { rows } = await client.query(
    `SELECT ba.id, ba.appointment_id, ba.appointment_date::text, ba.slot_label, ba.patient_type,
            ba.limit_at_request AS limit, ba.count_at_request AS count, ba.status, ba.reason,
            to_jsonb(ba)->>'request_reason' AS request_reason,
            ba.requested_at, ba.decided_at, rq.name AS requested_by, dc.name AS decided_by,
            d.name AS doctor_name, a.patient_name, a.file_no, p.health_id, a.phone,
            a.time_slot AS current_slot, a.status AS booking_status,
            ba.appointment_date <= $2::date AS overdue
       FROM booking_approvals ba
       JOIN appointments a ON a.id = ba.appointment_id
       LEFT JOIN patients p ON p.id = a.patient_id
       LEFT JOIN doctors d ON d.id = ba.doctor_id
       LEFT JOIN doctors rq ON rq.id = ba.requested_by
       LEFT JOIN doctors dc ON dc.id = ba.decided_by
      WHERE ${pending ? "ba.status = 'pending'" : "ba.status <> 'pending' AND ba.decided_at > NOW() - INTERVAL '30 days'"}
      ORDER BY ${pending ? "overdue DESC, ba.appointment_date, ba.requested_at" : "ba.decided_at DESC"}
      LIMIT $1`,
    [pending ? 500 : 200, istToday()],
  );
  return rows;
}

async function decide(id, actor, status, reason) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `UPDATE booking_approvals
          SET status = $2, decided_by = $3, decided_at = NOW(), reason = $4
        WHERE id = $1 AND status = 'pending'
        RETURNING id, appointment_id, slot_label, patient_type`,
      [id, status, actor.id, reason],
    );
    if (!rows.length)
      throw httpError(409, "This request was already decided or withdrawn. Reload the list.");
    const approval = rows[0];
    if (status === "rejected") {
      const before = await client.query(
        "SELECT time_slot FROM appointments WHERE id = $1 FOR UPDATE",
        [approval.appointment_id],
      );
      await client.query(
        "UPDATE appointments SET time_slot = NULL, updated_at = NOW() WHERE id = $1",
        [approval.appointment_id],
      );
      await logAppointmentEvent(client, {
        appointmentId: approval.appointment_id,
        field: "time_slot",
        label: "Time Slot",
        oldValue: before.rows[0]?.time_slot,
        newValue: null,
        actor,
      });
    }
    await logAppointmentEvent(client, {
      appointmentId: approval.appointment_id,
      field: "booking_approval",
      label: "Over-limit approval",
      oldValue: "Pending approval",
      newValue: status === "approved" ? "Approved" : `Rejected: ${reason}`,
      actor,
    });
    await client.query("COMMIT");
    return approval;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export const approveBooking = (id, actor) => decide(id, actor, "approved", null);

export const rejectBooking = (id, actor, reason) => {
  const why = String(reason || "").trim();
  if (!why) throw httpError(400, "Give a reason, so the desk knows why and can pick another slot.");
  if (why.length > 300) throw httpError(400, "Keep the reason to 300 characters.");
  return decide(id, actor, "rejected", why);
};
