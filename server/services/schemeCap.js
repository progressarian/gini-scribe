// ============================================================================
// Scheme daily cap — how many CGHS / ECHS patients the hospital will see in a
// day (33-PATIENT-SCHEME-PLAN.md §5, D1, D4).
//
// Dimension: per scheme, per calendar day, HOSPITAL-WIDE. Not per doctor and
// not per slot — a reimbursement ceiling is an agreement with the scheme, not a
// scheduling matter for one consultant.
//
// Its own switch, deliberately: SCHEDULE_ENFORCEMENT is `off` in production, and
// a cap that inherited a disabled guard would silently never fire.
//   off    → never checked (default)
//   warn   → compute, attach a warning, still book
//   strict → refuse unless an admin passes force=true
// ============================================================================
import pool from "../config/db.js";
import { hasCapability, CAPABILITIES } from "../../shared/permissions.js";

export const SCHEME_CAP_ENFORCEMENT = (process.env.SCHEME_CAP_ENFORCEMENT || "off").toLowerCase();

// The same definition of a seat-consuming booking that availability.js uses, so
// the cap counter and every other screen agree on what counts.
const ACTIVE = `status NOT IN ('cancelled','no_show')`;

// How many of this scheme are already booked that day, and the ceiling.
// `client` matters: the caller passes its transaction so the count is taken
// under the same lock as the insert — two bookings racing at 9/10 would both
// pass an unlocked count.
export async function schemeDayCount(schemeCode, date, client = pool) {
  const { rows } = await client.query(
    `SELECT s.daily_cap,
            (SELECT COUNT(*)::int FROM appointments a
              WHERE a.appointment_date = $2::date
                AND a.patient_category = $1
                AND ${ACTIVE}) AS booked
       FROM patient_schemes s
      WHERE s.code = $1`,
    [schemeCode, date],
  );
  if (!rows.length) return null;
  const cap = rows[0].daily_cap === null ? null : Number(rows[0].daily_cap);
  return { cap, booked: Number(rows[0].booked) };
}

// The next few dates that still have room, so a refusal is never a dead end
// (D4). Mirrors the shape availability.js's findAvailableDoctors returns, on a
// date axis rather than a doctor axis.
export async function nextDatesWithRoom(
  schemeCode,
  fromDate,
  { days = 14, want = 3 } = {},
  client = pool,
) {
  const { rows } = await client.query(
    `WITH cap AS (SELECT daily_cap FROM patient_schemes WHERE code = $1),
     days AS (
       SELECT ($2::date + n)::date AS d
         FROM generate_series(1, $3::int) AS n
     )
     SELECT d::text AS date,
            (SELECT COUNT(*)::int FROM appointments a
              WHERE a.appointment_date = days.d
                AND a.patient_category = $1
                AND ${ACTIVE}) AS booked,
            (SELECT daily_cap FROM cap) AS cap
       FROM days
      ORDER BY d`,
    [schemeCode, fromDate, days],
  );
  return rows
    .filter((r) => r.cap === null || Number(r.booked) < Number(r.cap))
    .slice(0, want)
    .map((r) => ({
      date: r.date,
      booked: Number(r.booked),
      cap: r.cap === null ? null : Number(r.cap),
    }));
}

// Returns null when the booking is allowed. Otherwise the same two shapes
// bookingGuard.js uses, so callers handle one contract:
//   { warn: true, reason: "scheme_cap_full", detail, alternatives }
//   { blocked: true, reason: "scheme_cap_full", detail, alternatives }
//
// Sync-created appointments (HealthRay, Sheets) must never reach this: they
// count toward the ceiling but cannot be refused, because HealthRay is
// authoritative and rejecting its rows would only desync the two systems. That
// is enforced by which callers invoke it, not by a flag here.
export async function checkSchemeCap({ schemeCode, date, force, role }, client = pool) {
  if (SCHEME_CAP_ENFORCEMENT === "off" || !schemeCode || !date) return null;

  const state = await schemeDayCount(schemeCode, date, client);
  if (!state || state.cap === null || state.booked < state.cap) return null;

  const alternatives = await nextDatesWithRoom(schemeCode, date, {}, client);
  const detail = `${schemeCode.toUpperCase()} is full for ${date} — ${state.booked}/${state.cap} booked`;

  if (SCHEME_CAP_ENFORCEMENT === "warn") {
    return { warn: true, reason: "scheme_cap_full", detail, alternatives, ...state };
  }
  // An admin forcing past a full scheme is allowed, but it is not nothing:
  // returning null here would let the booking through with no trace, and the
  // audit row is the only thing that makes the ceiling real (§6). The caller
  // proceeds on `overridden` exactly as it would on null, and logs it.
  if (force && hasCapability(role, CAPABILITIES.ADMIN)) {
    return { overridden: true, reason: "scheme_cap_full", detail, alternatives, ...state };
  }
  return { blocked: true, reason: "scheme_cap_full", detail, alternatives, ...state };
}

// Every override is written down. Without this the cap is theatre: it will be
// forced, and nobody will be able to say how often or by whom (§6).
export async function logCapOverride(
  { schemeCode, date, booked, cap, actorId, actorName, appointmentId = null },
  client = pool,
) {
  await client
    .query(
      `INSERT INTO scheme_cap_overrides
         (scheme_code, appointment_date, booked_at_override, cap_at_override,
          appointment_id, overridden_by, overridden_by_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [schemeCode, date, booked, cap, appointmentId, actorId, actorName],
    )
    .catch(() => {});
}
