import { NOT_LAB_ONLY, latestPlanJoin, latestPlan } from "./ghmDayWindow.js";
import { SHEET_SYNC_ACTOR } from "./appointmentHistory.js";
import { STATUS_CHANGE_KINDS } from "../../shared/statusChanges.js";

export const CHANGES_MAX_DAYS = 90;
const CHANGE_KINDS = STATUS_CHANGE_KINDS.map((k) => k.value);

const STATUS_FIELDS = `('booking_created', 'booking_status', 'call_status', 'preferred_date', 'preferred_time_slot')`;
const ATTENDED = `('seen', 'completed', 'checkedin', 'in_visit', 'in-progress')`;
const istDay = (ts) => `((${ts}) AT TIME ZONE 'Asia/Kolkata')::date`;
const dayStart = (d) => `((${d})::date::timestamp AT TIME ZONE 'Asia/Kolkata')`;

const isoDay = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : null);
const shiftDay = (iso, days) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const istToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

export function changesRange(fromIn, toIn) {
  const today = istToday();
  let to = isoDay(toIn) || today;
  if (to > today) to = today;
  let from = isoDay(fromIn) || to;
  if (from > to) [from, to] = [to, from];
  const floor = shiftDay(to, -(CHANGES_MAX_DAYS - 1));
  if (from < floor) from = floor;
  return { from, to };
}

const pairedOnOrBefore = (l, field) => `EXISTS (
  SELECT 1 FROM appointment_change_log t
   WHERE t.appointment_id = ${l}.appointment_id
     AND t.field = '${field}'
     AND t.new_value IS NOT NULL
     AND ${istDay("t.changed_at")} <= ${istDay(`${l}.changed_at`)}
)`;

const changeKind = (l, a) => `CASE
  WHEN ${l}.field = 'booking_created'
    THEN CASE WHEN ${a}.booked_by_name IS NOT NULL OR ${a}.source = 'sheets' THEN 'booked' END
  WHEN ${l}.field = 'booking_status'
   AND ${l}.new_value IN ('booked', 'cancelled', 'rescheduled', 'not_connected')
    THEN ${l}.new_value
  WHEN ${l}.field = 'call_status' AND ${l}.new_value IN ('cancelled', 'rescheduled')
    THEN ${l}.new_value
  WHEN ${l}.field = 'preferred_date' AND ${l}.new_value IS NOT NULL AND ${l}.old_value IS NOT NULL
   AND ${l}.old_value <> ${l}.new_value
    THEN CASE WHEN EXISTS (
           SELECT 1 FROM appointment_change_log s
            WHERE s.appointment_id = ${l}.appointment_id
              AND s.field = 'preferred_date'
              AND s.old_value IS NULL
              AND s.new_value = ${l}.old_value
              AND ${istDay("s.changed_at")} = ${istDay(`${l}.changed_at`)}
         ) THEN 'booked' ELSE 'rescheduled' END
  WHEN ${l}.field = 'preferred_date' AND ${l}.new_value IS NOT NULL AND ${l}.old_value IS NULL
   AND ${pairedOnOrBefore(l, "preferred_time_slot")}
    THEN 'booked'
  WHEN ${l}.field = 'preferred_time_slot' AND ${l}.new_value IS NOT NULL AND ${l}.old_value IS NULL
   AND ${pairedOnOrBefore(l, "preferred_date")}
    THEN 'booked'
END`;

