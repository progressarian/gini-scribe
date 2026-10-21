# CRM home — paging, filters and a desktop list layout

Status: **built and tested 2026-10-21** (e2e/crm/C16-home-lists.spec.js).

Decisions: paging + filters on To visit, Referrals, My doctors and Tasks; desktop keeps the
cards (two-column card grid at ≥1100px) instead of a table; filters are kept per tab while the
page is open (not in the URL).

## 1. What the page does today

`/crm/home` loads everything in one call (`GET /api/crm/home`) and five of its six tabs are
fixed-size or unpaged lists. The layout is the phone card list (`rep__row`) stretched to full width.

| Tab | What loads | Paging | Filters | Problem |
|---|---|---|---|---|
| To visit | top **25** of the due view | none | none | "Showing 25 of 140" and no way to reach the other 115; no overdue / never-visited / priority / territory filter |
| Referrals | first **50** open (separate call) | none | none | open leads past 50 are invisible; no status / urgency filter |
| Today | every visit logged today | none | none | fine in size; no change needed beyond layout |
| My doctors | **every** doctor the user can see (587 for admin) in one payload | none | search + territory chips, client-side | heavy payload, long scroll, territory chips overflow, no priority / due / "needs details" filter |
| Tasks | first **25** open | none | none | tasks past 25 invisible |
| Assignments | server-paged, 50/page | yes | owner, territory, search | already done |

`my_doctors` is also used only to count "assigned" and "need details" in the footer and stats.

## 2. Proposal

### API — one paged endpoint per list (server-side filter, count, 50 per page)

- `GET /api/crm/home` keeps the header, stats and counts only (no lists).
- `GET /api/crm/home/due?state=all|overdue|due|never_visited&priority=&territory=&q=&page=`
- `GET /api/crm/home/doctors?territory=&priority=&due=&incomplete=1&q=&page=`
- `GET /api/crm/referrals?status=&urgency=&q=&page=` (summary stays)
- `GET /api/crm/home/tasks?status=open|in_progress|overdue&page=`
- Response shape matches Assignments: `{ rows, page, pages, total, counts }`.
- All through `withCrmContext`, so RLS still decides who sees which doctors (executives: own only).

### UI

- One shared toolbar per tab: search (debounced, placeholder says what it searches), filter
  selects, active-filter "Clear", count `N doctors`.
- Filter chips with counts where they drive work (To visit: Overdue 40 · Due 60 · Never visited 40).
- Shared pager (Previous · Page x of y · Next), same as Assignments; extract it from
  `AssignmentsPanel` into one component and reuse.
- Desktop (≥ 900px): rows become a compact table — Doctor · Specialty · Area/Territory ·
  Priority · Due / last visit · actions (Call, Referral, Log visit). Phone keeps today's cards.
- Loading skeleton, empty state that names the active filter + "Clear filters", error with "Try again".
- Selected tab and filters kept in the URL (`?tab=doctors&territory=Mohali&page=2`) so refresh and
  back work.
- Territory bulk priority ("Set all N in Mohali to A/B/C") stays on My doctors, using the server total.

### Not changing
Visit logging, referral status control, offline queue, Assignments tab, permissions.

## 3. Tests (local test DB)

- Each list endpoint: paging past 50, every filter, counts, executive sees only own doctors.
- Browser: filter → count updates, page 2, clear filters, URL keeps state across reload, phone width.
