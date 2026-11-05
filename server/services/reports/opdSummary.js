import pool from "../../config/db.js";
import { LAB_ONLY_DOCTOR } from "../../../shared/labOnly.js";
import { OPD_BUCKETS, OPD_TYPE_SETS } from "../../../shared/opdSummary.js";
import { TEST_FILE_PREFIX } from "../../../shared/opdMetrics.js";
import { journeyTimesFor } from "../giniflow/reports.js";

export const VISIT_ROW_CAP = 20000;
const PHONE_SEARCH_MIN_DIGITS = 4;

const SORTS = {
  date_desc: "day DESC, time_slot DESC NULLS LAST, id DESC",
  date_asc: "day ASC, time_slot ASC NULLS LAST, id ASC",
  patient_asc: "lower(patient_name) ASC NULLS LAST, day DESC, id DESC",
  patient_desc: "lower(patient_name) DESC NULLS LAST, day DESC, id DESC",
  doctor_asc: "lower(doctor) ASC, day DESC, id DESC",
  doctor_desc: "lower(doctor) DESC, day DESC, id DESC",
};

const STATES = {
  came: ["attended", "not_closed"],
  repeat: ["attended", "not_closed"],
  not_closed: ["not_closed"],
  no_show: ["no_show"],
  cancelled: ["cancelled"],
  not_updated: ["not_updated"],
  booked: ["booked"],
};

const SLOT_H = "split_part(btrim(a.time_slot), ':', 1)::int";

const SLOT_HOUR = `CASE WHEN a.time_slot ~ '^\\s*[0-9]{1,2}:[0-9]{2}' THEN
    CASE
      WHEN a.time_slot ~* '^\\s*[0-9]{1,2}:[0-9]{2}\\s*p\\.?m' THEN mod(${SLOT_H}, 12) + 12
      WHEN a.time_slot ~* '^\\s*[0-9]{1,2}:[0-9]{2}\\s*a\\.?m' THEN mod(${SLOT_H}, 12)
      WHEN ${SLOT_H} < 24 THEN ${SLOT_H}
    END
  END`;

const REBOOKED_CANCEL = `
  lower(COALESCE(a.status, '')) = 'cancelled'
  AND NULLIF(btrim(a.file_no), '') IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM appointments live
     WHERE live.file_no = a.file_no
       AND live.appointment_date = a.appointment_date
       AND live.id <> a.id
       AND lower(COALESCE(live.status, '')) NOT IN ('cancelled', 'lead')
  )`;

export const BASE = `
  WITH today AS (SELECT (NOW() AT TIME ZONE 'Asia/Kolkata')::date AS d),
  raw AS (
    SELECT a.id, a.appointment_date AS day, a.time_slot, a.patient_id, a.patient_name,
           a.file_no, a.phone, p.health_id, a.visit_type, a.status,
           COALESCE(NULLIF(btrim(a.doctor_name), ''), 'Unassigned') AS doctor,
           COALESCE('P' || a.patient_id, 'F' || NULLIF(btrim(a.file_no), ''), 'A' || a.id) AS person,
           CASE
             WHEN lower(btrim(COALESCE(a.doctor_name, ''))) = lower($3)
               OR lower(btrim(COALESCE(a.visit_type, ''))) = 'investigation' THEN 'lab_only'
             WHEN lower(COALESCE(a.visit_type, '')) LIKE '%tele%'
               OR lower(btrim(COALESCE(a.appointment_type, ''))) IN ('online', 'tele') THEN 'tele'
             WHEN a.visit_type = 'New Patient' THEN 'new'
             WHEN a.visit_type = 'Follow-Up' THEN 'follow_up'
             ELSE 'other'
           END AS bucket,
           CASE
             WHEN lower(a.status) IN ('completed', 'seen') THEN 'attended'
             WHEN lower(a.status) IN ('checkedin', 'in_visit', 'in-progress') THEN 'not_closed'
             WHEN lower(a.status) = 'no_show' THEN 'no_show'
             WHEN lower(a.status) = 'cancelled' THEN 'cancelled'
             WHEN a.appointment_date >= (SELECT d FROM today) THEN 'booked'
             ELSE 'not_updated'
           END AS state,
           ${SLOT_HOUR} AS slot_hour
      FROM appointments a
      LEFT JOIN patients p ON p.id = a.patient_id
     WHERE a.appointment_date BETWEEN $1 AND $2
       AND lower(COALESCE(a.status, '')) <> 'lead'
       AND NOT COALESCE(p.is_blocked, false)
       AND COALESCE(a.file_no, '') NOT LIKE '${TEST_FILE_PREFIX}%'
       AND NOT (${REBOOKED_CANCEL})
  ),
  base AS (
    SELECT *, state IN ('attended', 'not_closed') AS came FROM raw
     WHERE ($4::text[] IS NULL OR doctor = ANY($4))
  )`;

export function monthRange(month) {
  const [year, mon] = month.split("-").map(Number);
  const last = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
}

export function previousMonth(month) {
  const [year, mon] = month.split("-").map(Number);
  const prev = new Date(Date.UTC(year, mon - 2, 1));
  return `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, "0")}`;
}

