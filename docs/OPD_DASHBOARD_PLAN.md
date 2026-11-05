# OPD Dashboard — Plan

Status: reviewed, decisions taken, awaiting go-ahead · 5 Nov 2026 · no code written yet

**Decided (5 Nov):**

- Counts come from HealthRay appointments (same base as Monthly summary). Gini Flow is used only
  for times.
- New page `/reports/opd-dashboard`; `/opd`, Analytics, Monthly summary and Flow Reports stay.
- Same access as Monthly summary (`OPD_SUMMARY`, checked on the server).
- v1 sections: tiles, trend, type, consultant, funnel and drill-down; waiting and visit length;
  weekday × hour heatmap. Excel download comes later.
- Rebooked cancellations, blocked patients and test data are left out of the shared counting base,
  so the dashboard **and** Monthly summary both drop them and keep agreeing (§3.2).
- "Today" is compared with the same weekday last week; the arrow shows only once the day is over
  (§4.2).

## 1. Goal

One high-level, graphical OPD page that answers "how did OPD do, and how does that compare":
visits by day / week / month, by patient type, by consultant, completed vs still pending vs did
not come, waiting time and visit length — every figure clickable down to the patient list, with
one filter model that the whole page shares.

It follows the build spec reviewed on 5 Nov ("OPD Dashboard Review — Build Spec for Scribe"),
trimmed to what Scribe's data can honestly show today.

## 2. What exists today (explored, not changed)

| Screen                             | Counts from                | Good                                                                                                     | Problem                                                                                              |
| ---------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `/opd` (src/OPD.jsx, 8.4k lines)   | `appointments`, one day    | live day worklist, status KPI row                                                                        | day picked as a **UTC** date (wrong 00:00–05:30 IST); "pending" is a leftover; no range, no charts   |
| `/reports` Analytics               | `consultations`            | biomarker/diagnosis analytics                                                                            | "month" = rolling 30 days on DB date; doctor matched by `ILIKE`; **no server-side capability check** |
| `/reports/monthly` Monthly summary | `appointments`             | IST, URL filters, new/follow-up/tele/lab-only buckets, by day + by doctor, Excel, paginated visits table | one calendar month only; no charts; no times                                                         |
| `/giniflow/reports` Flow Reports   | `giniflow_visits` + events | the only source of waiting / visit length / on-time / station times                                      | filters not in URL; browser dates; floor data only exists for patients the stations actually tracked |
| Reception Arrivals                 | `giniflow_visits`, one day | live boxes and chips                                                                                     | All ≠ sum of boxes (All includes people who left and no-shows; tiles ignore search; chips overlap)   |

Three tables, four definitions of "seen", three day boundaries. The dashboard must not become a
fifth.

## 3. The numbers — one definition each

Single source in code: `shared/opdMetrics.js` (labels, definitions, captions) and the **existing**
`BASE` in `server/services/reports/opdSummary.js`, which the new `opdDashboard.js` imports instead
of copying — so the dashboard and Monthly summary can never disagree.

**Counting base: `appointments`.** HealthRay is the authority for visits and completion and covers
every patient; the Gini Flow floor only covers patients the stations tracked. Gini Flow is used
only for the _time_ metrics, and every time card says how many visits it covers.

### 3.1 States and types

HealthRay statuses as Scribe stores them (`server/services/healthray/mappers.js` `mapStatus`):
`scheduled`, `checkedin`, `in_visit`, `completed`, `cancelled`, `no_show` (plus legacy `seen` /
`in-progress`). The existing `state` and `bucket` columns map them:

