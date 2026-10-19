import { LAB_ONLY_DOCTOR } from "../../shared/labOnly.js";

export const ownFu = (a) => `skip_sunday(COALESCE(
  ${a}.follow_up_date,
  NULLIF(${a}.biomarkers->>'followup', '')::date,
  CASE WHEN ${a}.healthray_follow_up->>'date' ~ '^\\d{4}-\\d{2}-\\d{2}$'
       THEN (${a}.healthray_follow_up->>'date')::date END,
  CASE WHEN ${a}.appointment_date IS NOT NULL
        AND btrim(lower(${a}.healthray_follow_up->>'timing')) ~ '^[0-9]{1,2} *(day|week|month|year)s?$'
       THEN (${a}.appointment_date
             + btrim(lower(${a}.healthray_follow_up->>'timing'))::interval)::date END
))`;

export const borrowedFollowUp = (a) => `(
  COALESCE(${a}.status, '') NOT IN ('seen', 'completed', 'in_visit', 'in-progress')
  AND (
    ${a}.healthray_clinical_notes IS NULL
    OR EXISTS (
      SELECT 1 FROM appointments earlier
       WHERE earlier.patient_id = ${a}.patient_id
         AND earlier.appointment_date < ${a}.appointment_date
         AND earlier.healthray_clinical_notes = ${a}.healthray_clinical_notes
    )
  )
)`;

export const isLatestFollowUpVisit = (a) => `(${a}.appointment_date = (
  SELECT MAX(prev.appointment_date)
    FROM appointments prev
   WHERE prev.file_no = ${a}.file_no
     AND prev.own_follow_up_date IS NOT NULL
     AND NOT ${borrowedFollowUp("prev")}
)
AND NOT EXISTS (
  SELECT 1 FROM appointments later
   WHERE later.file_no = ${a}.file_no
     AND later.appointment_date > ${a}.appointment_date
     AND later.status IN ('seen', 'completed')
))`;

export const preferredSetAt = (a) => `COALESCE(
  (SELECT MAX(l.changed_at) FROM appointment_change_log l
    WHERE l.appointment_id = ${a}.id AND l.field = 'preferred_date'),
  ${a}.updated_at
)`;

export const preferredSetBy = (
  a,
  column = "changed_by",
) => `(SELECT l.${column} FROM appointment_change_log l
  WHERE l.appointment_id = ${a}.id AND l.field = 'preferred_date' AND l.new_value IS NOT NULL
  ORDER BY l.changed_at DESC LIMIT 1)`;

export const bookedAt = (b) => `COALESCE(
  (SELECT MAX(bl.changed_at) FROM appointment_change_log bl
    WHERE bl.appointment_id = ${b}.id AND bl.field = 'booking_created'),
  ${b}.created_at
)`;

export const preferredSuperseded = (a) => `EXISTS (
  SELECT 1 FROM appointments nb
   WHERE nb.file_no = ${a}.file_no
     AND nb.id <> ${a}.id
     AND nb.appointment_date IS DISTINCT FROM ${a}.preferred_date
     AND COALESCE(nb.status, '') <> 'cancelled'
     AND COALESCE(nb.booking_status, '') <> 'cancelled'
     AND ${NOT_LAB_ONLY("nb")}
     AND ${bookedAt("nb")} > ${preferredSetAt(a)}
)`;

const livePlanRow = (o) => `COALESCE(${o}.status, '') <> 'cancelled'
  AND COALESCE(${o}.booking_status, '') <> 'cancelled'
  AND ${NOT_LAB_ONLY(o)}`;

const laterPlanRow = (a, o) => `${o}.file_no = ${a}.file_no
  AND ${o}.id <> ${a}.id
  AND ${o}.appointment_date > ${a}.appointment_date
  AND ${livePlanRow(o)}`;

const bookingSlot = (o) =>
  `COALESCE(NULLIF(TRIM(${o}.time_slot), ''), NULLIF(TRIM(${o}.reporting_time_slot), ''))`;

const bookingPlan = (o) => `${o}.appointment_date, ${bookingSlot(o)}, ${o}.doctor_name,
           ${o}.booked_by_name,
           (SELECT bl.changed_by_id FROM appointment_change_log bl
             WHERE bl.appointment_id = ${o}.id AND bl.field = 'booking_created'
             ORDER BY bl.changed_at DESC LIMIT 1),
           ${bookedAt(o)},
           (${o}.appointment_date < ${IST_TODAY} OR COALESCE(${o}.status, '') = 'no_show')`;

