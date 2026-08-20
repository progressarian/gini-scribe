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
// (healthray_follow_up.date). The last one is AI-extracted and dirty (can hold
// "4 weeks", "today", "09/10/2025", "null", …), so it is ONLY cast when it is a
// clean YYYY-MM-DD — an unguarded ::date would throw and break the whole query.
export const ownFu = (a) => `COALESCE(
  ${a}.follow_up_date,
  NULLIF(${a}.biomarkers->>'followup', '')::date,
  CASE WHEN ${a}.healthray_follow_up->>'date' ~ '^\\d{4}-\\d{2}-\\d{2}$'
       THEN (${a}.healthray_follow_up->>'date')::date END
)`;

// Everyone the day's list covers: booked that date, asked for that date, or
// due a follow-up on it. The two extra clauses keep one row per patient —
// only their latest follow-up-bearing visit counts, and a patient who already
// holds a booking that day is not also listed via their old visit.
export const dayWindowWhere = (a = "a") => `WHERE (
    ${a}.appointment_date = $1 OR ${a}.preferred_date = $1 OR ${ownFu(a)} = $1
  )
  AND (
    ${a}.appointment_date = $1
    OR ${a}.preferred_date = $1
    OR ${a}.file_no IS NULL
    OR ${a}.appointment_date = (
      SELECT MAX(prev.appointment_date)
      FROM appointments prev
      WHERE prev.file_no = ${a}.file_no
        AND ${ownFu("prev")} IS NOT NULL
    )
  )
  AND (
    ${a}.appointment_date = $1
    OR ${a}.preferred_date = $1
    OR ${a}.file_no IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM appointments booked
      WHERE booked.file_no = ${a}.file_no
        AND (booked.appointment_date = $1 OR booked.preferred_date = $1)
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