| Metric          | Counts                                                                                    | Excludes                                   | Date used              |
| --------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------ | ---------------------- |
| Booked          | appointment rows in the period                                                            | `lead` rows, §3.2 exclusions               | appointment date (IST) |
| Came (visits)   | completed / seen / checkedin / in_visit / in-progress                                     | no-show, cancelled, not updated, booked    | appointment date       |
| Completed       | completed / seen                                                                          | —                                          | appointment date       |
| In progress     | checkedin / in_visit, **today**                                                           | —                                          | appointment date       |
| Not closed      | checkedin / in_visit on an **earlier** day ("Not closed in HealthRay", existing label)    | —                                          | appointment date       |
| Pending         | `scheduled`, date today or later                                                          | past days                                  | appointment date       |
| Not updated     | `scheduled`, date in the past                                                             | —                                          | appointment date       |
| Did not come    | no-show + cancelled                                                                       | cancellations rebooked the same day (§3.2) | appointment date       |
| Unique patients | distinct `person` (patient id → file no → appointment id) among Came                      | —                                          | —                      |
| Repeat patients | people with more than one Came visit in the period                                        | —                                          | —                      |
| Patient type    | existing `bucket`: New · Follow-up · Other OPD · Tele · Lab-only                          | —                                          | —                      |
| Consultant      | `doctor_name` from HealthRay (trimmed, "Unassigned" if blank)                             | —                                          | —                      |
| Booked slot     | `time_slot` (IST "HH:MM", the booked slot; for walk-ins the registration time)            | rows with no slot (count shown)            | slot                   |
| Waiting time    | check-in event → first `with_sd`/`with_doctor` event (Gini Flow)                          | visits with no floor events                | events                 |
| Visit length    | check-in → last `exited`/`dispensed` not followed by `back_for_tests` (Flow Reports rule) | unfinished visits                          | events                 |
| On time         | finished visits with length ≤ their `planned_total_min` ÷ finished visits                 | unfinished                                 | events                 |

A visit is one appointment row: a patient seen by two consultants on one day is two visits and one
unique patient (as Monthly summary counts today).

"Doctor OPD" (the default type) = New + Follow-up + Other OPD; Tele and Lab-only are chosen
explicitly or with "All appointments" — the existing `OPD_TYPE_SETS`.

### 3.2 Exclusions, added to the shared `BASE` (changes Monthly summary too)

- **Cancellation replaced by another booking the same day** — reuse `NOT_REPLACED_CANCEL` from
  `server/services/ghmDayWindow.js` (same file no, same date, a live booking exists). Today these
  inflate Did not come.
- **Blocked patients** — `patients.is_blocked`, the same check `/opd` already uses.
- **Test data** — appointments whose file no starts with `TESTSLOT-` (the slot-capacity test rows in
  production). One named predicate in `shared/opdMetrics.js`, so the rule is visible and testable.

Monthly summary's numbers will drop slightly when this ships; the release note says why.

Day boundary everywhere: **IST**, printed under the page title: "Days are India dates. Visits come
from HealthRay appointments; times come from Gini Flow check-ins."

## 4. Page

Route **`/reports/opd-dashboard`** (lazy via `lazyWithRetry`), nav "📈 OPD dashboard" right after
"📅 Monthly summary", capability `OPD_SUMMARY` in `src/config/routes.js`. Today no role except
admin holds `OPD_SUMMARY`, so v1 is effectively admin-only — same people as Monthly summary.

### 4.1 Filter bar (sticky, everything in the URL)

- Period: Today · Yesterday · This week · Last 7 days · This month · Last month · Last 30 days ·
  Last 12 weeks · Last 12 months · Custom. From/To appear only for Custom; the resolved dates are
  always shown ("Showing 1 Nov – 5 Nov 2026"). Default: This month.
- Group by: Day / Week / Month. Auto: ≤ 31 days → day, ≤ 120 → week, else month; user can
  override, Day capped at 92 buckets. Weeks run Monday–Sunday and are labelled "3–9 Nov" — reuse
  `bucketsOf` / `weekStart` from `server/services/billing/dashboardPeriods.js`.
- Consultant: multi-select (options from the period's appointments), closed state "All
  consultants" / "3 selected"; URL as repeated `doctor=` params (names can contain commas).
- Patient type: Doctor OPD (default) · New · Follow-up · Other OPD · Tele · Lab-only · All
  appointments (`OPD_TYPE_OPTIONS`). It filters everything **except** the type-mix chart, which
  always shows all types and highlights the chosen one.
- Applied filters show as removable chips + **Reset**. Live update (no Apply button).
- Freshness line on the right: "HealthRay synced 10:42", with the existing "sync stopped" warning
  (reuse `useReceptionHealthray`).
- No future dates: the end date can't be after today.

Validation reuses the billing dashboard's `rangeProblem` (moved to a shared helper): bad dates,
end after today, start after end, range over 400 days.

When the range includes today, the page refetches every 60 s; past ranges don't refetch.

### 4.2 KPI tiles (value · comparison · context line · link)

Comparison:

- **Today** → the same weekday last week. Both are full days only once today is over; until then
  the tile shows "Last Thu: 72" as text, with no arrow.
- **Every other period** → the previous equal period, via billing's `previousRange` (whole months
  compare with the months before; otherwise the same number of days before, e.g. 1–5 Nov vs
  27–31 Oct). The tile says which dates it compared with.

