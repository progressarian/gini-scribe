import pool from "../config/db.js";
import { hasCapability, CAPABILITIES } from "../../shared/permissions.js";

export const SCHEME_CAP_ENFORCEMENT = (process.env.SCHEME_CAP_ENFORCEMENT || "off").toLowerCase();

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

export async function schemeDayCount(schemeCode, date, client = pool) {
  const scopes = await capScopes(schemeCode, client);
  if (!scopes.length) return null;
  const counts = await bookedByCategory(allCodes(scopes), date, date, client);
  const day = (await client.query(`SELECT $1::date::text AS d`, [date])).rows[0].d;
  return bindingState(scopes, counts, day);
}

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
export async function checkSchemeCap({ schemeCode, date, force, role }, client = pool) {
  if (SCHEME_CAP_ENFORCEMENT === "off" || !schemeCode || !date) return null;

  const state = await schemeDayCount(schemeCode, date, client);
  if (!state || state.cap === null || state.booked < state.cap) return null;

  const alternatives = await nextDatesWithRoom(schemeCode, date, {}, client);
  const detail = `${state.scope_label} is full for ${date} — ${state.booked}/${state.cap} booked${state.includes_sub_categories ? ", counting its sub-categories" : ""}`;

  if (SCHEME_CAP_ENFORCEMENT === "warn") {
    return { warn: true, reason: "scheme_cap_full", detail, alternatives, ...state };
  }
  if (force && hasCapability(role, CAPABILITIES.ADMIN)) {
    return { overridden: true, reason: "scheme_cap_full", detail, alternatives, ...state };
  }
  return { blocked: true, reason: "scheme_cap_full", detail, alternatives, ...state };
}

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
