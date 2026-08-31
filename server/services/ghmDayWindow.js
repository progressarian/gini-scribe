// The set of appointments a given day's calling list covers, as SQL fragments
// shared by the GHM sheet (/api/ghm-appointments) and the OBT dashboard
// (/api/obt-dashboard). The two used to define it separately, so the dashboard
// counted only rows booked on the date while the sheet also listed patients
// whose follow-up fell due — the tiles never matched the list underneath them.
//
// Both fragments assume the date is bound as $1.

// A visit's OWN effective follow-up date, from whichever source has it, in
// priority order: the follow_up_date column → the synced HealthRay appointment
// value (biomarkers.followup) → the date extracted from the prescription
// (healthray_follow_up.date) → the prescription's relative interval
// (healthray_follow_up.timing) counted from the visit date. The last two are
// AI-extracted and dirty (can hold "4 weeks", "today", "09/10/2025", "null", …),
// so each is ONLY cast when it matches its expected shape — an unguarded ::date
// or ::interval would throw and break the whole query.
export const ownFu = (a) => `COALESCE(
  ${a}.follow_up_date,
  NULLIF(${a}.biomarkers->>'followup', '')::date,
  CASE WHEN ${a}.healthray_follow_up->>'date' ~ '^\\d{4}-\\d{2}-\\d{2}$'
       THEN (${a}.healthray_follow_up->>'date')::date END,
  CASE WHEN ${a}.appointment_date IS NOT NULL
        AND btrim(lower(${a}.healthray_follow_up->>'timing')) ~ '^[0-9]{1,2} *(day|week|month|year)s?$'
       THEN (${a}.appointment_date
             + btrim(lower(${a}.healthray_follow_up->>'timing'))::interval)::date END
)`;

// A visit is the patient's CURRENT one for follow-up purposes only if it is
// their latest visit that carries a follow-up at all. Every older visit's
// follow-up was superseded the moment they were seen again — the doctor
// re-planned the next visit at that later consultation. Shared by the day
// window and the search view so the two cannot disagree about which date is
// a patient's real next follow-up.
//
// The MAX() alone was not enough: it only counts visits that CARRY a follow-up,
// and a visit whose follow-up never made it into the row (HealthRay writes
// followup_days at checkout, after the sync's note pass, and the cron only ever
// revisits today) counts for nothing. The patient was seen, the old date is
// dead, and the list still asked the team to ring them. Being seen again is
// itself the supersede — whether or not the new visit's own follow-up was
// captured — so a later seen/completed visit disqualifies this one outright.
export const isLatestFollowUpVisit = (a) => `(${a}.appointment_date = (
  SELECT MAX(prev.appointment_date)
    FROM appointments prev
   WHERE prev.file_no = ${a}.file_no
     AND ${ownFu("prev")} IS NOT NULL
)
AND NOT EXISTS (
  SELECT 1 FROM appointments later
   WHERE later.file_no = ${a}.file_no
     AND later.appointment_date > ${a}.appointment_date
     AND later.status IN ('seen', 'completed')
))`;

// Everyone the day's list covers: booked that date, asked for that date, or
// due a follow-up on it. The two extra clauses keep one row per patient —
// only their latest follow-up-bearing visit counts, and a patient who already
// holds a booking that day is not also listed via their old visit.
//
// A rebooked patient stays on their follow-up day rather than being moved off
// it: the day the doctor asked them back is the fact the callers are working
// from, so hiding it would hide why they are on the list at all. The sheets
// sync stamps preferred_date and booking_status onto that visit when it imports
// an earlier booking, so the row carries both — the day it is due, and the day
// the patient is actually coming.
export const dayWindowWhere = (a = "a") => `WHERE (
    ${a}.appointment_date = $1 OR ${a}.preferred_date = $1 OR ${ownFu(a)} = $1
  )
  AND (
    ${a}.appointment_date = $1
    OR ${a}.preferred_date = $1
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

// The call status FOR TODAY. The team rings each patient in rounds — three days
// before, the day before, then on the day — so a status has to mean "have we
// called them today", not "have we ever called them". call_status/call_date on
// the row hold the last call whatever day it was made, so once set they read
// "Called" forever; scoped here, the status shows on the day of the call and
// every list resets to "Not Called Yet" the next morning, ready for the next
// round. The stored value stays available as call_status_any, and call_date
// still shows when that last call happened.
//
// Anchored to the Indian day, not CURRENT_DATE: the database runs in UTC, so
// between midnight and 05:30 IST its date is still yesterday and every status
// stamped by a browser would silently stop matching.
export const IST_TODAY = `(now() AT TIME ZONE 'Asia/Kolkata')::date`;

export const callStatusToday = (a = "a") =>
  `CASE WHEN ${a}.call_date = ${IST_TODAY}
        THEN COALESCE(NULLIF(${a}.call_status, ''), 'pending')
        ELSE 'pending' END`;

// The patient's nearest still-upcoming appointment on a DIFFERENT date than the
// row being listed. A row reaches a day's list either as a booking on that date
// or because its follow-up falls due then; only the second kind can hide a
// booking the team already made — Rakesh's 3 Sep follow-up says nothing about
// the 1 Sep slot he was given on the phone, so the callers ring him twice.
// Computed only for the follow-up/preferred listings ($1 is the day being
// viewed), and anchored to the Indian day so a booking earlier today still
// counts. Cancellations on either column are not bookings.
export const upcomingBookingElsewhere = (a = "a") => `CASE
  WHEN ${a}.file_no IS NOT NULL AND ${a}.appointment_date IS DISTINCT FROM $1 THEN (
    SELECT MIN(b.appointment_date)
      FROM appointments b
     WHERE b.file_no = ${a}.file_no
       AND b.appointment_date <> ${a}.appointment_date
       AND b.appointment_date >= ${IST_TODAY}
       AND b.status NOT IN ('cancelled', 'no_show')
       AND COALESCE(b.booking_status, '') <> 'cancelled'
  ) END`;
