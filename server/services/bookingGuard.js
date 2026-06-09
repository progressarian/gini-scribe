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
import { isSlotAvailable } from "./availability.js";
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
