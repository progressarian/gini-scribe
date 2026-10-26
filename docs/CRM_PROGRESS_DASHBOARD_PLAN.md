# CRM progress dashboard — day, week and month reports per rep

Status: **built and tested 2026-10-26** — 13 API tests (C19) and 7 browser tests (C20); the
full CRM suite passes 114 of 114. No migration. Build notes in §14.

## 1. Goal

One **Progress** page in the CRM, `/crm/progress`:

- **Head of growth** (Virender) and **CEO/admin**: progress for **all staff** or **one rep**, for
  a day, a week, a month or any date range, with a trend over time and a per-rep comparison.
- **Growth executives** (Rajesh Sharma, Sandeep Sangroy): the same screen and filters, but always
  **only their own** numbers. The rep filter is not shown, and the server ignores it for them.

It answers four questions:

1. How much field work was done (visits, unique doctors)?
2. How well is each rep's list covered (doctors visited vs not visited, overdue)?
3. What came out of it (outcomes, follow-ups, referrals)?
4. Is it improving (trend, and the same period before)?

## 2. What exists today (from the code)

| Data                      | Table / view                      | Usable for                                                                                                                                                               |
| ------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Visits                    | `crm.visits`                      | Per rep, doctor, day: `executive_id`, `occurred_at`, `visit_type`, `outcome`, `source` (app/sheet), `follow_up_required`, `next_visit_date`. Soft-deleted rows excluded. |
| Who owns which doctor     | `crm.doctor_assignments`          | Current owner (`effective_to IS NULL`) → coverage. History exists but is not used in v1 (§11).                                                                           |
| Visit cadence             | `crm.v_doctor_visit_due`          | Overdue / due / never visited **as of now** (not historical).                                                                                                            |
| Referrals                 | `crm.doctor_referrals`            | `responsible_executive_id`, `referred_at`, `status`, `attribution_status` (claimed/verified).                                                                            |
| Tasks                     | `crm.tasks`                       | `owner_id`, `status`, `due_date`, `completed_at`.                                                                                                                        |
| Revenue                   | `crm.revenue_records`             | Manual entry only, effectively empty today → **not in v1** (§13 Q4).                                                                                                     |
| Targets per rep           | none                              | There is no per-rep target table (`target_volume_per_month` is per doctor × service line).                                                                               |
| India-time period helpers | `server/crm/istPeriods.js`        | IST day / Monday week / month boundaries — reused so the dashboard, home and sheet agree.                                                                                |
| Charts                    | `recharts` (already a dependency) | Used in `MoStationPage`. No new library.                                                                                                                                 |
| Excel                     | `exceljs`                         | For the export.                                                                                                                                                          |

**Access rules already in the database (RLS):** an executive can read visits to doctors they can
access, which includes other reps' visits to their doctors. So the dashboard must filter by
`executive_id` **in the query**, not rely on RLS. Head of growth and CEO/admin see everything.

## 3. Where it lives (D1)

- A separate page **`/crm/progress`**, lazy-loaded through `lazyWithRetry`, capability
  `CRM_ACCESS` (both sides: `src/config/routes.js` and the `/api/crm` prefix in
  `server/middleware/auth.js`, which already covers `/api/crm/progress`).
- **Nav:** a "📈 Progress" tab next to "🤝 CRM" in `AppLayout`, and `/crm/progress` added to the
  growth roles' nav allowlist (`growth_executive`, `growth_manager`, `head_of_growth`), so Rajesh
  and Sandeep get two entries: CRM and Progress.
- **CRM home** gets a "View progress" link in the month bar.
- Filters live in the URL (`/crm/progress?period=week&rep=…`), so a report can be bookmarked or
  shared and survives a refresh. Back arrow returns to CRM home.

## 4. Filters

| Filter         | Options                                                                                                       | Default    |
| -------------- | ------------------------------------------------------------------------------------------------------------- | ---------- |
| Period         | **Today**, **Yesterday**, **This week**, **Last week**, **This month**, **Last month**, **Custom range**      | This month |
| Custom range   | From / To dates (IST). Max 366 days. To ≤ today.                                                              | —          |
| Group trend by | Day / Week / Month — auto-picked from the range (≤ 31 days → day, ≤ 26 weeks → week, else month), changeable  | auto       |
| Staff          | **All staff** or one rep (head of growth / admin only). Lists active growth staff: Virender, Rajesh, Sandeep. | All staff  |
| Territory      | All / one territory (optional narrowing of doctor-based numbers)                                              | All        |

Weeks start Monday, days are India time — the same rules as CRM home and the visit sheet.

## 5. What the screen shows

### 5.1 Headline cards (for the chosen period and staff), each with the change vs the previous equal period

| Card               | Definition                                                                            |
| ------------------ | ------------------------------------------------------------------------------------- |
| Visits             | Visits logged in the period (app + sheet), including Doctor unavailable               |
| Unique doctors     | Distinct doctors visited — stops repeat visits inflating activity (brief §20)         |
| Coverage           | Unique doctors ÷ doctors currently assigned to the rep(s), as a %                     |
| Doctor unavailable | Visits with outcome Doctor unavailable, count and % of visits                         |
| Follow-ups set     | Visits with a next visit date in the period                                           |
| Overdue now        | Assigned doctors currently overdue / never visited (a snapshot, labelled "as of now") |