| Tile                 | Value                                                                    | Comparison      | Context / click                                     |
| -------------------- | ------------------------------------------------------------------------ | --------------- | --------------------------------------------------- |
| Visits               | Came                                                                     | as above        | "312 unique patients" → visits list (came)          |
| Completed            | Completed                                                                | share of Came   | "8 in progress · 3 not closed" → list (in progress) |
| New patients         | New among Came                                                           | as above        | "28% of visits" → list (new)                        |
| Follow-ups           | Follow-up among Came                                                     | as above        | "41 repeat patients" → list (follow-up)             |
| Did not come         | no-show + cancelled                                                      | share of booked | "12 not updated" → list (did not come)              |
| Pending today        | today's `scheduled` (only when the range includes today, labelled Today) | —               | → reception arrivals                                |
| Average visit length | median minutes (Gini Flow)                                               | as above        | "on time 64% · timed 210 of 312" → Flow Reports     |

A tile never says "Today" unless it is pinned to today (the Pending tile) and says so.

### 4.3 Charts (recharts, existing `SERIES` colours, each card with a one-line hint)

1. **Visit trend** — stacked columns per day/week/month: Completed · In progress / Not closed ·
   Did not come, with a line for the previous period. Click a column → that bucket's list.
2. **Patient type mix** — segmented bar (New · Follow-up · Other OPD · Tele · Lab-only) and a small
   New vs Follow-up share trend. Click a segment → list for that type.
3. **By consultant** — horizontal bars, top 15 + "Others (n)", split Completed / In progress / Did
   not come; value labels; click → list for that consultant. Phone: name above bar.
4. **Status funnel** — Booked → Came → Completed, with Did not come, Not updated and Pending as
   side numbers. Click any step → list.
5. **When patients are booked** — weekday × hour heatmap of booked slots (Came only), labelled
   "by booked slot time"; rows without a slot are counted under the chart. Click a cell → list.
6. **Time on the floor** (Gini Flow) — median waiting and visit length per bucket + on-time %;
   "Where the time goes", planned vs typical per station, from Flow Reports' service. Shows
   coverage ("timed 210 of 312 visits"). Tele and Lab-only are never timed. Below 20 timed visits
   the card says "Too few visits were tracked on the floor to show times" instead of a chart.

Every chart:

- has a hint line (unit, scope, what clicking does), a tooltip with exact numbers, keyboard-focusable
  bars/segments, an `aria-label` summary, and a **"Show as table"** toggle with the same numbers;
- loads and fails on its own: a skeleton while loading, "Couldn't load … · Try again" on error, so
  the times card failing never blanks the counts;
- has an empty state that says what was looked for and over which period, and hides zero
  categories behind a line ("5 consultants with no visits") instead of drawing empty axes.

### 4.4 Drill-down: a sub-page, not a dialog

Clicking any number opens **`/reports/opd-dashboard/visits?…`** with the dashboard's filters plus
the clicked one (state, type, consultant, bucket, weekday/hour), and "← Back to OPD dashboard" that
returns to the same view (same pattern as the Staff & shifts shift page). The page shows what was
clicked as a heading ("Did not come · 1–5 Nov · Dr. Beant Kaur") and a table reusing
`listOpdVisits`:

- columns: Date, Slot, Patient + Health ID, Consultant, Type, Status (with the "Not closed in
  HealthRay" label), Waiting / length where Gini Flow has them;
- search (patient name, file no, phone), pagination (25/50/100), "1–25 of 312", sticky header;
- each row links to the patient page;
- `page` beyond the end is clamped; unknown filter values fall back to All.

### 4.5 Phone / tablet

Tiles 2 per row, then 1 below 520px; charts full width; consultant chart stacks names over bars;
heatmap scrolls inside its card; tables scroll inside their card with the patient column sticky;
no sideways page scroll.

## 5. API

All under `/api/reports/opd`, `requireCapability(OPD_SUMMARY)`, Zod query schemas, IST.

| Endpoint                                   | Returns                                                                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `GET /dashboard?from&to&group&doctor&type` | tiles + comparison range, trend buckets, type mix, consultant rows, funnel, weekday × hour grid, as-of                    |
| `GET /dashboard/times?from&to&doctor&type` | Gini Flow medians per bucket, on-time %, station table, coverage                                                          |
| `GET /visits?...` (existing, extended)     | adds `from/to` (instead of only `month`), repeated `doctor`, `state`, `bucket`, `weekday`, `hour`, `group`+`bucket_start` |

Monthly summary keeps calling `/visits` with `month`; both shapes are accepted.

The times endpoint joins appointments → `giniflow_visits.appointment_id` → events, and applies the
same consultant and type filters through the appointment. It is separate so the slower Gini Flow
query never holds up the counts. Both responses are cached 60 s in memory per filter key; the
cache key includes the IST date so "today" never serves yesterday's numbers after midnight.

## 6. Performance

- `appointments(appointment_date)` index exists → range scans are fine (about 25k rows a year).
- `NOT_REPLACED_CANCEL` is an `EXISTS` on (file no, date); check its plan on the e2e DB with a year
  of fixture rows. If it is slow, propose an index on `appointments(file_no, appointment_date)`
  separately and ask first (prod index builds count as heavy writes).
- Times query joins `giniflow_visit_events` by `visit_id` (indexed). No new index for v1.
- Range capped at 400 days; Group by Day capped at 92 buckets.
- No production queries while building; numbers are checked on the e2e DB. A read-only spot check
  against production (one month's totals vs Monthly summary) only with your OK.

## 7. What we do **not** change in this piece

- `/opd`, Analytics and Flow Reports stay as they are. Monthly summary changes only through the
  shared exclusions (§3.2) and the extended `/visits` filters.
- Reception's counts and columns are not touched.
- No nav restructure (the 56-item strip is a separate project).
- No IPD. No Excel in v1.

## 8. Tests (e2e, local test DB)

- **OD-01 numbers** — a fixture period with completed, checked-in today, checked-in yesterday (not
  closed), scheduled today, scheduled yesterday (not updated), no-show, cancelled, cancelled +
  rebooked same day, blocked patient, `TESTSLOT-` row, new, follow-up, other, tele, lab-only:
  each lands in exactly the right tile, bucket and state; the rebooked cancel, blocked and test
  rows are nowhere; Monthly summary's totals equal the dashboard's for the same month; IST
  boundary at 23:59 / 00:01.
- **OD-02 filters** — day / week (Mon–Sun) / month buckets; previous-period ranges; Today vs same
  weekday last week with no arrow before the day ends; multi consultant; type filter not applied
  to the type-mix chart; validation messages; capability (reception 403, admin 200); cache keyed
  by IST date.
- **OD-03 times** — medians, back-for-tests rule, on-time vs `planned_total_min`, coverage, tele /
  lab-only never timed, "too few" state below 20.
- **OD-04 page** — presets write the URL and survive reload; chips + Reset; each chart click opens
  the visits sub-page with the right heading and rows, and Back restores the view; paging and a
  page past the end; "Show as table" matches the chart; one card's API failing shows its own Try
  again while the rest render; phone width has no sideways scroll; empty range states.
- **Monthly summary regression** — its existing specs still pass after the shared exclusions
  (expected counts updated where a fixture had a rebooked cancel).

## 9. Build order

1. **Numbers** — `shared/opdMetrics.js`, exclusions in the shared `BASE`, `opdDashboard.js`,
   `/dashboard` endpoint, extended `/visits`; OD-01, OD-02, Monthly summary regression.
2. **Page v1** — filter bar, tiles, visit trend, type mix, by consultant, funnel, visits sub-page.
3. **Times** — `/dashboard/times`, time tile and chart, Where the time goes; OD-03.
4. **Heatmap + polish** — weekday × hour, Show as table, phone layout; OD-04.
5. **Later** — Excel export.

Each step builds, passes its tests and is shown to you before the next.

## 10. Follow-ups found while exploring (not in this piece)

- `/opd` picks "today" as a UTC date — wrong between 00:00 and 05:30 IST.
- `/api/reports/*` (Analytics) has no server-side capability check.
- Reception "All" chip ≠ sum of the boxes; "On the floor" includes people who left.
- The New / Follow-up / Walk-in classification is duplicated in four places (reception page,
  receptionStation SQL, flowAppointmentType.js, opdSummary.js).
- One doctor can appear under two HealthRay spellings (e.g. "Dr. Beant Sidhu" / "Dr. Beant Kaur");
  grouping by `doctor_name` shows them as two consultants. A name-alias map is a separate piece.
- The same person can hold two charts (GNI- shell + P_ file), counting as two unique patients.
- PHI: full phone numbers in lists and exports — decide a masking/export-audit rule before
  `OPD_SUMMARY` is granted beyond admin.

## 11. Built so far, and where it differs from the plan

Steps 1 and 2 are built (5 Nov). Tests: `e2e/reports/R03-opd-dashboard-api.spec.js`,
`e2e/reports/R04-opd-dashboard-page.spec.js`; Monthly summary's R01 and R02 still pass.

Differences from the sections above:

- **Live Dashboard tab.** §2 missed `/opd?tab=dashboard` (`src/components/opd/LiveDashboard.jsx`), a
  one-day clinical view. Decision: keep both and link them ("📈 Trends and consultants" on the tab,
  "Today's clinical view" on the dashboard).
- **Rebooked cancellations.** `opdSummary.js` has its own `REBOOKED_CANCEL` rather than GHM's
  `NOT_REPLACED_CANCEL`, because GHM's rule also treats a `lead` row as a rebooking, and it reads
  `booking_status` and `call_status`, which this page's `state` does not use.
- **Range limit** is 366 days (same as billing), not 400.
- **Pending / not updated** is a fifth part of the trend and consultant bars, so a column adds up to
  the patients listed when it is clicked.
- **Filter bar** is not sticky: on a laptop it would cover too much of the page.
- **Chart keyboard use.** Recharts bars are not focusable; keyboard users reach the same lists
  through the links in "Show as table".
- **Sync warning.** The page shows "HealthRay synced HH:MM" but not yet the "sync stopped" warning.

Steps 3 and 4 are built too (5 Nov), tested in `e2e/reports/R05-opd-dashboard-times.spec.js`. More
differences:

- **On time** uses the single journey target in Time budgets (`total_journey`), the rule Flow Reports
  uses, not each visit's `planned_total_min`, so the two pages agree. `giniflow/reports.js` now exports
  its journey and step SQL, and the dashboard reuses them.
- **The tile** is called "Typical visit length" because it shows the median, and it jumps to the Time
  on the floor card rather than to Flow Reports, whose filters are not in its link.
- **Only visits linked to an appointment are timed**, because the counts come from appointments.

Not done: Excel export (later, by decision). Not yet compared with production numbers, and the times
query has not been measured on production. Flow Reports caps its range at 92 days; this page allows
366, so check the speed of a 12-month view.

### Review, 5 Nov

An audit compared every tile, chart and list with answers worked out separately from messy seeded
data (25 consultants, odd statuses and slot formats), at widths from 320 to 1920. Fixed as a result:

- A patient link could open the wrong chart: `/visit?patient=` is ignored in a tab that already has a
  patient open. Patient links on the visits page now open a new tab.
- More than 20 consultants were refused, because the query parser turns a long list into an object.
- The consultant picker ran off the right edge at about 1024px.
- Clicking an empty column opened an empty list; it now does nothing.
- The earlier-period line drew part periods as if whole, and was invisible on a single-day view.
- "Too few visits" looked like a success message; the list on phones had no field labels; list dates
  had no year.

Follow-up: `src/components/opd/OpdRangeReport.jsx` opens `/visit?patient=` in the same tab, so it
carries the same wrong-patient risk.

### Long visit times, 5 Nov

In October 2026, 573 of 1,322 timed doctor visits (43%) had an exit written by the midnight sweep
(`staleVisits.js`), stamped 23:59:59, which doubled the median. Those exits and the wait leading into
them are no longer timed, on the dashboard or in Flow Reports (`NOT_SWEPT` in `giniflow/reports.js`).
Expected for October: about 186 minutes typical and 13% on time, 749 visits timed. The sweep itself
is unchanged. On-time stays at the single 90-minute target by decision.

### Second review, 5 Nov

Step-by-step browser checks (97) and a sweep of four views at 12 widths (252) pass on seeded data.
Fixed: Reset over the type box; Refresh with no feedback and served from cache; unapplied picker ticks
kept after closing; small phone tap targets; wording. The list's table header does not stay fixed on
scroll, because the table scrolls inside its own box. Blank pages seen in test runs came from
`ERR_NETWORK_CHANGED` on this machine during module loading, not from the dashboard.