export const typesFor = (type) => OPD_TYPE_SETS[type] || OPD_TYPE_SETS.opd;

export const doctorList = (doctor) => {
  const list = (Array.isArray(doctor) ? doctor : [doctor]).filter(Boolean);
  return list.length ? list : null;
};

const n = (value) => Number(value) || 0;

const SUMMARY_SQL = `${BASE}
  SELECT GROUPING(day) AS g_day, GROUPING(doctor) AS g_doctor, day::text AS day, doctor,
         count(*) FILTER (WHERE came AND bucket = ANY($5)) AS attended,
         count(DISTINCT person) FILTER (WHERE came AND bucket = ANY($5)) AS unique_patients,
         count(*) FILTER (WHERE state = 'not_closed' AND bucket = ANY($5)) AS not_closed,
         count(*) FILTER (WHERE came AND bucket = 'new') AS new,
         count(*) FILTER (WHERE came AND bucket = 'follow_up') AS follow_up,
         count(*) FILTER (WHERE came AND bucket = 'other') AS other,
         count(*) FILTER (WHERE came AND bucket = 'tele') AS tele,
         count(*) FILTER (WHERE came AND bucket = 'lab_only') AS lab_only,
         count(*) FILTER (WHERE state = 'no_show' AND bucket = ANY($5)) AS no_show,
         count(*) FILTER (WHERE state = 'cancelled' AND bucket = ANY($5)) AS cancelled,
         count(*) FILTER (WHERE state = 'not_updated' AND bucket = ANY($5)) AS not_updated,
         count(*) FILTER (WHERE state = 'booked' AND bucket = ANY($5)) AS booked
    FROM base
   GROUP BY GROUPING SETS ((), (day), (doctor))`;

const REPEAT_PEOPLE = `
  SELECT person FROM base WHERE came AND bucket = ANY($5) GROUP BY person HAVING count(*) > 1`;

const REPEAT_SQL = `${BASE} SELECT count(*) AS repeat_patients FROM (${REPEAT_PEOPLE}) r`;

const PREVIOUS_SQL = `${BASE}
  SELECT count(*) FILTER (WHERE came AND bucket = ANY($5)) AS attended,
         count(DISTINCT person) FILTER (WHERE came AND bucket = ANY($5)) AS unique_patients
    FROM base`;

const counts = (r) => ({
  attended: n(r.attended),
  uniquePatients: n(r.unique_patients),
  notClosed: n(r.not_closed),
  new: n(r.new),
  followUp: n(r.follow_up),
  other: n(r.other),
  tele: n(r.tele),
  labOnly: n(r.lab_only),
  noShow: n(r.no_show),
  cancelled: n(r.cancelled),
  notUpdated: n(r.not_updated),
  booked: n(r.booked),
});

const totals = (row, repeatPatients) => {
  const c = counts(row || {});
  return { ...c, repeatPatients, repeatVisits: c.attended - c.uniquePatients };
};

const hasActivity = (c) => Object.values(c).some((v) => v > 0);

export async function getOpdSummary({ month, doctor = null, type = "opd" }, db = pool) {
  const { from, to } = monthRange(month);
  const types = typesFor(type);
  const params = (range) => [range.from, range.to, LAB_ONLY_DOCTOR, doctorList(doctor), types];
  const [current, repeat, previous, today] = await Promise.all([
    db.query(SUMMARY_SQL, params({ from, to })),
    db.query(REPEAT_SQL, params({ from, to })),
    db.query(PREVIOUS_SQL, params(monthRange(previousMonth(month)))),
    db.query(`SELECT (NOW() AT TIME ZONE 'Asia/Kolkata')::date::text AS d`),
  ]);
  const todayIso = today.rows[0].d;
  const totalsRow = current.rows.find((r) => r.g_day === 1 && r.g_doctor === 1);
  const byDay = current.rows
    .filter((r) => r.g_day === 0 && r.day <= todayIso)
    .map((r) => ({ day: r.day, ...counts(r) }))
    .filter((r) => hasActivity(r))
    .sort((a, b) => a.day.localeCompare(b.day));
  const byDoctor = current.rows
    .filter((r) => r.g_doctor === 0)
    .map((r) => ({ doctor: r.doctor, ...counts(r) }))
    .filter((r) => r.attended > 0 || r.noShow > 0 || r.notClosed > 0)
    .sort((a, b) => b.attended - a.attended || a.doctor.localeCompare(b.doctor));
  return {
    month,
    from,
    to,
    today: todayIso,
    isCurrentMonth: todayIso >= from && todayIso <= to,
    doctor,
    type,
    totals: totals(totalsRow, n(repeat.rows[0]?.repeat_patients)),
    byDay,
    byDoctor,
    previousMonth: {
      month: previousMonth(month),
      attended: n(previous.rows[0]?.attended),
      uniquePatients: n(previous.rows[0]?.unique_patients),
    },
  };
}

