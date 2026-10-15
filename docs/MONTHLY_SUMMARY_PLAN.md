# Monthly Summary (OPD) — Plan

Status: reviewed 2026-10-15 — admin only, headline = doctor OPD only, Excel export now. No code written yet.

## 1. Goal

A new page, **Monthly summary**, that shows how many OPD patients the hospital saw in a month. Management uses it for monthly figures without asking anyone to run queries.

Scope for now: **OPD only**. Scribe has no admissions data (IPD lives only in HealthRay), so IPD is left out. The page is laid out so an IPD section can be added later.

## 2. Definitions (one source of truth, in the service)

All figures come from `appointments` (HealthRay is authoritative and syncs into it).

| Term                    | Rule                                                                                                                                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Attended visit          | `status IN ('completed','seen','checkedin','in_visit')` and `appointment_date <= today`                                                                                                                        |
| Not closed in HealthRay | attended, but status is still `checkedin` / `in_visit` (the known frozen-status issue). Counted as attended and shown separately.                                                                              |
| Unique patients         | distinct `COALESCE(patient_id::text, 'F:' \|\| file_no)` among attended visits                                                                                                                                 |
| Visit type bucket       | checked in this order: **Lab-only** (doctor is "Dr. Hospital Admin" or visit_type "Investigation", reusing `shared/labOnly.js`) → **Tele** → **New** ("New Patient") → **Follow-up** ("Follow-Up") → **Other** |
| No-show                 | `status = 'no_show'`                                                                                                                                                                                           |
| Cancelled               | `status = 'cancelled'`                                                                                                                                                                                         |
| Not updated             | `status = 'scheduled'` on a past date                                                                                                                                                                          |
| Booked ahead            | any non-cancelled appointment dated after today (current month only)                                                                                                                                           |
| Excluded                | `status = 'lead'` (call-sheet rows, not appointments)                                                                                                                                                          |

The buckets are exclusive. This fixes the mismatch in the ad-hoc count.

**Headline = doctor OPD only.** "Visits attended" and "Unique patients" count New + Follow-up + Other. Tele and Lab-only get their own tiles beside the headline and are not added into it. So New + Follow-up + Other = Visits attended, and Visits attended + Tele + Lab-only = all appointments that came. The Visit type filter can still select Tele or Lab-only.

## 3. API (server-side everything)

New files:

- service: `server/services/reports/opdSummary.js`
- routes: `server/routes/opdSummary.js` (mounted flat under `/api`)
- Zod schemas in `server/schemas/index.js`

All endpoints are read-only, use `pool`, and are gated by a capability (see §6).

### 3.1 `GET /api/reports/opd/summary`

Query: `month=YYYY-MM` (default: current month), optional `doctor`, `type`.

One SQL statement that scans the month once through the existing `idx_appointments_date` index and uses `GROUPING SETS ((), (appointment_date), (doctor))`. It returns:

```json
{
  "month": "2026-10",
  "from": "2026-10-01",
  "to": "2026-10-15",
  "isCurrentMonth": true,
  "totals": {
    "attended": 0,
    "uniquePatients": 0,
    "notClosed": 227,
    "new": 198,
    "followUp": 0,
    "tele": 36,
    "labOnly": 113,
    "other": 0,
    "noShow": 128,
    "cancelled": 14,
    "notUpdated": 83,
    "bookedAhead": 99
  },
  "byDay": [
    {
      "day": "2026-10-01",
      "attended": 0,
      "uniquePatients": 0,
      "new": 0,
      "followUp": 0,
      "tele": 0,
      "labOnly": 0,
      "noShow": 0
    }
  ],
  "byDoctor": [
    { "doctor": "Dr. Anil Bhansali", "attended": 0, "uniquePatients": 0, "new": 0, "followUp": 0 }
  ],
  "previousMonth": { "attended": 0, "uniquePatients": 0 }
}
```

`byDay` has at most 31 rows and `byDoctor` a few dozen, so both come in full with the summary. `previousMonth` is a second small aggregate used for the "vs last month" note on the tiles.

### 3.2 `GET /api/reports/opd/visits`

The visit list behind the numbers, paged on the server.

Query:

- `month`, `day?`, `doctor?`, `type?` (bucket), `status?` (attended / not_closed / no_show / cancelled / not_updated);
- `q?` (patient name, UHID, Health ID, phone);
- `sort` (date | patient | doctor, with asc/desc);
- `page` (from 1), `limit` (10/25/50/100, max 100).

Response follows the existing `{ data, total, page, limit, totalPages }` shape (as in `patientBlocks.js`):

- one query uses `count(*) OVER ()`, so there is no second round trip;
- `ORDER BY` uses a whitelist, never raw input;
- search uses `ILIKE` inside the month's date range, which is a few thousand rows at most.

