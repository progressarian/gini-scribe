import {
  IST_TODAY,
  NOT_LAB_ONLY,
  isLatestFollowUpVisit,
  livePreferredOn,
  preferredSetAt,
} from "./ghmDayWindow.js";

export const MISSED_MAX_DAYS = 90;
export const MISSED_GRACE_DAYS = 7;
export const OFTEN_MISSES_AT = 3;
export const REPEATEDLY_MISSES_AT = 5;

const ATTENDED = `('seen', 'completed', 'checkedin', 'in_visit', 'in-progress')`;
const istDay = (ts) => `((${ts}) AT TIME ZONE 'Asia/Kolkata')::date`;

const CALL_SHEET_ROW = (a) =>
  `(COALESCE(${a}.time_slot, '') ~ '^[0-9]{2}\\. ' OR ${istDay(`${a}.created_at`)} > ${a}.appointment_date)`;

const HAS_SLOT = (a) =>
  `COALESCE(NULLIF(TRIM(${a}.time_slot), ''), NULLIF(TRIM(${a}.reporting_time_slot), '')) IS NOT NULL`;

export const personKey = (a) => `CASE
  WHEN length(regexp_replace(COALESCE(${a}.phone, ''), '\\D', '', 'g')) >= 10
   AND NULLIF(TRIM(${a}.patient_name), '') IS NOT NULL
  THEN RIGHT(regexp_replace(${a}.phone, '\\D', '', 'g'), 10) || '|' ||
       regexp_replace(
         regexp_replace(LOWER(${a}.patient_name), '^\\s*(mr|mrs|ms|miss|dr|master|baby)\\.?\\s+', ''),
         '[^a-z]', '', 'g')
END`;

const phone10 = (a) => `RIGHT(regexp_replace(COALESCE(${a}.phone, ''), '\\D', '', 'g'), 10)`;

const samePatient = (r, m) =>
  `(${r}.file_no IN (${m}.file_no, UPPER(${m}.file_no)) OR ${r}.patient_id = ${m}.patient_id)`;

const attendedSince = (m, sinceDay) => `(EXISTS (
  SELECT 1 FROM appointments x
   WHERE ${samePatient("x", m)}
     AND x.appointment_date > ${sinceDay}
     AND x.status IN ${ATTENDED}
     AND ${NOT_LAB_ONLY("x")})
  OR EXISTS (
  SELECT 1 FROM appointments xp
   WHERE ${personKey("xp")} = ${m}.person_key
     AND xp.appointment_date > ${sinceDay}
     AND xp.status IN ${ATTENDED}
     AND ${NOT_LAB_ONLY("xp")})
  OR (${m}.file_no LIKE 'GNI-%' AND length(${m}.phone10) = 10 AND EXISTS (
  SELECT 1 FROM appointments xg
   WHERE xg.phone LIKE '%' || ${m}.phone10
     AND xg.appointment_date > ${sinceDay}
     AND xg.status IN ${ATTENDED}
     AND ${NOT_LAB_ONLY("xg")}))
  OR EXISTS (
  SELECT 1 FROM consultations k
   WHERE k.patient_id = ${m}.patient_id
     AND k.visit_date > ${sinceDay})
  OR EXISTS (
  SELECT 1 FROM giniflow_visits g
   LEFT JOIN appointments ga ON ga.id = g.appointment_id
   WHERE g.patient_id = ${m}.patient_id
     AND g.visit_date > ${sinceDay}
     AND (g.current_status NOT IN ('booked', 'cancelled', 'no_show')
          OR EXISTS (SELECT 1 FROM giniflow_visit_events ge
                      WHERE ge.visit_id = g.id AND ge.status = 'checked_in'))
     AND (ga.id IS NULL OR ${NOT_LAB_ONLY("ga")})))`;

const attendedNear = (fileNo, day, grace) => `EXISTS (
  SELECT 1 FROM appointments x
   WHERE x.file_no = ${fileNo}
     AND x.appointment_date BETWEEN ${day} - ${grace} AND ${day} + ${grace}
     AND x.status IN ${ATTENDED}
     AND ${NOT_LAB_ONLY("x")})`;

const rebooked = (m) => `EXISTS (
  SELECT 1 FROM appointments b
   WHERE ${samePatient("b", m)}
     AND ${NOT_LAB_ONLY("b")}
     AND COALESCE(b.booking_status, '') <> 'cancelled'
     AND ((b.appointment_date >= ${IST_TODAY}
           AND ${HAS_SLOT("b")}
           AND COALESCE(b.status, '') NOT IN ('cancelled', 'no_show'))
          OR b.preferred_date >= ${IST_TODAY}))`;