**Referrals block (D3):**

| Card                 | Definition                                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| Referrals logged     | `referred_at` in the period, by `responsible_executive_id`; **verified** and **claimed** shown apart |
| Reached consultation | Of those, how many are now at Consulted or further along the journey (rank ≥ consulted, not Lost)    |
| Lost                 | Of those, how many are Lost                                                                          |
| Open, untouched      | Referrals of the rep still at New (snapshot, "as of now")                                            |

**Tasks block (D3):**

| Card              | Definition                                                                            |
| ----------------- | ------------------------------------------------------------------------------------- |
| Tasks completed   | `completed_at` in the period, by `owner_id`                                           |
| Completed on time | Of those, completed on or before `due_date` (tasks with no due date count as on time) |
| Overdue now       | Open / in progress with `due_date` before today (snapshot, "as of now")               |

"vs previous period": This week vs last week to the same weekday, This month vs last month to the
same day, custom range vs the same length before it. Shown as "+4 vs last week", never colour alone.

### 5.2 Trend chart

Visits and unique doctors per day / week / month across the range (bars = visits, line = unique
doctors). With "All staff", a toggle splits the visits bars per rep. Hover shows the exact numbers;
a table version sits under the chart for accessibility and printing.

### 5.3 Staff comparison table (head of growth / admin, "All staff" only)

One row per rep plus a team total: Visits · Unique doctors · Assigned · Coverage % · Doctor
unavailable · Follow-ups set · Overdue doctors · Referrals logged (verified) · Tasks completed ·
Tasks overdue · Last visit. Sortable; clicking a rep
sets the Staff filter to that rep.

### 5.4 Breakdowns

- Visits by **type** (in person, phone, WhatsApp…), by **outcome**, by **source** (app vs sheet).
- Visits by **territory / area** of the doctor.
- Compact bar lists, not pies.

### 5.5 Doctor lists (paged, 50 per page, searchable)

- **Visited in this period** — doctor, area, priority, visits in period, last visit, rep, outcome
  of last visit.
- **Not visited in this period** — the assigned doctors with no visit in the range, sorted by
  priority then longest since last visit. This is the action list.

### 5.6 Executive view (Rajesh, Sandeep)

Same cards, trend, breakdowns and doctor lists, scoped to themselves. No staff filter, no
comparison table, no other rep's name or number anywhere.

## 6. Export

**Download report** (Excel) with the current filters: tabs Summary (cards + previous period),
Trend, Staff (head of growth only), Visited doctors, Not visited doctors. Same scoping rules as the
screen.

## 7. API (all under `/api/crm/progress`, capability `CRM_ACCESS`, through `withCrmContext`)

| Endpoint                        | Returns                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------- |
| `GET /crm/progress`             | `{ period, previous, staff_options, cards, previous_cards, trend[], staff[], breakdowns }` |
| `GET /crm/progress/doctors`     | Paged doctor list: `state=visited                                                          | not_visited`, `q`, `page` |
| `GET /crm/progress/export.xlsx` | The Excel report                                                                           |

Query: `period` (preset) **or** `from` + `to` (YYYY-MM-DD), `group` (day/week/month), `rep`
(UUID or `all`), `territory` (UUID).

**Server-side rules (the security boundary):**

- Executive / manager: `rep` is forced to themselves, whatever is sent. A request for another rep's
  id returns their own data, not an error, so nothing leaks through error messages either.
- Head of growth / CEO admin: `rep` must be an active growth staff id or `all`; anything else → 400
  "Choose a staff member from the list".
- Dates validated: real dates, `from ≤ to`, `to ≤ today (IST)`, range ≤ 366 days → else 400 with a
  fix-it message. Unknown preset → default.
- Every query filters `executive_id` / `responsible_executive_id` / `owner_id` explicitly.
- Safe error messages only ("Unable to load progress. Please try again.").

## 8. Server

- `server/crm/progress.js` — `progressReport(crmUser, filters)`, `progressDoctors(...)`,
  `progressWorkbook(...)`, `resolveProgressFilters(crmUser, query)` (the one place that decides
  scope and validates).
- Set-based SQL: one aggregate per block using `generate_series` for the trend buckets (so empty
  days show as 0), `istDayOf` / IST boundaries from `istPeriods.js`.
- Existing indexes cover it (`visits_exec_idx`, `visits_exec_doctor_day_idx`). Data is small
  (tens of visits/day); no caching needed in v1.
- No migration needed.

## 9. Client

- `src/pages/crm/ProgressPage.jsx` (route `/crm/progress`) and `src/components/crm/progress/`: `ProgressFilters.jsx`,
  `ProgressCards.jsx`, `ProgressTrend.jsx` (recharts), `StaffTable.jsx`, `Breakdowns.jsx`,
  `ProgressDoctors.jsx` (reuses `ListToolbar`, `ListPager`).