Row fields: date and time, patient name, UHID, Health ID, doctor, bucket, raw visit type, status label. No phone numbers or clinical data in the list.

### 3.3 `GET /api/reports/opd/filters?month=`

Distinct doctors for the month, for the Doctor dropdown. It is small and cached by the client.

### 3.4 `GET /api/reports/opd/export.xlsx`

Takes the same query as `/visits`, minus paging. Builds the workbook with `exceljs`, which the server already uses (see `services/billing/consultantListExport.js`):

- **Summary** sheet: totals, Tele and Lab-only;
- **By day** sheet;
- **By doctor** sheet;
- **Visits** sheet: every row matching the filters, capped at one month.

It streams the file as `OPD-summary-2026-10.xlsx`. The page's Download button uses the current filters and shows "Preparing…" while the file is built.

### 3.5 Speed

- Every query is limited to a month by `appointment_date` and uses `idx_appointments_date`. About 3k rows a month, so the target is under 100 ms.
- A new index is not expected. Before adding one, check `EXPLAIN` on the test DB; on prod only with permission.
- Client: TanStack Query with `staleTime` 60s and `placeholderData: prev`, so changing a page or filter never flashes empty. Search is debounced by 300 ms.

## 4. UI — `/reports/monthly`

Follows the CLAUDE.md UI standards and reuses `Pagination`, `SearchBox`, `Dropdown`, `Shimmer` and the stat-tile and table styling of Flow/Billing Reports. No new library.

```
Monthly summary                                   [‹] [October 2026 ▾] [›]
OPD visits from HealthRay appointments · 1–15 Oct (month in progress)
[Doctor ▾] [Visit type ▾]                                     [Reset filters]

┌Visits attended┐┌Unique patients┐┌New┐┌Follow-up┐┌Tele┐┌Lab-only┐┌No-shows┐
│ (doctor OPD)  ││ …             ││198││  …      ││ 36 ││ 113    ││ 128    │
│ +x vs Sep     ││               │
227 of these are not yet marked completed in HealthRay.

By day (table)                       By doctor (table)
Day | Attended | Unique | New | FU | Tele | Lab-only | No-show
→ clicking a row filters the visit list to that day or doctor

Visits                     [Search by name, UHID, Health ID or phone] [Status ▾]
Date | Patient (name + UHID) | Doctor | Type | Status
…                                    Showing 1–25 of N  [‹ 1 2 3 … ›]
```

Behaviour:

- **Filters live in the URL** (`?month=2026-10&doctor=…&type=…&q=…&page=2`), so reload, back and sharing keep the view. Reset clears them.
- **Month picker:** previous/next arrows plus a select for the last 24 months. Future months are disabled.
- **States:**
  - Shimmer while loading;
  - "No OPD visits in October 2026" with a Reset button when empty;
  - "Couldn't load the summary. Try again" with a button on error;
  - an "updating…" note while refetching in the background.
- **Responsive:**
  - tiles wrap 4/2/1 per row;
  - the two tables stack on narrow screens and scroll sideways;
  - the visit list keeps Date, Patient and Status on mobile, and the rest scrolls.
- **Accessibility:**
  - real `<button>`s and labelled selects;
  - status as text, never colour alone;
  - visible focus.
- **Nav:** "📅 Monthly summary" next to Flow Reports and Billing Reports in `AppLayout.jsx`, lazy-loaded through `lazyWithRetry`.

## 5. Files touched

| File                                                | Change                                                   |
| --------------------------------------------------- | -------------------------------------------------------- |
| `server/services/reports/opdSummary.js`             | new — SQL + bucket rules                                 |
| `server/routes/opdSummary.js`                       | new — 4 GET endpoints (summary, visits, filters, export) |
| `server/services/reports/opdSummaryExport.js`       | new — Excel workbook                                     |
| `server/index.js`                                   | mount route                                              |
| `server/schemas/index.js`                           | query schemas (month, page, limit, sort, q)              |
| `shared/permissions.js`                             | new capability `OPD_SUMMARY` + role grants               |
| `src/config/routes.js`                              | route path + capability                                  |
| `src/router.jsx`                                    | lazy route                                               |
| `src/components/AppLayout.jsx`                      | nav item                                                 |
| `src/queries/hooks/useOpdSummary.js`                | new — query hooks + keys                                 |
| `src/pages/reports/MonthlySummaryPage.jsx` + `.css` | new page                                                 |
| `e2e/reports/R01…`, `R02…`                          | new tests                                                |

No migration and no writes to the database.

## 6. Access

New capability `OPD_SUMMARY`, checked on both the backend (`requireCapability`) and the frontend (`RequireCapability`). Granted to **admin** only (decided). More roles can be added later.