const followUpAhead = (m) => `EXISTS (
  SELECT 1 FROM appointments f
   WHERE ${samePatient("f", m)}
     AND f.status IN ('seen', 'completed')
     AND f.own_follow_up_date >= ${IST_TODAY}
     AND f.own_follow_up_date > f.appointment_date
     AND ${NOT_LAB_ONLY("f")}
     AND NOT EXISTS (
       SELECT 1 FROM appointments later
        WHERE (later.file_no = f.file_no OR later.patient_id = f.patient_id)
          AND later.appointment_date > f.appointment_date
          AND later.status IN ('seen', 'completed')
          AND ${NOT_LAB_ONLY("later")}))`;

const closedByCall = (m, day) => `EXISTS (
  SELECT 1 FROM appointments cl
   WHERE ${samePatient("cl", m)}
     AND cl.call_date >= ${day}
     AND (cl.call_status = 'not_interested'
          OR (cl.call_status = 'wrong_number'
              AND cardinality(COALESCE(cl.alt_phone, '{}')) = 0)))`;

export const missedCte = (from, to) => `
  missed_due AS MATERIALIZED (
    SELECT a.id, a.file_no, a.patient_id, ${personKey("a")} AS person_key, ${phone10("a")} AS phone10,
           a.appointment_date AS missed_date, 'appointment' AS missed_kind,
           ${istDay("a.created_at")} - 1 AS since_day, 1 AS kind_rank
      FROM appointments a
     WHERE a.appointment_date BETWEEN ${from} AND ${to}
       AND a.file_no IS NOT NULL
       AND COALESCE(a.status, '') NOT IN ${ATTENDED}
       AND NOT ${CALL_SHEET_ROW("a")}
       AND ${NOT_LAB_ONLY("a")}
    UNION ALL
    SELECT a.id, a.file_no, a.patient_id, ${personKey("a")}, ${phone10("a")}, a.preferred_date, 'preferred',
           ${istDay(preferredSetAt("a"))}, 2
      FROM appointments a
     WHERE a.preferred_date BETWEEN ${from} AND ${to}
       AND a.file_no IS NOT NULL
       AND ${NOT_LAB_ONLY("a")}
       AND ${livePreferredOn("a", "a.preferred_date")}
    UNION ALL
    SELECT a.id, a.file_no, a.patient_id, ${personKey("a")}, ${phone10("a")}, a.own_follow_up_date, 'follow_up', a.appointment_date, 3
      FROM appointments a
     WHERE a.own_follow_up_date BETWEEN ${from} AND ${to}
       AND a.own_follow_up_date > a.appointment_date
       AND a.file_no IS NOT NULL
       AND a.status IN ('seen', 'completed')
       AND ${NOT_LAB_ONLY("a")}
       AND ${isLatestFollowUpVisit("a")}
  ),
  missed AS (
    SELECT DISTINCT ON (UPPER(p.file_no)) p.id, p.file_no, p.missed_date, p.missed_kind
      FROM (SELECT DISTINCT ON (COALESCE(m.patient_id::text, m.file_no))
                   m.id, m.file_no, m.missed_date, m.missed_kind, m.kind_rank
              FROM missed_due m
             WHERE m.missed_date < ${IST_TODAY}
               AND NOT ${attendedSince("m", "m.since_day")}
               AND NOT ${rebooked("m")}
               AND NOT ${followUpAhead("m")}
               AND NOT ${closedByCall("m", "m.missed_date")}
             ORDER BY COALESCE(m.patient_id::text, m.file_no), m.missed_date DESC, m.kind_rank) p
     ORDER BY UPPER(p.file_no), p.missed_date DESC, p.kind_rank
  )`;