export const DASHBOARD_STATE_SQL = {
  booked: "TRUE",
  came: "came",
  completed: "state = 'attended'",
  in_progress: "state = 'not_closed' AND day = (SELECT d FROM today)",
  not_closed: "state = 'not_closed' AND day < (SELECT d FROM today)",
  pending: "state = 'booked'",
  not_updated: "state = 'not_updated'",
  did_not_come: "state IN ('no_show', 'cancelled')",
  no_show: "state = 'no_show'",
  cancelled: "state = 'cancelled'",
};

export const GROUP_START_SQL = {
  day: "day",
  week: "date_trunc('week', day)::date",
  month: "date_trunc('month', day)::date",
};

function visitFilters(filters) {
  const { doctor = null, type = "opd", status = "came", day = null, q = "", state } = filters;
  const { from, to } = filters.from ? filters : monthRange(filters.month);
  const params = [
    from,
    to,
    LAB_ONLY_DOCTOR,
    doctorList(doctor),
    typesFor(type),
    state ? null : STATES[status] || null,
  ];
  const where = ["bucket = ANY($5)", "($6::text[] IS NULL OR state = ANY($6))"];
  if (state) where.push(`(${DASHBOARD_STATE_SQL[state]})`);
  else if (status === "repeat") where.push(`person IN (${REPEAT_PEOPLE})`);
  const add = (value, sql) => {
    params.push(value);
    where.push(sql(`$${params.length}`));
  };
  if (day) add(day, (p) => `day = ${p}::date`);
  if (filters.weekday) add(filters.weekday, (p) => `extract(isodow FROM day) = ${p}::int`);
  if (filters.hour !== undefined && filters.hour !== null) {
    add(filters.hour, (p) => `slot_hour = ${p}::int`);
  }
  if (filters.group && filters.bucket_start) {
    add(filters.bucket_start, (p) => `${GROUP_START_SQL[filters.group]} = ${p}::date`);
  }
  const term = String(q || "").trim();
  if (term) {
    params.push(`%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    const p = `$${params.length}`;
    const match = [`patient_name ILIKE ${p}`, `file_no ILIKE ${p}`, `health_id ILIKE ${p}`];
    const digits = term.replace(/\D/g, "");
    if (digits.length >= PHONE_SEARCH_MIN_DIGITS) {
      params.push(`%${digits}%`);
      match.push(`regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') LIKE $${params.length}`);
    }
    where.push(`(${match.join(" OR ")})`);
  }
  return { params, where: where.join(" AND ") };
}

const visitRow = (r) => ({
  id: r.id,
  day: r.day,
  timeSlot: r.time_slot,
  patientId: r.patient_id,
  patientName: r.patient_name,
  fileNo: r.file_no,
  healthId: r.health_id,
  doctor: r.doctor,
  visitType: r.visit_type,
  bucket: r.bucket,
  bucketLabel: OPD_BUCKETS[r.bucket],
  state: r.state,
  status: r.status,
});

export async function listOpdVisits(filters, db = pool) {
  const page = filters.page || 1;
  const limit = Math.min(100, filters.limit || 25);
  const { params, where } = visitFilters(filters);
  params.push(limit, (page - 1) * limit);
  const { rows } = await db.query(
    `${BASE}
     SELECT id, day::text AS day, time_slot, patient_id, patient_name, file_no, health_id,
            doctor, visit_type, bucket, state, status, count(*) OVER () AS total
       FROM base
      WHERE ${where}
      ORDER BY ${SORTS[filters.sort] || SORTS.date_desc}
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  const total = rows.length ? n(rows[0].total) : page > 1 ? await countOpdVisits(filters, db) : 0;
  const times = filters.from
    ? await journeyTimesFor(
        rows.map((r) => r.id),
        db,
      )
    : new Map();
  return {
    data: rows.map((r) => ({ ...visitRow(r), ...times.get(Number(r.id)) })),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
}

async function countOpdVisits(filters, db) {
  const { params, where } = visitFilters(filters);
  const { rows } = await db.query(
    `${BASE} SELECT count(*) AS total FROM base WHERE ${where}`,
    params,
  );
  return n(rows[0].total);
}

export async function allOpdVisits(filters, db = pool) {
  const { params, where } = visitFilters(filters);
  params.push(VISIT_ROW_CAP);
  const { rows } = await db.query(
    `${BASE}
     SELECT id, day::text AS day, time_slot, patient_id, patient_name, file_no, health_id,
            doctor, visit_type, bucket, state, status
       FROM base
      WHERE ${where}
      ORDER BY ${SORTS[filters.sort] || SORTS.date_asc}
      LIMIT $${params.length}`,
    params,
  );
  return rows.map(visitRow);
}

export async function getOpdFilters(filters, db = pool) {
  const { from, to } = filters.from ? filters : monthRange(filters.month);
  const { rows } = await db.query(
    `${BASE}
     SELECT doctor, count(*) AS visits FROM base WHERE bucket = ANY($5)
      GROUP BY doctor ORDER BY doctor`,
    [from, to, LAB_ONLY_DOCTOR, null, OPD_TYPE_SETS.all],
  );
  return { doctors: rows.map((r) => ({ name: r.doctor, visits: n(r.visits) })) };
}