export async function listStatusChanges(db, { from, to, kind, q, doctor, by, limit, offset }) {
  const params = [from, to];
  const add = (v) => {
    params.push(v);
    return `$${params.length}`;
  };

  let where = "TRUE";
  for (const t of String(q || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6)) {
    const p = add(`%${t}%`);
    where += ` AND (a.patient_name ILIKE ${p} OR a.file_no ILIKE ${p} OR a.phone ILIKE ${p} OR alt_phone_text(a.alt_phone) ILIKE ${p})`;
  }
  if (doctor) {
    const p = add(`%${doctor}%`);
    where += ` AND (a.doctor_name ILIKE ${p} OR a.preferred_doctor ILIKE ${p})`;
  }
  if (by) where += ` AND r.changed_by = ${add(by)}`;
  const kindParam = add(CHANGE_KINDS.includes(kind) ? kind : "");
  const limitParam = add(limit);
  const offsetParam = add(offset);

  const { rows } = await db.query(
    `WITH ev AS MATERIALIZED (
       SELECT l.id, l.appointment_id, l.field, l.old_value, l.new_value, l.changed_at, l.changed_by,
              ${istDay("l.changed_at")} AS day,
              COALESCE(UPPER(NULLIF(TRIM(a.file_no), '')), 'id:' || a.id) AS pkey,
              ${changeKind("l", "a")} AS kind
         FROM appointment_change_log l
         JOIN appointments a ON a.id = l.appointment_id
        WHERE l.field IN ${STATUS_FIELDS}
          AND l.changed_at >= ${dayStart("$1")}
          AND (l.changed_by_id IS NOT NULL OR l.changed_by = '${SHEET_SYNC_ACTOR.name}')
          AND ${NOT_LAB_ONLY("a")}
     ),
     kinded AS MATERIALIZED (
       SELECT ev.* FROM ev
        WHERE ev.kind IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM appointment_change_log u
             WHERE u.appointment_id = ev.appointment_id
               AND u.field = ev.field
               AND u.changed_at > ev.changed_at
               AND ${istDay("u.changed_at")} = ev.day
          )
     ),
     day_counts AS (
       SELECT pkey, day, COUNT(*) AS changes FROM ev
        WHERE kind IS NOT NULL AND day BETWEEN $1::date AND $2::date
        GROUP BY pkey, day
     ),
     day_latest AS MATERIALIZED (
       SELECT DISTINCT ON (k.pkey, k.day) k.*,
              n.changes
         FROM kinded k
         JOIN day_counts n ON n.pkey = k.pkey AND n.day = k.day
        WHERE k.day BETWEEN $1::date AND $2::date
        ORDER BY k.pkey, k.day, k.changed_at DESC, k.id DESC
     ),
     listed AS MATERIALIZED (
       SELECT r.appointment_id AS id, r.pkey, r.day, r.kind, r.field, r.changed_at, r.changed_by,
              r.changes::int AS changes,
              CASE WHEN r.kind = 'rescheduled' AND r.field = 'preferred_date'
                   THEN r.old_value END AS was_date
         FROM day_latest r
         JOIN appointments a ON a.id = r.appointment_id
        WHERE NOT EXISTS (SELECT 1 FROM patients bp WHERE bp.id = a.patient_id AND bp.is_blocked)
          AND ${where}
     ),
     picked AS (
       SELECT * FROM listed WHERE ${kindParam} = '' OR kind = ${kindParam}
     ),
     summary AS (
       SELECT json_build_object(
                'all', COUNT(*),
                'booked', COUNT(*) FILTER (WHERE kind = 'booked'),
                'cancelled', COUNT(*) FILTER (WHERE kind = 'cancelled'),
                'rescheduled', COUNT(*) FILTER (WHERE kind = 'rescheduled'),
                'not_connected', COUNT(*) FILTER (WHERE kind = 'not_connected')
              ) AS summary,
              (SELECT COUNT(*) FROM picked)::int AS total,
              (SELECT COALESCE(json_agg(DISTINCT d.changed_by ORDER BY d.changed_by), '[]'::json)
                 FROM day_latest d WHERE d.changed_by IS NOT NULL) AS actors
         FROM listed
     ),
     page AS (
       SELECT * FROM picked
        ORDER BY changed_at DESC, id DESC
        LIMIT ${limitParam} OFFSET ${offsetParam}
     )
     SELECT s.summary, s.total, s.actors, pg.*
       FROM summary s
       LEFT JOIN LATERAL (
         SELECT r.id, r.kind, r.field, r.changed_at, r.changed_by, r.changes, r.was_date,
                r.day::text AS change_day,
                a.patient_name, a.file_no, a.phone, a.alt_phone, a.age, a.sex,
                a.visit_type, a.appointment_type, a.doctor_name, a.status,
                p.id AS patient_id,
                COALESCE(${latestPlan("date")},
                  CASE WHEN a.status IN ${ATTENDED} THEN a.own_follow_up_date ELSE a.appointment_date END
                )::text AS plan_date,
                CASE WHEN ${latestPlan("date")} IS NOT NULL THEN ${latestPlan("time_slot")}
                     WHEN a.status IN ${ATTENDED} THEN NULL
                     ELSE COALESCE(NULLIF(TRIM(a.time_slot), ''), NULLIF(TRIM(a.reporting_time_slot), ''))
                END AS plan_time,
                COALESCE(${latestPlan("doctor")}, a.doctor_name) AS plan_doctor,
                since.kind AS since_kind, since.day::text AS since_day
           FROM page r
           JOIN appointments a ON a.id = r.id
           LEFT JOIN patients p ON p.file_no = a.file_no
           ${latestPlanJoin("a")}
           LEFT JOIN LATERAL (
             SELECT k.kind, k.day FROM kinded k
              WHERE k.pkey = r.pkey AND k.day > r.day
              ORDER BY k.changed_at DESC, k.id DESC
              LIMIT 1
           ) since ON TRUE
          ORDER BY r.changed_at DESC, r.id DESC
       ) pg ON TRUE`,
    params,
  );

  const head = rows[0] || {};
  return {
    data: rows.filter((r) => r.id != null).map(({ summary, total, actors, ...row }) => row),
    total: head.total || 0,
    summary: head.summary || { all: 0, booked: 0, cancelled: 0, rescheduled: 0, not_connected: 0 },
    actors: head.actors || [],
    range: { from, to },
  };
}
