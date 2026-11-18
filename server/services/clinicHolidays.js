import pool from "../config/db.js";
import { httpError, inTransaction } from "./billing/transaction.js";
import { addDays, daysBetween, istDate } from "../crm/istPeriods.js";
import { isClosedDay } from "../../shared/followUp.js";
import { CLINIC_HOLIDAY_LIMITS } from "../../shared/clinicHolidays.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const shortDay = (day) => {
  const [, m, d] = day.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]}`;
};

export function holidayLimits(today = istDate()) {
  return {
    from: addDays(today, -CLINIC_HOLIDAY_LIMITS.back),
    to: addDays(today, CLINIC_HOLIDAY_LIMITS.ahead),
  };
}

function openDaysIn(from, to) {
  if (to < from) throw httpError(400, "The last day must be on or after the first day.");
  if (daysBetween(from, to) + 1 > CLINIC_HOLIDAY_LIMITS.maxSpan) {
    throw httpError(400, `Choose ${CLINIC_HOLIDAY_LIMITS.maxSpan} days or fewer at a time.`);
  }
  const limits = holidayLimits();
  if (from < limits.from || to > limits.to) {
    throw httpError(
      400,
      `Choose dates between ${shortDay(limits.from)} and ${shortDay(limits.to)}.`,
    );
  }
  const days = [];
  for (let d = from; d <= to; d = addDays(d, 1)) if (!isClosedDay(d)) days.push(d);
  if (!days.length) throw httpError(400, "Pick at least one day that is not a Sunday.");
  return days;
}

async function actAs(client, actor) {
  await client.query(
    `SELECT set_config('app.actor_id', $1, true), set_config('app.actor_name', $2, true)`,
    [actor?.id != null ? String(actor.id) : "", actor?.name ?? ""],
  );
}

export async function listClinicHolidays(db = pool) {
  const limits = holidayLimits();
  const { rows } = await db.query(
    `SELECT h.id, h.holiday_date::text AS day, COALESCE(h.remarks, 'Clinic holiday') AS title,
            COALESCE(d.name, h.created_by) AS added_by, h.created_at,
            (SELECT count(*)::int FROM appointments a
              WHERE a.appointment_date = h.holiday_date
                AND a.status NOT IN ('cancelled', 'no_show')) AS booked
       FROM clinic_holidays h
       LEFT JOIN doctors d ON d.id = h.created_by_id
      WHERE h.holiday_date >= $1::date
      ORDER BY h.holiday_date`,
    [limits.from],
  );
  return { today: istDate(), limits, holidays: rows };
}

export async function addClinicHolidays({ from, to, title }, actor, db = pool) {
  const days = openDaysIn(from, to || from);
  return inTransaction(async (client) => {
    const { rows: taken } = await client.query(
      `SELECT holiday_date::text AS day, remarks FROM clinic_holidays
        WHERE holiday_date = ANY($1::date[]) ORDER BY holiday_date`,
      [days],
    );
    if (taken.length) {
      const list = taken.map((t) => shortDay(t.day)).join(", ");
      const message = `${list} ${taken.length === 1 ? "is" : "are"} already a holiday (${
        taken[0].remarks || "Clinic holiday"
      }).`;
      throw httpError(409, message);
    }
    await actAs(client, actor);
    await client.query(
      `INSERT INTO clinic_holidays (holiday_date, remarks, created_by, created_by_id)
       SELECT d, $2, $3, $4 FROM unnest($1::date[]) d`,
      [days, title, actor?.name ?? null, actor?.id ?? null],
    );
    const { rows } = await client.query(
      `SELECT count(*)::int AS booked FROM appointments
        WHERE appointment_date = ANY($1::date[]) AND status NOT IN ('cancelled', 'no_show')`,
      [days],
    );
    return { days: days.length, booked: rows[0].booked };
  }, db);
}

export async function removeClinicHoliday(id, actor, db = pool) {
  return inTransaction(async (client) => {
    await actAs(client, actor);
    const { rows } = await client.query(
      `DELETE FROM clinic_holidays WHERE id = $1
       RETURNING holiday_date::text AS day, COALESCE(remarks, 'Clinic holiday') AS title`,
      [id],
    );
    if (!rows.length) throw httpError(404, "This holiday was already removed.");
    return rows[0];
  }, db);
}

export async function clinicHolidayOn(day, db = pool) {
  const { rows } = await db.query(
    "SELECT id, holiday_date::text AS day, remarks FROM clinic_holidays WHERE holiday_date = $1",
    [day],
  );
  return rows[0] ?? null;
}
