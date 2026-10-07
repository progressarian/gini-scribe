import pool from "../config/db.js";

export const AUDIT_FIELDS = new Set([
  "booking_created",
  "call_logged",
  "call_log_deleted",
  "history_deleted",
  "sheet_sync",
]);

export const actorOf = (req) => ({
  id: req?.doctor?.doctor_id || null,
  name: (req?.doctor?.short_name || req?.doctor?.doctor_name || "").trim() || null,
});

export const SHEET_SYNC_ACTOR = { id: null, name: "Booking sheet sync" };

export async function logAppointmentEvent(
  db,
  { appointmentId, field, label, oldValue = null, newValue = null, actor = {} },
) {
  if (!appointmentId) return;
  await (db || pool).query(
    `INSERT INTO appointment_change_log
       (appointment_id, field, field_label, old_value, new_value, changed_by, changed_by_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      appointmentId,
      field,
      label,
      oldValue == null || oldValue === "" ? null : String(oldValue),
      newValue == null || newValue === "" ? null : String(newValue),
      actor.name || null,
      actor.id || null,
    ],
  );
}

export const describeBooking = (row) =>
  [String(row.appointment_date || "").slice(0, 10), row.time_slot, row.doctor_name]
    .filter(Boolean)
    .join(" · ");

export async function logBookingCreated(db, row, actor) {
  if (!row?.id || !row.appointment_date) return;
  await logAppointmentEvent(db, {
    appointmentId: row.id,
    field: "booking_created",
    label: "Appointment booked",
    newValue: describeBooking(row),
    actor,
  });
}

export async function logFieldChanges(db, appointmentId, before, after, labels, actor) {
  for (const [field, label] of Object.entries(labels)) {
    if (!(field in after) || after[field] == null) continue;
    const oldV = before?.[field] == null ? "" : String(before[field]);
    const newV = String(after[field]);
    const norm = (v) => (field.endsWith("_date") ? v.slice(0, 10) : v);
    if (norm(oldV) === norm(newV)) continue;
    await logAppointmentEvent(db, {
      appointmentId,
      field,
      label,
      oldValue: norm(oldV),
      newValue: norm(newV),
      actor,
    });
  }
}