export const historyCte = () => `
  hist_pts AS (
    SELECT DISTINCT m.file_no AS key, f.file_no
      FROM missed m, unnest(ARRAY[m.file_no, UPPER(m.file_no)]) AS f(file_no)
  ),
  hist_miss_dates AS (
    SELECT hp.key AS file_no, a.appointment_date AS d
      FROM appointments a JOIN hist_pts hp ON hp.file_no = a.file_no
     WHERE a.appointment_date < ${IST_TODAY}
       AND ${NOT_LAB_ONLY("a")}
       AND NOT ${CALL_SHEET_ROW("a")}
       AND COALESCE(a.status, '') NOT IN ${ATTENDED}
       AND COALESCE(a.status, '') <> 'cancelled'
       AND COALESCE(a.booking_status, '') <> 'cancelled'
       AND NOT ${attendedNear("a.file_no", "a.appointment_date", MISSED_GRACE_DAYS)}
    UNION
    SELECT hp.key, a.preferred_date
      FROM appointments a JOIN hist_pts hp ON hp.file_no = a.file_no
     WHERE a.preferred_date < ${IST_TODAY}
       AND NULLIF(TRIM(a.preferred_time_slot), '') IS NOT NULL
       AND ${NOT_LAB_ONLY("a")}
       AND COALESCE(a.booking_status, '') <> 'cancelled'
       AND NOT ${attendedNear("a.file_no", "a.preferred_date", MISSED_GRACE_DAYS)}
    UNION
    SELECT hp.key, a.own_follow_up_date
      FROM appointments a JOIN hist_pts hp ON hp.file_no = a.file_no
     WHERE a.own_follow_up_date < ${IST_TODAY}
       AND a.own_follow_up_date > a.appointment_date
       AND a.status IN ('seen', 'completed')
       AND ${NOT_LAB_ONLY("a")}
       AND NOT EXISTS (
         SELECT 1 FROM appointments x
          WHERE x.file_no = a.file_no
            AND x.appointment_date > a.appointment_date
            AND x.appointment_date <= a.own_follow_up_date + ${MISSED_GRACE_DAYS}
            AND x.status IN ${ATTENDED}
            AND ${NOT_LAB_ONLY("x")})
    UNION
    SELECT m.file_no, m.missed_date
      FROM missed m JOIN appointments a ON a.id = m.id
     WHERE NOT (m.missed_kind = 'appointment'
                AND 'cancelled' IN (COALESCE(a.status, ''), COALESCE(a.booking_status, '')))
  ),
  hist_missed AS (
    SELECT file_no, COUNT(*)::int AS n
      FROM (SELECT file_no, d, LAG(d) OVER (PARTITION BY file_no ORDER BY d) AS prev
              FROM hist_miss_dates) s
     WHERE prev IS NULL OR d - prev > ${MISSED_GRACE_DAYS}
     GROUP BY file_no
  ),
  hist_cancelled AS (
    SELECT hp.key AS file_no, COUNT(DISTINCT a.appointment_date)::int AS n
      FROM appointments a JOIN hist_pts hp ON hp.file_no = a.file_no
     WHERE (a.status = 'cancelled' OR a.booking_status = 'cancelled')
       AND ${NOT_LAB_ONLY("a")}
       AND NOT ${attendedNear("a.file_no", "a.appointment_date", 3)}
     GROUP BY hp.key
  ),
  hist_visits AS (
    SELECT hp.key AS file_no, COUNT(DISTINCT a.appointment_date)::int AS n
      FROM appointments a JOIN hist_pts hp ON hp.file_no = a.file_no
     WHERE a.status IN ('seen', 'completed')
       AND ${NOT_LAB_ONLY("a")}
     GROUP BY hp.key
  ),
  hist_rescheduled AS (
    SELECT hp.key AS file_no, COUNT(DISTINCT ${istDay("l.changed_at")})::int AS n
      FROM appointment_change_log l
      JOIN appointments a ON a.id = l.appointment_id
      JOIN hist_pts hp ON hp.file_no = a.file_no
     WHERE l.field = 'preferred_date'
       AND l.old_value IS NOT NULL AND l.new_value IS NOT NULL
       AND l.old_value <> l.new_value
       AND COALESCE(a.status, '') NOT IN ${ATTENDED}
     GROUP BY hp.key
  ),
  history AS (
    SELECT h.file_no,
           COALESCE(v.n, 0) AS visit_count,
           COALESCE(c.n, 0) AS cancelled_count,
           COALESCE(r.n, 0) AS rescheduled_count,
           COALESCE(m.n, 0) AS missed_count,
           COALESCE(c.n, 0) + COALESCE(m.n, 0) AS miss_total
      FROM (SELECT DISTINCT key AS file_no FROM hist_pts) h
      LEFT JOIN hist_visits v USING (file_no)
      LEFT JOIN hist_cancelled c USING (file_no)
      LEFT JOIN hist_rescheduled r USING (file_no)
      LEFT JOIN hist_missed m USING (file_no)
  )`;

export const RISK_LEVELS = {
  often: `h.miss_total >= ${OFTEN_MISSES_AT}`,
  repeatedly: `h.miss_total >= ${REPEATEDLY_MISSES_AT}`,
};