- TanStack Query not used on CRM home today (plain `api` + state); follow the existing pattern.
- Loading skeletons, empty state ("No visits logged in this period"), error state with Try again.
- Phone: cards two per row, chart full width, staff table scrolls sideways with the rep name column
  fixed, doctor lists as cards.
- Print: the export is the print format; the screen prints cleanly without nav.

## 10. Tests (e2e, local test DB)

`e2e/crm/C19-progress-api.spec.js`

1. Visits/unique/coverage per day, week, month match seeded data, IST boundaries (00:30 IST).
2. Previous-period comparison (this week vs last week to the same weekday).
3. Trend buckets fill empty days with 0; group auto-picks day/week/month.
4. Head of growth: all staff + per rep; staff table totals equal the team cards.
5. Executive: forced to self; passing another rep's id returns own data; no other names in payload.
6. Doctor unavailable, follow-ups, sheet vs app split.
   6b. Referrals: logged / verified / claimed / reached consultation / lost / untouched per rep.
   6c. Tasks: completed, on time, overdue now per rep; another rep's tasks never counted.
7. Not-visited list = assigned minus visited, paged and searchable.
8. Validation: bad dates, from > to, future, > 366 days, unknown rep → 400 with message.
9. Soft-deleted (undone) visits are not counted.
10. Export contains the same numbers; executive export has no Staff tab.

`e2e/crm/C20-progress-ui.spec.js`

1. Progress nav tab and page open for all growth roles and admin; executive sees no staff filter;
   reception and other non-CRM roles get no tab and are sent away from the URL.
2. Changing period / staff updates cards, URL, and survives reload.
3. Clicking a rep in the staff table filters to them.
4. Empty period shows the empty state; API failure shows Try again.
5. 390 px: no sideways page scroll; 1440 px layout.

## 11. Known limits (v1)

- **Coverage uses today's owner.** If a doctor moved from Rajesh to Sandeep mid-month, the month's
  coverage counts them under Sandeep. Visits are always credited to whoever made them.
- **Overdue is a snapshot** of now, not of the chosen past period.
- **Revenue** is not shown (no reliable data yet).

## 12. Build order

1. `resolveProgressFilters` + API + C19 tests.
2. Panel UI + C20 tests.
3. Export.
4. Plan doc → "built and tested", then ask before any commit.

## 13. Decisions (2026-10-26)

| #   | Question  | Answer                                                                  |
| --- | --------- | ----------------------------------------------------------------------- |
| D1  | Placement | Separate page `/crm/progress` with its own nav tab                      |
| D2  | Targets   | Not now — actuals and change vs the previous period only; revisit later |
| D3  | Metrics   | Visits & coverage, Referrals, and Tasks                                 |
| D4  | Revenue   | Left out until revenue comes from billing                               |

## 14. Build notes (2026-10-26)

- **Server:**
  - `server/crm/progress.js` holds the scope and validation (`resolveProgressFilters`), the
    report, the doctor lists and the Excel export.
  - New date helpers in `server/crm/istPeriods.js`: `mondayOf`, `monthStartOf`, `addMonths`,
    `monthEndOf`, `daysBetween`.
  - Routes `/crm/progress`, `/crm/progress/doctors` and `/crm/progress/export.xlsx` are in
    `server/routes/crm.js`.
  - Per-rep and team totals come from one query each (`GROUPING SETS`), so a team's unique doctors
    are never the sum of each rep's.
- **Client:**
  - `src/pages/crm/ProgressPage.jsx` and `src/components/crm/progress/*`.
  - A "📈 Progress" nav tab, a "View progress" link on CRM home, and the growth roles' nav
    allowlist.
  - Styles are the `prg__*` block in `src/styles/crm.css`.
- **Chart:**
  - recharts, one y-axis: visits as bars, unique doctors as a line, both counts.
  - Rep colours use the dataviz reference categorical order. The colour-blind check passes; the
    low-contrast warning is relieved by the legend plus the "Show as table" view.
  - Animation is off.
- **Previous period:**
  - "This week" compares with last week up to the same weekday.
  - "This month" compares with last month up to the same day.
  - A custom range compares with the same number of days just before it.
- **Ties** in the breakdown lists sort alphabetically.

### Review fixes (2026-10-26)

- **Impossible dates no longer crash the report.** A date such as `2026-13-01` used to return a
  500 error; it now returns 400 with "Choose a From and To date".
- **Trend labels carry the year when the range spans two years** ("31 Dec 2025", "1 Jan 2026").
  Before, a forced "By day" over a year repeated labels. Table rows are now keyed by the bucket
  date.
- **The old report is hidden while an error shows,** so the page no longer shows stale numbers
  under an error message. Reset filters brings the report back.
- **New tests cover:**
  - impossible months, repeated query parameters and junk preset, page and search values;
  - a rep's doctor list and export ignoring another rep's id;
  - choosing a custom range;
  - splitting the chart by staff;
  - the table view;
  - the territory filter;
  - recovering from an error.

- **Default period is This month** (changed from This week on request, 2026-10-26).
