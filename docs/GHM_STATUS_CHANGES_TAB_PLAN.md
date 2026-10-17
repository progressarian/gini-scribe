# GHM — "Status Changes" tab (plan, for review — no code yet)

## 1. Purpose

The OBT team sends a WhatsApp message to every patient whose booking changed:
booked, cancelled, rescheduled or could not be reached. Today they find these
patients by scrolling the day lists. The new tab lists **the patients whose booking
changed in a chosen date range**, so the team can:

- pick a date (default **today**) or a range,
- filter by the kind of change (Booked / Cancelled / Rescheduled / Not Connected),
- search a patient,
- export the list (one sheet per kind) for the WhatsApp (WATI) upload.

Tab name: **Status Changes** — after "Missed", before "Patient Lookup".
URL: `/ghm?tab=changes&from=2026-10-17&to=2026-10-17&kind=booked&q=`.

## 2. Decisions (agreed 17 Oct 2026)

1. **HealthRay cancellations are not listed** — only cancellations made by the OBT
   team in GHM. The HealthRay sync is not changed.
2. **Booked = OBT and booking-sheet bookings only.** Bookings made in HealthRay, at
   reception check-in (walk-ins) or on the Appointments page are not listed.
3. **Not Connected = Booking Status "Not Connected" only.** Failed call attempts
   (Not Picked Up, Busy, …) are not listed.
4. **No "WhatsApp sent" tick** for now — the tab is read-only plus export.

## 3. What counts as each change

The source is `appointment_change_log` (who, what, when). The date filter is the day
the change was **made** (IST), not the appointment date.

| Kind | Counted when the log shows |
|---|---|
| **Booked** | a) `booking_created` on a booking made from the GHM sheet (row has `booked_by_name`) or by the booking sheet sync (`source = 'sheets'`); b) Booking Status set to `booked`; c) a preferred **date and time** both set on a row that had no preferred date (the "date + time = booked" rule) |
| **Rescheduled** | Booking Status set to `rescheduled`; Call Status set to `rescheduled`; or the preferred date changed from one date to another |
| **Cancelled** | Booking Status set to `cancelled`; Call Status set to `cancelled` |
| **Not Connected** | Booking Status set to `not_connected` |

Shown with each row: the date and time the patient is now booked for (the same
"latest plan" the Preferred columns use), the previous date for a reschedule, the
doctor, who made the change and when.

Rules:

- **One row per patient per day.** A patient is keyed by UHID (case-insensitive),
  not by appointment — one booking writes log entries on two rows (the sheet sync
  stamps both the follow-up visit and the new booking). If a patient changes
  several times in one day, the row shows the **latest kind** of that day ("3
  changes" on hover). Booked at 10 AM and cancelled at 4 PM = one Cancelled row.
  The patient gets one message, the right one.
- A change **undone the same day** (e.g. Booking Status Booked → back to empty) is
  not listed.
- Only changes made by a logged-in staff member, or by the booking sheet sync, count.
  Automatic changes are left out — the "Visit completed" clean-up that clears a
  booking after the visit, and one-off system fixes (prod check, 17 Oct: 3,650
  "Visit completed" entries since 13 Oct, 97 "System" entries on 7 Oct).
- Lab-only (Hospital Admin) rows and blocked patients are left out, as on the other tabs.
- A row also shows if the booking has changed again on a **later** day (e.g.
  "since cancelled 16 Oct"), so an old row does not mislead.

Not tracked today, so not listed: changing an existing appointment's own date or
time (GHM does not log `appointment_date`/`time_slot` edits — the team reschedules
through the preferred date, which is listed), and changes whose history entry was
deleted with the × in Change History.

## 4. Screen

```
Status Changes
[From 17 Oct] [To 17 Oct] [Today] [Yesterday] [Last 7 days]   [Search name, UHID or phone]
[Doctor ▾] [Changed by ▾]                                        [Export ▾]

(All 42) (Booked 25) (Cancelled 6) (Rescheduled 8) (Not Connected 3)   ← counts follow the filters

Changed at | Patient (name · UHID · phone) | Change | Booked for (date · time) | Was | Doctor | Changed by
```

- Reuses the existing GHM pieces: tab bar, summary pills, `DatePicker`, doctor
  dropdown, search box, `.tbl` table, pagination and the row chevron that opens the
  existing Change History. No new components or colours.
- Labels and colours come from the existing `BOOKING_STATUSES` / `CALL_STATUSES`.
- Date range: max **90 days** (same as Missed), "To" defaults to today and cannot be in the future.
- Empty: "No booking changes on 17 Oct" + Clear filters. Loading: table skeleton.
  Error: "Could not load changes. Try again." with Retry.
- **Phone / tablet:** same as the other GHM tabs — the filter bar wraps onto more
  lines, pills wrap, and the table scrolls sideways with the
  Patient column kept fixed on the left.

## 5. API

`GET /api/ghm-appointments?mode=changes&from=&to=&kind=&q=&doctor=&by=&page=&limit=`

- Same route and permission as the rest of `/ghm` (no new capability).
- New query in `server/services/ghmChanges.js` (route stays thin, like `ghmMissed.js`):
  1. `events` — log rows with `changed_at` between `from 00:00 IST` and `to 24:00 IST`
     (converted to UTC bounds so the index is used), for the fields above, each
     mapped to a kind; joined to its appointment for the UHID and the Booked filters.
  2. `day_latest` — `DISTINCT ON (UPPER(file_no), change_day)` newest first; same-day
     undo dropped (first old value = last new value).
  3. Join `appointments` + `patients`; search / doctor / changed-by / not blocked /
     not lab-only filters; the "latest plan" join for the Booked-for column.
  4. `COUNT(*) FILTER` per kind for the pills, `COUNT(*) OVER ()` for the total,
     `LIMIT/OFFSET` 50 per page, stable order `changed_at DESC, appointment id`.
- Returns `{ data, total, summary: { all, booked, cancelled, rescheduled, not_connected } }`.

## 6. Speed

- `appointment_change_log` is indexed only on `appointment_id`, so a date filter
  would read the whole table. New migration (run with `CONCURRENTLY`; prod only after OK):
  `CREATE INDEX CONCURRENTLY idx_appt_change_status_at ON appointment_change_log (changed_at)
   WHERE field IN ('booking_created','booking_status','call_status','preferred_date','preferred_time_slot');`
- Target: under 300 ms for a 7-day range. Search waits 300 ms after typing;
  the previous page stays on screen while the next one loads.
- Before building, one read-only prod count of log rows per day (with your OK) to
  confirm the 90-day range stays fast.

## 7. Export

- **Export ▾ → "All kinds" or the selected kind**, for the whole filtered range (not
  just the visible page). Pages through the API 100 at a time (existing
  `useExportPages`), max 5,000 rows.
- Workbook: one sheet per kind — **Booked, Cancelled, Rescheduled, Not Connected** —
  built with the existing `buildListSheet` WATI columns (Name, CountryCode, Phone,
  date, time, doctor) plus Changed At and Changed By.
- File name: `ghm-status-changes_2026-10-17.xlsx` (range: `_2026-10-11_to_2026-10-17`).

## 8. Tests (Playwright, test DB — `e2e/ghm/G25-status-changes-tab.spec.js`)

API:
- each kind is listed from its log entry, including preferred date + time = Booked
  and preferred date moved = Rescheduled;
- HealthRay, reception check-in and Appointments-page bookings are not listed;
- the date filter uses the IST day of the change (a change at 00:30 IST counts for that day);
- booked then cancelled the same day = one Cancelled row; same-day undo hidden;
- the sheet sync's two log entries for one booking = one row;
- pills match the rows; search by name / UHID / phone; doctor and changed-by filters;
- pages do not repeat or skip rows; blocked and lab-only left out; range capped at 90 days.

UI:
- tab opens on today; pill click filters; date shortcuts work; export has four sheets
  with the right patients; at phone width the filters wrap and the table scrolls.

## 9. Build order (each step tested before the next)

1. Index migration on the test DB (prod after your OK).
2. `ghmChanges.js` query + API + G25 API tests.
3. Tab UI: filters, pills, search, pagination.
4. Phone / tablet check.
5. Export + its test.
