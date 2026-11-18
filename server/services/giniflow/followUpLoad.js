import pool from "../../config/db.js";
import { IST_TODAY } from "./statusEngine.js";
import { NOT_LAB_ONLY, borrowedFollowUp } from "../ghmDayWindow.js";
import { isClosedDay } from "../../../shared/followUp.js";

const TTL_MS = 30_000;
const MAX_RANGE_DAYS = 62;
const MAX_LIMIT = 10_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ARRIVED = ["seen", "completed", "checkedin", "in_visit", "in-progress"];

const fail = (status, message) => Object.assign(new Error(message), { status });

let cached = null;
let cachedAt = 0;

const shapeLimits = (row) => ({
  allowedPerDay: row?.allowed_per_day ?? null,
  maxPerDay: row?.max_per_day ?? null,
});

async function loadLimits(db) {
  const { rows } = await db
    .query(`SELECT allowed_per_day, max_per_day FROM giniflow_follow_up_limits WHERE id = 1`)
    .catch(() => ({ rows: [] }));
  cached = shapeLimits(rows[0]);
  cachedAt = Date.now();
  return cached;
}

export async function getFollowUpLimits(db = pool) {
  if (cached && Date.now() - cachedAt < TTL_MS) return cached;
  return loadLimits(db);
}

export function clearFollowUpLimitsCache() {
  cachedAt = 0;
}

function limitOf(value, label) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
    throw fail(400, `${label} must be a whole number from 1 to ${MAX_LIMIT}, or left empty.`);
  }
  return n;
}

export async function setFollowUpLimits(
  { allowedPerDay, maxPerDay } = {},
  actorId = null,
  db = pool,
) {
  const allowed = limitOf(allowedPerDay, "Allowed per day");
  const max = limitOf(maxPerDay, "Max per day");
  if (allowed !== null && max !== null && allowed > max) {
    throw fail(400, "Allowed per day can't be more than Max per day.");
  }
  await db.query(
    `INSERT INTO giniflow_follow_up_limits (id, allowed_per_day, max_per_day, updated_at, updated_by)
     VALUES (1, $1, $2, NOW(), $3)
     ON CONFLICT (id) DO UPDATE
        SET allowed_per_day = EXCLUDED.allowed_per_day,
            max_per_day = EXCLUDED.max_per_day,
            updated_at = NOW(),
            updated_by = EXCLUDED.updated_by`,
    [allowed, max, actorId],
  );
  clearFollowUpLimitsCache();
  return loadLimits(db);
}

const LOAD_SQL = `
  WITH dues AS (
    SELECT a.patient_id, a.appointment_date AS set_on, a.own_follow_up_date AS due, 1 AS source_rank
      FROM appointments a
     WHERE a.own_follow_up_date BETWEEN $1::date AND $2::date
       AND a.patient_id IS NOT NULL
       AND a.appointment_date IS NOT NULL
       AND COALESCE(a.status, '') <> 'cancelled'
       AND COALESCE(a.booking_status, '') <> 'cancelled'
       AND ${NOT_LAB_ONLY("a")}
       AND NOT ${borrowedFollowUp("a")}
    UNION ALL
    SELECT v.patient_id, v.visit_date, cp.next_visit_date, 0
      FROM giniflow_care_plans cp
      JOIN giniflow_visits v ON v.id = cp.visit_id
     WHERE cp.next_visit_date BETWEEN $1::date AND $2::date
       AND v.current_status NOT IN ('no_show', 'cancelled')
  ),
  live AS (
    SELECT DISTINCT ON (d.patient_id) d.patient_id, d.due
      FROM dues d
     WHERE d.patient_id IS DISTINCT FROM $3::int
       AND NOT EXISTS (
         SELECT 1 FROM appointments later
          WHERE later.patient_id = d.patient_id
            AND later.appointment_date > d.set_on
            AND later.appointment_date <= ${IST_TODAY}
            AND later.status = ANY($4::text[]))
       AND NOT EXISTS (
         SELECT 1 FROM giniflow_visits later
          WHERE later.patient_id = d.patient_id
            AND later.visit_date > d.set_on
            AND later.visit_date <= ${IST_TODAY}
            AND later.current_status NOT IN ('no_show', 'cancelled'))
     ORDER BY d.patient_id, d.set_on DESC, d.source_rank
  )
  SELECT due::text AS day, count(*)::int AS n FROM live GROUP BY due`;

const addDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const daysBetween = (from, to) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

async function patientOfVisit(db, visitId) {
  if (!visitId) return null;
  if (!/^[0-9a-f-]{36}$/i.test(String(visitId))) throw fail(400, "Unknown visit.");
  const { rows } = await db.query(`SELECT patient_id FROM giniflow_visits WHERE id = $1`, [
    visitId,
  ]);
  return rows[0]?.patient_id ?? null;
}

async function countsBetween(db, from, to, patientId) {
  const { rows } = await db.query(LOAD_SQL, [from, to, patientId, ARRIVED]);
  return Object.fromEntries(rows.map((r) => [r.day, r.n]));
}

export async function followUpLoad({ from, to, visitId } = {}, db = pool) {
  if (!DAY.test(String(from || "")) || !DAY.test(String(to || ""))) {
    throw fail(400, "Choose the dates to show.");
  }
  const span = daysBetween(from, to);
  if (span < 0 || span > MAX_RANGE_DAYS) {
    throw fail(400, `Show at most ${MAX_RANGE_DAYS} days at a time.`);
  }
  const [limits, patientId] = await Promise.all([
    getFollowUpLimits(db),
    patientOfVisit(db, visitId),
  ]);
  return { limits, days: await countsBetween(db, from, to, patientId) };
}

const longDay = (iso) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

async function assertRoom(client, visitId, date) {
  const { maxPerDay } = await getFollowUpLimits(client);
  if (!maxPerDay || !date) return;
  const { rows } = await client.query(
    `SELECT v.patient_id, cp.next_visit_date::text AS saved
       FROM giniflow_visits v
       LEFT JOIN giniflow_care_plans cp ON cp.visit_id = v.id
      WHERE v.id = $1`,
    [visitId],
  );
  if (rows[0]?.saved === date) return;
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('gf-follow-up:' || $1))`, [date]);
  const booked = (await countsBetween(client, date, date, rows[0]?.patient_id ?? null))[date] || 0;
  if (booked >= maxPerDay) {
    throw fail(
      409,
      `${longDay(date)} is full — ${booked} follow-ups already booked (max ${maxPerDay} a day). Choose another date.`,
    );
  }
}

export async function withFollowUpRoom(db, { visitId, date }, write) {
  if (typeof db.connect !== "function" || typeof db.release === "function") {
    await assertRoom(db, visitId, date);
    return write(db);
  }
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await assertRoom(client, visitId, date);
    const result = await write(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function firstDateWithRoom(visitId, startDate, db = pool) {
  const { maxPerDay } = await getFollowUpLimits(db);
  if (!maxPerDay) return startDate;
  const end = addDays(startDate, MAX_RANGE_DAYS);
  const patientId = await patientOfVisit(db, visitId);
  const counts = await countsBetween(db, startDate, end, patientId);
  for (let day = startDate; day <= end; day = addDays(day, 1)) {
    if (!isClosedDay(day) && (counts[day] || 0) < maxPerDay) return day;
  }
  return startDate;
}
