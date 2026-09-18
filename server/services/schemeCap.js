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

async function capScopes(schemeCode, client) {
  const { rows } = await client.query(
    `WITH me AS (SELECT code, label, daily_cap, parent_code FROM patient_schemes WHERE code = $1)
     SELECT me.code AS scope_code, me.label AS scope_label, me.daily_cap AS cap,
            ARRAY(SELECT me.code UNION SELECT c.code FROM patient_schemes c
                   WHERE c.parent_code = me.code) AS codes,
            0 AS depth
       FROM me
     UNION ALL
     SELECT p.code, p.label, p.daily_cap,
            ARRAY(SELECT p.code UNION SELECT c.code FROM patient_schemes c
                   WHERE c.parent_code = p.code),
            1
       FROM me JOIN patient_schemes p ON p.code = me.parent_code
      ORDER BY depth`,
    [schemeCode],
  );
  return rows.map((r) => ({
    scope_code: r.scope_code,
    scope_label: r.scope_label,
    cap: r.cap === null ? null : Number(r.cap),
    codes: r.codes,
  }));
}

async function bookedByCategory(codes, fromDate, toDate, client) {
  const { rows } = await client.query(
    `SELECT appointment_date::text AS date, patient_category AS code, COUNT(*)::int AS n
       FROM appointments
      WHERE appointment_date BETWEEN $2::date AND $3::date
        AND patient_category = ANY($1::text[])
        AND ${ACTIVE}
      GROUP BY 1, 2`,
    [codes, fromDate, toDate],
  );
  return rows;
}

function bindingState(scopes, counts, date) {
  const states = scopes.map((scope) => ({
    ...scope,
    booked: counts
      .filter((c) => c.date === date && scope.codes.includes(c.code))
      .reduce((sum, c) => sum + c.n, 0),
  }));
  const capped = states.filter((s) => s.cap !== null);
  const pick = capped.length
    ? capped.reduce((tight, s) => (s.cap - s.booked < tight.cap - tight.booked ? s : tight))
    : states[0];
  return {
    cap: pick.cap,
    booked: pick.booked,
    scope_code: pick.scope_code,
    scope_label: pick.scope_label,
    includes_sub_categories: pick.codes.length > 1,
  };
}

const allCodes = (scopes) => [...new Set(scopes.flatMap((s) => s.codes))];

// How many of this scheme are already booked that day, and the ceiling.
// `client` matters: the caller passes its transaction so the count is taken
// under the same lock as the insert — two bookings racing at 9/10 would both
// pass an unlocked count.
export async function schemeDayCount(schemeCode, date, client = pool) {
  const scopes = await capScopes(schemeCode, client);
  if (!scopes.length) return null;
  const counts = await bookedByCategory(allCodes(scopes), date, date, client);
  const day = (await client.query(`SELECT $1::date::text AS d`, [date])).rows[0].d;
  return bindingState(scopes, counts, day);
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
  const scopes = await capScopes(schemeCode, client);
  if (!scopes.length) return [];
  const { rows: dates } = await client.query(
    `SELECT ($1::date + n)::date::text AS date FROM generate_series(1, $2::int) AS n ORDER BY 1`,
    [fromDate, days],
  );
  if (!dates.length) return [];
  const counts = await bookedByCategory(allCodes(scopes), dates[0].date, dates.at(-1).date, client);
  return dates
    .map(({ date }) => ({ date, ...bindingState(scopes, counts, date) }))
    .filter((d) => d.cap === null || d.booked < d.cap)
    .slice(0, want)
    .map(({ date, booked, cap }) => ({ date, booked, cap }));
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
  const detail = `${state.scope_label} is full for ${date} — ${state.booked}/${state.cap} booked${state.includes_sub_categories ? ", counting its sub-categories" : ""}`;

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
