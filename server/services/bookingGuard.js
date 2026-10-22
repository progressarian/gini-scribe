// ============================================================================
// Booking availability guard — shared by every appointment-insert path so the
// rule lives in one place. Controlled by SCHEDULE_ENFORCEMENT:
//   off    → never checked (default)
//   warn   → compute, attach a warning, but still book
//   strict → reject (409) unless an admin passes force=true
//
// Design: docs/doctor-management/08-booking-integration.md
// ============================================================================
import pool from "../config/db.js";
import { DONE_OR_INPROGRESS, isSlotAvailable } from "./availability.js";
import { hasCapability, CAPABILITIES } from "../../shared/permissions.js";

export const SCHEDULE_ENFORCEMENT = (process.env.SCHEDULE_ENFORCEMENT || "off").toLowerCase();

// Free-text doctor name → doctors.id (tolerant of name/short_name). null if none.
export async function resolveDoctorIdByName(name, client = pool) {
  if (!name) return null;
  const r = await client.query("SELECT resolve_doctor_id($1) AS id", [name]);
  return r.rows[0]?.id || null;
}

// Returns null when the booking is allowed (enforcement off, unknown doctor,
// unknown/free slot, available, or admin-overridden). Otherwise an object:
//   { warn:true, reason, detail }    (warn mode — caller still inserts)
//   { blocked:true, reason, detail } (strict mode — caller should 409)
// Takes a pre-resolved doctorId.
export async function checkBookingAvailability({ doctorId, date, slot, force, role }) {
  if (SCHEDULE_ENFORCEMENT === "off" || !doctorId || !date || !slot) return null;
  const a = await isSlotAvailable(doctorId, date, slot);
  // Free-form / non-catalog slots (e.g. OPD's "09:30") aren't enforced.
  if (a.available || a.reason === "unknown_slot") return null;
  if (SCHEDULE_ENFORCEMENT === "warn") return { warn: true, reason: a.reason, detail: a.detail };
  if (force && hasCapability(role, CAPABILITIES.ADMIN)) return null;
  return { blocked: true, reason: a.reason, detail: a.detail };
}

const BOOKING_KEYS = ["appointment_date", "time_slot", "doctor_name"];

export async function checkBookingChange(
  appointmentId,
  changes,
  { force, role, client = pool } = {},
) {
  if (SCHEDULE_ENFORCEMENT === "off" || !BOOKING_KEYS.some((k) => k in changes)) return null;
  const { rows } = await client.query(
    `SELECT appointment_date::text, time_slot, doctor_name, status FROM appointments WHERE id=$1`,
    [appointmentId],
  );
  if (!rows.length) return null;
  const before = rows[0];
  const after = { ...before };
  for (const k of [...BOOKING_KEYS, "status"])
    if (k in changes) after[k] = changes[k] === "" ? null : changes[k];
  if (BOOKING_KEYS.every((k) => (after[k] ?? null) === (before[k] ?? null))) return null;
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  if (!after.appointment_date || String(after.appointment_date).slice(0, 10) < today) return null;
  if (DONE_OR_INPROGRESS.includes(String(after.status || "").toLowerCase())) return null;
  return checkBookingAvailability({
    doctorId: await resolveDoctorIdByName(after.doctor_name, client),
    date: String(after.appointment_date).slice(0, 10),
    slot: after.time_slot,
    force,
    role,
  });
}
