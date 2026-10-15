# Clinical Reports (/reports) speed — Plan

Status: draft, awaiting review. No code changed yet.

## 1. What was measured (prod, read-only, 2026-10-15)

| Request                                    | Cold   | Warm  | Response                                                  |
| ------------------------------------------ | ------ | ----- | --------------------------------------------------------- |
| `/api/reports/diagnoses` (every page load) | 24.8 s | 0.9 s | 803 KB, 6,807 diagnosis types. The page shows the top 12. |
| `/api/reports/doctors` (every page load)   | 0.9 s  | —     | 3 KB                                                      |
| `/api/reports/today?period=today`          | 0.9 s  | —     | 0.6 MB                                                    |
| `…period=week`                             | 20.6 s | 1.0 s | 6.8 MB                                                    |
| `…period=month`                            | —      | 3.9 s | **26 MB**                                                 |
| `…period=quarter`                          | —      | 6.3 s | **59 MB** (year / all: larger still)                      |

Causes:

1. **Coupled loading.** `loadReports` waits for all three requests together (`Promise.all`). The dashboard can't appear until Diagnoses (a different tab) finishes, which takes up to 25 s cold.
2. **Payload.** `/reports/today` sends every patient 12 times (inside each of the 11 biomarkers, plus the scorecard), each with diagnoses and `all_bio`. The page then draws every row (drill-down lists and the scorecard), which means thousands of DOM rows for a month.
3. **Per-patient diagnoses subquery.** It runs for every patient in the period, though only the visible rows need it.
4. **Cold reads.** Whole-table reads on a small instance with a limited I/O budget. Warm, the SQL is fine: `visit_date` is a `date` and uses `idx_consultations_date`. Diagnoses runs in 125 ms warm. **Indexes are not the main problem.**

## 2. Changes

### Backend (`server/routes/reports.js` → logic moved into `server/services/reports/clinicalReport.js`)

1. **`GET /api/reports/today`**: returns only the summary — `total`, `by_doctor` and per-biomarker counts (in control / warning / out of control / no data / tested / %). **No patient arrays**, so a few KB at any period.
2. **New `GET /api/reports/today/biomarker/:key`**: the patients behind one biomarker. Paged on the server (`page`, `limit` ≤ 100), filterable by `status` (out / warning / in / no data), searchable (`q`: name / UHID), and worst first, as now. Diagnoses are looked up only for the returned page.
3. **New `GET /api/reports/today/scorecard`**: the Patient Target Scorecard. Paged, searchable and sorted by % targets met (lowest first, as now). Diagnoses are looked up for the page only.
4. **Short server cache.** The per-patient biomarker map for a (period, doctor) pair is built once and kept for 5 minutes, so paging and drill-downs don't rebuild it. Concurrent requests share one build, the same pattern as `routes/analytics.js`.
5. **`GET /api/reports/diagnoses`**: returns the top 12 by default (`?limit=` up to 100) plus `total_types`, cached for 10 minutes.
6. **`GET /api/reports/doctors`**: unchanged SQL, cached for 5 minutes.
7. **One index:** `vitals (patient_id, recorded_at DESC)`. It is used by both vitals lookups (latest and previous weight), which currently sort per patient. It is the only index that clearly helps. The migration uses `CREATE INDEX CONCURRENTLY` and will only be applied to prod with your OK.

### Frontend (`src/pages/ReportsPage.jsx`, `src/stores/reportsStore.js`) — same look, no redesign

1. **Each section loads on its own.** The dashboard summary loads first. Diagnoses and Doctors load when their tab opens (or in the background afterwards). A slow tab never blocks the dashboard.
2. **Biomarker drill-down:** when a card is opened, it fetches page 1 of that biomarker (25 rows) with the existing `Pagination` component and status chips. "+ N with no data" comes from the counts.
3. **Patient scorecard:** paged list (25 per page) with a search box. Same row design and the same click-to-open-patient behaviour.
4. **Loading states** for each section (`Shimmer`), and an error with a retry button per section.

## 3. Expected result

|                       | Now (month)                     | After                                                          |
| --------------------- | ------------------------------- | -------------------------------------------------------------- |
| Dashboard first paint | waits for all 3 requests; 26 MB | 1 request, a few KB                                            |
| Biomarker drill-down  | everything preloaded            | 25 rows per page, about 0.1 s from cache                       |
| Diagnoses tab         | 803 KB on every load            | ~2 KB, cached                                                  |
| Quarter / Year / All  | 59 MB+ (can freeze the browser) | the same few-KB summary; heavy work happens once per 5 minutes |

## 4. Tests (e2e DB only)

**`e2e/reports/R03-clinical-reports-api.spec.js`.** Seed patients with consultations, labs and vitals across in-control, warning, out-of-control and no-data values. Then check:

1. Summary counts per biomarker equal the hand count. The response has no patient arrays.
2. Biomarker list: `total` equals the summary count for each status. Pages don't overlap, worst comes first, and search and `limit` cap work.
3. Scorecard: sorted by % met, paged, and searchable. The diagnoses on rows match the seeded ones.
4. Diagnoses: top 12 and `total_types`; `limit` is capped.
5. The doctor filter and period change the counts. A bad `period`, `page` or `status` gets a 400. A role without ANALYTICS gets a 403.
6. Cache: two calls within 5 minutes build once. A different period builds separately.

**`e2e/reports/R04-clinical-reports-page.spec.js`:**

1. The dashboard shows while the Diagnoses request is held back (mocked as slow).
2. Opening a biomarker shows 25 rows and a pager. Next page works, and the status chip filters.
3. The scorecard pages and its search works. Clicking a patient opens them, as before.
4. The Diagnoses and Doctors tabs load when opened. A failed section shows a retry button.

**Then:**

- `npm run format:check`, `npm run build`, existing tests touching `/reports`.
- On prod, read-only: response sizes and times before and after.
- Apply the vitals index only with your OK.

## 5. Out of scope

The AI Query tab (`/reports/query-data`) and Clinical Intelligence (`/ci`) are not changed.

## 6. Built (2026-10-15)

- **Matches the old code:** checked side by side on prod (week). Per-biomarker counts, by-doctor counts, every drill-down row, the scorecard order and the scorecard diagnoses all match.
- **One deliberate difference:** drill-downs now list out-of-control patients first. The old sort used `order[status] || 3`, which turned out-of-control (0) into 3 and listed those patients last.
- **Prod, after (SELECT-only measurement):**
  - Summary: 2 KB at every period (was 0.6 / 6.8 / 26 / 59 MB).
  - Biomarker page: 6 ms; scorecard page: 0.1–0.6 s (both served from cache).
  - Diagnoses: 1.3 KB (5 ms cached).
- **Still slow:** the first build of a long period — Month 5.5 s, Quarter 9.7 s, Year 21 s cold. Almost all of it is the lab query reading about 96k heap pages for `result`. A covering index `lab_results (patient_id, test_name, test_date DESC) INCLUDE (result)` would make it index-only. It is not applied; it needs your OK.
- **Vitals index:** `migrations/2026-11-28_vitals_patient_recorded_index.sql` (CONCURRENTLY). Applied to the e2e DB only.
- **Tests:** R03 has 6 API tests and R04 has 5 page tests. All 33 report tests pass.
