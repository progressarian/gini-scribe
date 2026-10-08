import pool from "../config/db.js";
import { slotStartHour } from "../../shared/slotHour.js";
import { logAppointmentEvent } from "./appointmentHistory.js";

const istNow = () => new Date(Date.now() + 5.5 * 60 * 60 * 1000);

export function noShowBeforeSlot(row) {
  const day = String(row?.appointment_date || "").slice(0, 10);
  if (!day) return false;
  const now = istNow();
  const today = now.toISOString().slice(0, 10);
  if (day > today) return true;
  if (day < today) return false;
  const start = slotStartHour(row.time_slot);
  return start !== null && now.getUTCHours() + now.getUTCMinutes() / 60 < start;
}

export const keepsFloorAbsence = (floorStatus, status) =>
  (floorStatus === "cancelled" && ["scheduled", "checkedin"].includes(status)) ||
  (floorStatus === "no_show" && status === "scheduled");

export async function applySyncedStatus(appointmentId, status, db = pool) {
  const { rows } = await db.query(
    `SELECT a.appointment_date::text AS appointment_date, a.time_slot, a.status,
            fv.current_status AS floor_status
       FROM appointments a
       LEFT JOIN giniflow_visits fv ON fv.appointment_id = a.id
      WHERE a.id = $1`,
    [appointmentId],
  );
  const row = rows[0];
  if (!row || row.status === status) return false;
  if (status === "no_show" && noShowBeforeSlot(row)) return false;
  if (keepsFloorAbsence(row.floor_status, status)) return false;
  await db.query(`UPDATE appointments SET status = $2, updated_at = NOW() WHERE id = $1`, [
    appointmentId,
    status,
  ]);
  return true;
}

const FLOOR_TO_APPOINTMENT = {
  cancelled: { status: "cancelled", from: [null, "scheduled", "pending", "checkedin"] },
  no_show: { status: "no_show", from: [null, "scheduled", "pending"] },
  booked: { status: "scheduled", from: ["cancelled", "no_show"] },
};

export async function mirrorFloorStatus(db, visitId, floorStatus, { actorId = null, reason } = {}) {
  const rule = FLOOR_TO_APPOINTMENT[floorStatus];
  if (!rule) return;
  const { rows } = await db.query(
    `UPDATE appointments a
        SET status = $2, updated_at = NOW()
       FROM giniflow_visits v, appointments old
      WHERE v.id = $1 AND a.id = v.appointment_id AND old.id = a.id
        AND (old.status IS NULL AND $3::boolean OR old.status = ANY($4::text[]))
      RETURNING a.id, old.status AS old_status`,
    [visitId, rule.status, rule.from.includes(null), rule.from.filter(Boolean)],
  );
  if (!rows[0]) return;
  const actor = actorId
    ? (
        await db.query(
          `SELECT id, COALESCE(NULLIF(TRIM(short_name), ''), name) AS name FROM doctors WHERE id = $1`,
          [actorId],
        )
      ).rows[0] || { id: actorId }
    : {};
  await logAppointmentEvent(db, {
    appointmentId: rows[0].id,
    field: "status",
    label: "Status (reception)",
    oldValue: rows[0].old_status,
    newValue: reason ? `${rule.status} (${reason})` : rule.status,
    actor,
  });
}
