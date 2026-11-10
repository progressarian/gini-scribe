import crypto from "node:crypto";
import { withCrmContext } from "./db.js";
import { DoctorError, isLead } from "./doctors.js";
import { ASSIGNABLE_ROLES } from "./assignees.js";
import { addDays, daysBetween, ddmmyyyy, istDate } from "./istPeriods.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_SPAN = 31;
const REP_BACK = 7;
const REP_AHEAD = 90;
const LEAD_REACH = 365;
const TITLE = /^[A-Za-z0-9][A-Za-z0-9 .,'&()/-]*$/;
const LEAVE_FILTERS = ["pending", "approved", "rejected", "cancelled", "all"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const isSunday = (day) => new Date(`${day}T00:00:00Z`).getUTCDay() === 0;

const shortDay = (day) => {
  const [, m, d] = day.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]}`;
};

const realDay = (d) =>
  ISO_DAY.test(d ?? "") && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;

const textOf = (v) =>
  String(v ?? "")
    .replace(/\s+/g, " ")
    .trim();

function fail(message, fields) {
  throw new DoctorError(message, 400, fields ? { fields } : {});
}

function assertLead(crmUser) {
  if (!isLead(crmUser)) throw new DoctorError("Only your admin can do this.", 403);
}

function assertRequestId(id) {
  if (!UUID.test(id || "")) throw new DoctorError("Request not found.", 404);
}

function readRange(body, { back, ahead }) {
  const from = String(body.from ?? "");
  const to = String(body.to || body.from || "");
  if (!realDay(from)) fail("Choose the first day.", { from: "Choose the first day." });
  if (!realDay(to)) fail("Choose the last day.", { to: "Choose the last day." });
  if (to < from) {
    fail("The last day must be on or after the first day.", {
      to: "The last day must be on or after the first day.",
    });
  }
  if (daysBetween(from, to) + 1 > MAX_SPAN) {
    fail(`Choose ${MAX_SPAN} days or fewer at a time.`, {
      to: `Choose ${MAX_SPAN} days or fewer at a time.`,
    });
  }
  const today = istDate();
  const earliest = addDays(today, -back);
  const latest = addDays(today, ahead);
  if (from < earliest || to > latest) {
    const message =
      back === REP_BACK
        ? `Leave can be requested from ${ddmmyyyy(earliest)} up to ${ddmmyyyy(latest)}.`
        : `Choose dates between ${ddmmyyyy(earliest)} and ${ddmmyyyy(latest)}.`;
    fail(message, from < earliest ? { from: message } : { to: message });
  }
  const days = [];
  for (let d = from; d <= to; d = addDays(d, 1)) if (!isSunday(d)) days.push(d);
  if (!days.length) {
    fail("Pick at least one day that is not a Sunday.", {
      from: "Pick at least one day that is not a Sunday.",
    });
  }
  return { from, to, days };
}

function readNote(value, { field, required, label }) {
  const text = textOf(value);
  if (required && !text) fail(`Write ${label}.`, { [field]: `Write ${label}.` });
  if (text.length > 200)
    fail("Keep it under 200 letters.", { [field]: "Keep it under 200 letters." });
  return text || null;
}

async function hospitalOf(sql, userId) {
  const { rows } = await sql(
    "SELECT hospital_id FROM crm.user_hospitals WHERE user_id = $1 ORDER BY hospital_id LIMIT 1",
    [userId],
  );
  if (!rows[0]) throw new DoctorError("This person is not linked to a hospital in the CRM.", 409);
  return rows[0].hospital_id;
}

async function staffList(sql) {
  const { rows } = await sql(
    `SELECT id, full_name FROM crm.users
      WHERE is_active AND deleted_at IS NULL AND role = ANY($1::text[]) ORDER BY full_name`,
    [ASSIGNABLE_ROLES],
  );
  return rows;
}

const listDays = (days) =>
  days.length > 4
    ? `${days.slice(0, 4).map(shortDay).join(", ")} and ${days.length - 4} more`
    : days.map(shortDay).join(", ");

export async function addHoliday(crmUser, body = {}) {
  assertLead(crmUser);
  const title = textOf(body.title);
  if (!title)
    fail("Enter the holiday name, like Diwali.", { title: "Enter the holiday name, like Diwali." });
  if (title.length > 60 || !TITLE.test(title)) {
    fail("Use letters and numbers only, up to 60, like Diwali.", {
      title: "Use letters and numbers only, up to 60, like Diwali.",
    });
  }
  const { days } = readRange(body, { back: LEAD_REACH, ahead: LEAD_REACH });
  return withCrmContext(crmUser, async (sql) => {
    const hospital = await hospitalOf(sql, crmUser.id);
    const { rows: taken } = await sql(
      `SELECT day::text AS day, title FROM crm.days_off
        WHERE hospital_id = $1 AND kind = 'holiday' AND status = 'approved'
          AND deleted_at IS NULL AND day = ANY($2::date[])
        ORDER BY day`,
      [hospital, days],
    );
    if (taken.length) {
      const message = `${listDays(taken.map((t) => t.day))} ${
        taken.length === 1 ? "is" : "are"
      } already a holiday (${taken[0].title}).`;
      throw new DoctorError(message, 409, { fields: { from: message } });
    }
    const requestId = crypto.randomUUID();
    await sql(
      `INSERT INTO crm.days_off
         (hospital_id, kind, day, request_id, title, status, requested_by, decided_by, decided_at)
       SELECT $1, 'holiday', d, $2, $3, 'approved', $4, $4, now()
         FROM unnest($5::date[]) d`,
      [hospital, requestId, title, crmUser.id, days],
    );
    return { request_id: requestId, days: days.length };
  });
}

export async function removeHoliday(crmUser, requestId) {
  assertLead(crmUser);
  assertRequestId(requestId);
  return withCrmContext(crmUser, async (sql) => {
    const { rowCount } = await sql(
      `UPDATE crm.days_off SET deleted_at = now(), decided_by = $2, decided_at = now()
        WHERE request_id = $1 AND kind = 'holiday' AND deleted_at IS NULL`,
      [requestId, crmUser.id],
    );
    if (!rowCount) throw new DoctorError("This holiday was already removed.", 409);
    return { removed: rowCount };
  });
}

export async function requestLeave(crmUser, body = {}) {
  const lead = isLead(crmUser);
  const forSomeone = lead && body.user_id && body.user_id !== crmUser.id;
  const range = readRange(
    body,
    lead ? { back: LEAD_REACH, ahead: LEAD_REACH } : { back: REP_BACK, ahead: REP_AHEAD },
  );
  const half = body.half_day === true;
  if (half && range.from !== range.to) {
    fail("A half day can only be one date. Set the last day to the same as the first day.", {
      half_day: "A half day can only be one date. Set the last day to the same as the first day.",
    });
  }
  const note = readNote(body.note, { field: "note", required: false, label: "a reason" });
  return withCrmContext(crmUser, async (sql) => {
    let userId = crmUser.id;
    if (forSomeone) {
      if (!UUID.test(String(body.user_id))) {
        fail("Choose a staff member from the list.", {
          user_id: "Choose a staff member from the list.",
        });
      }
      const staff = await staffList(sql);
      if (!staff.some((s) => s.id === body.user_id)) {
        fail("Choose a staff member from the list.", {
          user_id: "Choose a staff member from the list.",
        });
      }
      userId = body.user_id;
    }
    const hospital = await hospitalOf(sql, userId);
    const { rows: holidays } = await sql(
      `SELECT day::text AS day FROM crm.days_off
        WHERE hospital_id = $1 AND kind = 'holiday' AND status = 'approved'
          AND deleted_at IS NULL AND day = ANY($2::date[])`,
      [hospital, range.days],
    );
    const holidaySet = new Set(holidays.map((h) => h.day));
    const days = range.days.filter((d) => !holidaySet.has(d));
    if (!days.length) {
      fail("Those days are already holidays or Sundays. No leave is needed.", {
        from: "Those days are already holidays or Sundays. No leave is needed.",
      });
    }
    const { rows: clash } = await sql(
      `SELECT day::text AS day FROM crm.days_off
        WHERE user_id = $1 AND kind = 'leave' AND status IN ('pending', 'approved')
          AND deleted_at IS NULL AND day = ANY($2::date[])
        ORDER BY day`,
      [userId, days],
    );
    if (clash.length) {
      const message = `${forSomeone ? "They" : "You"} already have leave on ${listDays(
        clash.map((c) => c.day),
      )}.`;
      throw new DoctorError(message, 409, { fields: { from: message } });
    }
    const approved = lead;
    const requestId = crypto.randomUUID();
    await sql(
      `INSERT INTO crm.days_off
         (hospital_id, kind, day, user_id, request_id, note, portion, status,
          requested_by, decided_by, decided_at)
       SELECT $1, 'leave', d, $2, $3, $4, $5, $6, $7,
              CASE WHEN $8 THEN $7::uuid END, CASE WHEN $8 THEN now() END
         FROM unnest($9::date[]) d`,
      [
        hospital,
        userId,
        requestId,
        note,
        half ? "half" : "full",
        approved ? "approved" : "pending",
        crmUser.id,
        approved,
        days,
      ],
    );
    return {
      request_id: requestId,
      status: approved ? "approved" : "pending",
      days: half ? 0.5 : days.length,
      skipped_holidays: holidaySet.size,
    };
  });
}

async function lockedRequest(sql, requestId) {
  const { rows } = await sql(
    `SELECT o.id, o.status, o.user_id, o.day, o.decided_at, u.full_name AS decided_by_name
       FROM crm.days_off o
       LEFT JOIN crm.users u ON u.id = o.decided_by
      WHERE o.request_id = $1 AND o.kind = 'leave' AND o.deleted_at IS NULL`,
    [requestId],
  );
  if (!rows.length) throw new DoctorError("Leave request not found.", 404);
  return rows;
}

const STATUS_WORD = { approved: "approved", rejected: "rejected", cancelled: "cancelled" };

function alreadyDecided(row) {
  return new DoctorError(
    `Already ${STATUS_WORD[row.status]}${row.decided_by_name ? ` by ${row.decided_by_name}` : ""}.`,
    409,
  );
}

export async function decideLeave(crmUser, requestId, { approve, note } = {}) {
  assertLead(crmUser);
  assertRequestId(requestId);
  const text = readNote(note, {
    field: "note",
    required: !approve,
    label: "a short note so they know why",
  });
  return withCrmContext(crmUser, async (sql) => {
    const rows = await lockedRequest(sql, requestId);
    const pending = rows.filter((r) => r.status === "pending");
    if (!pending.length) throw alreadyDecided(rows[0]);
    const { rowCount } = await sql(
      `UPDATE crm.days_off
          SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4
        WHERE request_id = $1 AND kind = 'leave' AND status = 'pending' AND deleted_at IS NULL`,
      [requestId, approve ? "approved" : "rejected", crmUser.id, text],
    );
    if (!rowCount) throw new DoctorError("This request was just decided. Refresh to see it.", 409);
    return { status: approve ? "approved" : "rejected", days: pending.length };
  });
}

export async function cancelLeave(crmUser, requestId) {
  assertRequestId(requestId);
  const lead = isLead(crmUser);
  return withCrmContext(crmUser, async (sql) => {
    const rows = await lockedRequest(sql, requestId);
    if (!lead && rows[0].user_id !== crmUser.id) {
      throw new DoctorError("Leave request not found.", 404);
    }
    const open = rows.filter((r) =>
      lead ? ["pending", "approved"].includes(r.status) : r.status === "pending",
    );
    if (!open.length) {
      if (!lead && rows.some((r) => r.status === "approved")) {
        throw new DoctorError("This leave is already approved. Ask your admin to cancel it.", 409);
      }
      throw alreadyDecided(rows[0]);
    }
    const { rowCount } = await sql(
      `UPDATE crm.days_off SET status = 'cancelled', decided_by = $2, decided_at = now()
        WHERE request_id = $1 AND kind = 'leave' AND deleted_at IS NULL
          AND status = ANY($3::text[])`,
      [requestId, crmUser.id, lead ? ["pending", "approved"] : ["pending"]],
    );
    if (!rowCount) throw new DoctorError("This request was just decided. Refresh to see it.", 409);
    return { status: "cancelled", days: open.length };
  });
}

export async function listDaysOff(crmUser, query = {}) {
  const lead = isLead(crmUser);
  const status = LEAVE_FILTERS.includes(query.status) ? query.status : lead ? "pending" : "all";
  const person = lead && UUID.test(String(query.user ?? "")) ? String(query.user) : null;
  const today = istDate();
  return withCrmContext(crmUser, async (sql) => {
    const { rows: holidays } = await sql(
      `SELECT o.request_id, min(o.title) AS title,
              min(o.day)::text AS from_day, max(o.day)::text AS to_day,
              count(*)::int AS days, min(u.full_name) AS added_by_name
         FROM crm.days_off o
         LEFT JOIN crm.users u ON u.id = o.requested_by
        WHERE o.kind = 'holiday' AND o.status = 'approved' AND o.deleted_at IS NULL
          AND o.day >= $1::date
        GROUP BY o.request_id
        ORDER BY min(o.day)`,
      [addDays(today, -LEAD_REACH)],
    );
    const { rows: leave } = await sql(
      `SELECT o.request_id, o.user_id, min(p.full_name) AS full_name, min(o.status) AS status,
              min(o.day)::text AS from_day, max(o.day)::text AS to_day,
              sum(CASE WHEN o.portion = 'half' THEN 0.5 ELSE 1 END)::float8 AS days,
              min(o.portion) AS portion, min(o.note) AS note,
              min(o.decision_note) AS decision_note, max(o.created_at) AS created_at,
              max(o.decided_at) AS decided_at,
              min(r.full_name) AS requested_by_name, min(d.full_name) AS decided_by_name,
              bool_or(o.requested_by <> o.user_id) AS added_by_admin
         FROM crm.days_off o
         JOIN crm.users p ON p.id = o.user_id
         LEFT JOIN crm.users r ON r.id = o.requested_by
         LEFT JOIN crm.users d ON d.id = o.decided_by
        WHERE o.kind = 'leave' AND o.deleted_at IS NULL
          AND ($1::boolean OR o.user_id = $2)
          AND ($3::uuid IS NULL OR o.user_id = $3)
          AND ($4 = 'all' OR o.status = $4)
          AND o.day >= $5::date
        GROUP BY o.request_id, o.user_id
        ORDER BY (min(o.status) = 'pending') DESC, min(o.day) DESC
        LIMIT 200`,
      [lead, crmUser.id, person, status, addDays(today, -LEAD_REACH)],
    );
    const { rows: counts } = await sql(
      `SELECT count(DISTINCT request_id)::int AS pending
         FROM crm.days_off
        WHERE kind = 'leave' AND status = 'pending' AND deleted_at IS NULL
          AND ($1::boolean OR user_id = $2)`,
      [lead, crmUser.id],
    );
    return {
      today,
      is_admin: lead,
      status,
      user: person,
      pending: counts[0].pending,
      holidays,
      leave,
      staff: lead ? await staffList(sql) : [],
      limits: lead
        ? { from: addDays(today, -LEAD_REACH), to: addDays(today, LEAD_REACH) }
        : { from: addDays(today, -REP_BACK), to: addDays(today, REP_AHEAD) },
    };
  });
}

export const DAYS_OFF_IN_RANGE_SQL = `SELECT o.day::text AS day, o.kind, o.user_id, o.portion, o.title
       FROM crm.days_off o
      WHERE o.status = 'approved' AND o.deleted_at IS NULL
        AND o.day BETWEEN $10::date AND $3::date
        AND (o.kind = 'holiday' OR o.user_id = ANY($1::uuid[]))`;

export function offIndex(rows = []) {
  const holidays = new Map();
  const leave = new Map();
  for (const r of rows) {
    if (r.kind === "holiday") holidays.set(r.day, r.title);
    else leave.set(`${r.user_id}|${r.day}`, r.portion);
  }
  return { holidays, leave };
}

export function workedOn(index, userId, day) {
  if (isSunday(day) || index.holidays.has(day)) return 0;
  const portion = index.leave.get(`${userId}|${day}`);
  return portion === "full" ? 0 : portion === "half" ? 0.5 : 1;
}

export function workingDays(index, userIds, from, to, today = istDate()) {
  const end = to < today ? to : today;
  const byUser = new Map(userIds.map((id) => [id, { working: 0, off: 0 }]));
  for (let d = from; d <= end; d = addDays(d, 1)) {
    if (isSunday(d)) continue;
    for (const id of userIds) {
      const w = workedOn(index, id, d);
      const slot = byUser.get(id);
      slot.working += w;
      slot.off += 1 - w;
    }
  }
  const total = { working: 0, off: 0 };
  for (const v of byUser.values()) {
    total.working += v.working;
    total.off += v.off;
  }
  return { byUser, total };
}

export const perWorkingDay = (visits, working) =>
  working > 0 ? Math.round((visits / working) * 10) / 10 : null;
