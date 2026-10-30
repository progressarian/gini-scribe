# 90 — Outside reports pending: stop it overloading the database

## Problem

Supabase marks the project **unhealthy** when the Micro instance runs out of its disk-I/O budget
(1 GB RAM, 256 MB shared buffers, `work_mem` 3.5 MB). `pg_stat_statements` since 1 Oct 2026
shows the lab's **Outside reports pending** query as the biggest single load. Its six variants are
about **94,000 calls**, roughly **50 hours of database time in 29 days**, 1–5.5 s per call, and
up to 90 s at peak. Its unions, `array_agg`, `count(*) OVER ()` and sort spill to temp files, which
is part of the 359 GB of temp files this month.

Why it runs so often (`server/services/giniflow/outsidePending.js`, `listOutsidePending`):

1. **Every call runs the full query twice:** once for the page (`LIST_SQL`) and once for the
   counts (`COUNT_SQL`). Both rebuild the whole `pending` set from scratch.
2. **Every lab screen polls it, even when nobody looks at the tab.** `LabRoom.jsx:1492` calls
   `useOutsidePending()` just to show the **Outside reports (N)** badge. LabRoom is the Lab
   Collection *and* Lab Processing station, so each open lab computer runs list + count every
   **15 s** (60 s when live updates are connected). With the Outside tab open, it runs a second
   pair.
3. **Each run is heavy:**
   - The `outside_names` CTE runs a regex over every outsourced catalogue test and alias,
     every time.
   - The `case` branch scans 30 days of `lab_cases`, plus every case ever marked "sent outside".
     For each case it runs the cancelled / not-on-bill / sample-taken / document sub-queries.
   - Each pending case's test names are regex-flattened and checked against that list with
     `NOT IN`.

The result changes only when a sample is collected, sent outside or reported, which happens a
few times an hour. It is recomputed several times a minute by every lab computer.

## Change

**Work out the pending set once, share it with every screen for a short time, and redo it at once
when something on it changes.**

### 1. One shared result per day, at most every 30 s (server)

- `outsidePending.js` keeps the day's unfiltered `pending` rows in memory with a time stamp
  (`pendingSet()`). A request within 30 s of the last build uses it; otherwise the set is rebuilt.
- **One build at a time:** requests that arrive while a build runs wait for that same build,
  instead of starting their own.
- **Filtering, search, sort, counts and paging run in JavaScript** on that set: status, from/to
  date, name / UHID / test search, oldest first, 50 a page. The set is a few dozen rows, so this
  is instant. `COUNT_SQL` and `count(*) OVER ()` go away.
- **The set is cleared at once** (`forgetOutsidePending()`) whenever something that changes it
  happens on Scribe's own screens:
  - a sample is marked collected or sent outside
  - a report is uploaded or replaced
  - an order or case is cancelled or restored

  These all go through `labStation.js` / `labCaseActions` / `testCancel.js` / `testRestore.js`,
  so the next poll sees the change straight away. Changes that come only from the HealthRay lab
  sync (a new case, a HealthRay report) show within 30 s.
- The cache lives inside the API process. Each process (the live API, a local dev API) keeps its
  own, so the worst case is one build per process every 30 s.

### 2. A light count for the tab badge (server + client)

- New route `GET /api/giniflow/stations/lab/outside-pending/count` returns only
  `{ pending, collected, sent, uploaded }` from the same shared set. It is guarded like the list
  route.
- `LabRoom.jsx` uses a new `useOutsidePendingCount()` for the badge, polling every **60 s**
  instead of fetching page 1 of the list every 15 s. The full list is fetched only while the
  Outside tab is open (`OutsidePendingPanel`), as now.

### 3. A cheaper build (server)

- The outsourced-name list (`outside_names`) is read once and kept for 10 minutes. It changes only
  when Settings → Services changes, and the same clear-the-cache call runs then. It is passed into
  the query as a `text[]` parameter instead of being rebuilt by regex on every run.
- The query itself (what counts as pending) is **unchanged**, so the list shows exactly the same
  rows as today.

### Expected effect