export const latestPlanJoin = (a = "a") => `LEFT JOIN LATERAL (
  SELECT TRUE AS found, plan.* FROM (
    SELECT ${a}.preferred_date AS date, ${a}.preferred_time_slot AS time_slot,
           ${a}.preferred_doctor AS doctor, ${preferredSetBy(a)} AS set_by,
           ${preferredSetBy(a, "changed_by_id")} AS set_by_id, ${preferredSetAt(a)} AS set_at,
           FALSE AS stale
     WHERE ${a}.preferred_date IS NOT NULL
    UNION ALL
    SELECT ${bookingPlan(a)}
     WHERE ${livePlanRow(a)}
       AND COALESCE(${a}.status, '') NOT IN ('seen', 'completed', 'in_visit', 'in-progress', 'checkedin', 'checked_in')
       AND ${bookingSlot(a)} IS NOT NULL
    UNION ALL
    SELECT ${bookingPlan("o")}
      FROM appointments o
     WHERE ${laterPlanRow(a, "o")} AND ${bookingSlot("o")} IS NOT NULL
    UNION ALL
    SELECT o.preferred_date, o.preferred_time_slot, o.preferred_doctor, ${preferredSetBy("o")},
           ${preferredSetBy("o", "changed_by_id")}, ${preferredSetAt("o")},
           o.preferred_date < ${IST_TODAY}
      FROM appointments o
     WHERE ${laterPlanRow(a, "o")} AND o.preferred_date IS NOT NULL
  ) plan
  ORDER BY plan.set_at DESC NULLS LAST
  LIMIT 1
) lp ON TRUE`;

export const latestPlan = (field, a = "a") =>
  `(CASE WHEN lp.found THEN (CASE WHEN lp.stale THEN NULL ELSE lp.${field} END) ELSE ${a}.preferred_${field} END)`;

export const livePreferredOn = (a, d) =>
  `(CASE WHEN ${a}.preferred_date = ${d} THEN NOT ${preferredSuperseded(a)} ELSE FALSE END)`;

export const dayWindowWhere = (a = "a") => `WHERE (
    ${a}.appointment_date = $1 OR ${a}.preferred_date = $1 OR ${a}.own_follow_up_date = $1
  )
  AND (
    ${a}.appointment_date = $1 OR ${livePreferredOn(a, "$1")} OR ${a}.own_follow_up_date = $1
  )
  AND (
    ${a}.appointment_date = $1
    OR ${livePreferredOn(a, "$1")}
    OR ${a}.file_no IS NULL
    OR ${isLatestFollowUpVisit(a)}
  )
  AND (
    ${a}.appointment_date = $1
    OR ${a}.file_no IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM appointments booked
      WHERE booked.file_no = ${a}.file_no
        AND booked.appointment_date = $1
    )
  )`;

export const IST_TODAY = `(now() AT TIME ZONE 'Asia/Kolkata')::date`;

export const callStatusToday = (a = "a") =>
  `CASE WHEN ${a}.call_date = ${IST_TODAY}
        THEN COALESCE(NULLIF(${a}.call_status, ''), 'pending')
        ELSE 'pending' END`;

export const NOT_LAB_ONLY = (a) =>
  `LOWER(TRIM(COALESCE(${a}.doctor_name, ''))) <> '${LAB_ONLY_DOCTOR.toLowerCase()}'`;

export const upcomingBookingElsewhere = (a = "a") => `CASE
  WHEN ${a}.file_no IS NOT NULL AND ${a}.appointment_date IS DISTINCT FROM $1 THEN (
    SELECT MIN(b.appointment_date)
      FROM appointments b
     WHERE b.file_no = ${a}.file_no
       AND b.appointment_date <> ${a}.appointment_date
       AND b.appointment_date >= ${IST_TODAY}
       AND b.status NOT IN ('cancelled', 'no_show')
       AND COALESCE(b.booking_status, '') <> 'cancelled'
       AND COALESCE(NULLIF(TRIM(b.time_slot), ''), NULLIF(TRIM(b.reporting_time_slot), '')) IS NOT NULL
       AND ${NOT_LAB_ONLY("b")}
  ) END`;