## 7. Testing

All tests run against the e2e Docker DB (`localhost:5435`), never prod.

**R01 — API (`e2e/reports/R01-opd-monthly-summary-api.spec.js`)**. Seed appointments in a fixed test month: each status, each bucket, two doctors, one patient with two visits on the same day, one row dated in the future, one `lead`. Then check:

1. Totals match hand-counted numbers. Buckets add up to attended. Unique patients is less than attended for the repeat patient.
2. Lab-only wins over visit_type (a Hospital Admin "Follow-Up" counts as lab-only).
3. Future rows count only in `bookedAhead`; `lead` rows count nowhere.
4. `byDay` sums equal the totals; `byDoctor` sums equal the totals.
5. Doctor and type filters change both the totals and the list.
6. Visits list:
   - search by name, UHID and Health ID;
   - `total` stays correct when paged;
   - page 2 does not repeat page 1;
   - sort asc/desc;
   - `limit` above 100 is capped.
7. A bad `month`, `page` or `sort` returns 400 with a readable message (no SQL in the response).
8. A role without `OPD_SUMMARY` gets 403.
9. Export: the workbook opens. Its sheets and totals match `/summary`, and its Visits row count matches `/visits` `total` for the same filters.

**R02 — UI (`e2e/reports/R02-monthly-summary-page.spec.js`)**. Logged in as admin:

1. Tiles show the seeded numbers.
2. Month arrows change the URL and the data. The next arrow is disabled on the current month.
3. Typing in search sends one debounced request (checked on the network) and filters the list.
4. Pagination: next page and rows-per-page selection.
5. Clicking a day row filters the list to that day; Reset clears it.
6. Reloading keeps the filters from the URL.
7. Empty month shows the empty state. An API failure (route mocked to 500) shows the retry state.
8. At phone width there is no horizontal page scroll, and the tables scroll inside their own box.
9. A role without access gets no nav item and is blocked at the route.
10. Download button: the file download fires, and its name carries the month.

**Other checks:**

- `npm run format:check`.
- `npm run build`.
- Related existing suites still pass.
- With your permission, one read-only check on prod (`BEGIN READ ONLY`) to confirm 1–15 Oct gives the 1,090 / 889 figures reported earlier.

## 8. Decisions (2026-10-15)

1. Access: admin only.
2. Headline: doctor OPD only. Tele and Lab-only are shown beside it, not included.
3. Export: Excel download now.

## 9. Build order (small steps, each tested before the next)

1. Service + `/summary` endpoint + R01 tests 1–4 and 7–8.
2. `/visits` + `/filters` endpoints + R01 tests 5–6.
3. Capability, route and nav.
4. Page: header, filters, tiles, by-day and by-doctor tables.
5. Visit list with search, sort and pagination + R02.
6. Excel export + R01 test 9 and R02 test 10.
7. Format, build, regression, optional prod read-only check, then report back. No commit until you ask.

## 10. Built — changes from the plan after review (2026-10-15)

- **Statuses:** compared case-insensitively. `in-progress` counts as attended / not closed, the same as `shared/patientLists.js`.
- **Tele:** visit type "Tele", or appointment type "Online" (22 Online Follow-up/New bookings in Oct 2026).
- **By day:** stops at today. Future dates hold only bookings, which are already in "Booked ahead".
- **Tiles:** each bucket says "included above" or "not in visits attended", following the Visit type filter. The Excel Summary sheet uses the same rule.
- **Excel Summary sheet:** records the Visits sheet's status, day and search filters.
- **Phone search:** compares digits only, so `+91 98765-43210` matches `9876543210` (needs at least 4 digits).
- **Day filter:** must be a real calendar date. `2021-06-31` gets a 400 instead of a database error.
- **Phone layout:** the visit list becomes labelled cards (the existing `.bill-stack` pattern). The By day / By doctor tables stay tables and scroll sideways.
- **Tests:** R01 has 10 API tests and R02 has 10 page tests, all on the e2e DB.
- **Prod check (read-only):** 1–15 Oct 2026 = 930 doctor-OPD visits / 818 patients; all types = 1,108 / 904, matching the hand query. One month cold from disk ≈ 0.4 s per query (16.7 s on the very first cold load); warm ≈ 150 ms; uses `idx_appointments_date`.
- **Came more than once (added after review):** patients with two or more attended visits in the month, under the same doctor/type filters, plus their extra visits (visits attended − unique patients). The tile toggles the visit list to `status=repeat`, sorted by patient. The Excel Summary sheet lists both figures. Prod, Sep 2026: 1,737 visits by 1,472 patients; 218 came more than once and made 483 visits between them (265 extra).