Today, *N* lab computers run 2 × N full builds every 15 s, plus 2 more per open Outside tab.
After the change: **one build per 30 s at most**, whatever the number of screens, plus one
right after each lab action. That's roughly 90–95% fewer runs of the heaviest query, with matching
drops in temp files and disk reads.

## Not changed

- What appears on the list, its columns, filters and actions (View, Replace, Mark sent).
- The HealthRay lab sync, the lab queue, and other stations' polling.
- A worker-maintained table refreshed every 30–60 s was considered instead. It is more moving
  parts: a new table, a refresh loop, and keeping it in step with deploys. It's only worth it if
  the in-memory cache isn't enough.

## Server

- `services/giniflow/outsidePending.js`: `pendingSet(db)` (cached, one build at a time),
  `forgetOutsidePending()`, `listOutsidePending` filtering in JS, `countOutsidePending()`, and
  the outsourced-name list cached and passed as a parameter.
- `routes/giniflowStations.js`: `GET /giniflow/stations/lab/outside-pending/count`, with the same
  capability and guards as the list.
- Call `forgetOutsidePending()` after the lab actions above (`labStation.js`, the lab case action
  routes, `testCancel.js`, `testRestore.js`) and after service item / alias changes
  (`serviceItems.js`, `serviceItemAliases.js`).

## UI

- `src/queries/hooks/useGiniflowLab.js`: `useOutsidePendingCount()` (60 s).
- `src/components/giniflow/lab/LabRoom.jsx`: the badge uses the count hook.
- No visual change.

## Tests

Existing `e2e/giniflow/G63-outside-reports-pending.spec.js` and `G64-outsourced-healthray-cases`
must pass unchanged. They prove the list and filters show the same rows.

New `e2e/giniflow/G129-outside-pending-shared.spec.js` (local test DB):

1. Two list calls within 30 s run the pending query **once**. Counted with a query counter
   wrapped around the test pool.
2. Ten calls at the same moment build the set once.
3. Marking a sample sent outside clears the set. The next list shows it as "sent" at once, without
   waiting 30 s.
4. Uploading the report moves it to "uploaded" at once. Cancelling the order removes it at once.
5. A new HealthRay case (inserted directly, as the sync would) appears after the 30 s window
   (clock advanced in the test).
6. The count route returns the same numbers as the list's `counts`, and is refused for non-lab
   roles.
7. Filters, search, paging and the oldest-first order give the same rows as the old SQL for a
   seeded mix of orders and cases (`collected` / `sent` / `uploaded`, several days, outsourced
   and in-house).
8. Changing a service's outsourced flag clears the name list. A case for that test appears or
   disappears on the next call.

Manual check after deploy:
- Open Lab Collection and Lab Processing. The Outside reports badge shows the same number as
  before.
- Mark a sample sent. The badge and the list update at once.
- A day later, `pg_stat_statements` shows the outside-pending query's calls per hour down by about
  90%.

## Built (30 Oct 2026)

- `outsidePending.js`: `pendingRows()` (shared for 30 s, one build at a time, rebuilt after a
  clear), `forgetOutsidePending()`, `countOutsidePending()`, and list filtering in JavaScript.
- `server/middleware/outsidePendingRefresh.js`, mounted in `index.js`, clears the set after any
  successful change under `/api/giniflow/stations/{lab,lab-site,reception,doctor,mo}/`, any
  `/cancelled/` restore, `/api/giniflow/lab/` and the test catalogue. Billing master changes also
  clear the outsourced-name list.
- `GINIFLOW_OUTSIDE_PENDING_TTL_MS` sets the window (default 30000). `e2e/.env.e2e` sets it to 0,
  because the older specs change the database directly and read straight back.
- Tests: `G129-outside-pending-shared` (6) plus the unchanged `G63` and `G64` pass.

## Decisions (30 Oct 2026)

1. **Sharing window:** 30 s. It is rebuilt at once after any lab action on Scribe.
2. **Badge refresh:** every 60 s, from the light count route.
3. **Where the cache lives:** in the API process. No new table or worker loop.
