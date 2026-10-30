# 91 — Flow sync: one run at a time (lock waits and deadlocks)

## Problem

`pg_stat_statements` since 1 Oct 2026 shows:

- `SELECT current_status FROM giniflow_visits WHERE id = $1 FOR UPDATE` (`advanceStatus`, the
  single row lock every floor status change takes) averages **6.4 s** and peaks at **96 s**
  across 3,532 calls. It is a primary-key lookup, so that time is **waiting for another
  transaction's lock**.
- **748 deadlocks**, and 6.16 M rollbacks against 40.2 M commits.

While a station action waits on a visit lock it holds a pooler connection. Enough of them and the
API times out, which feeds the "unhealthy" episodes (see the Supabase health check, 30 Oct).

### Why

`syncAppointmentsToFlow` (`services/giniflow/appointmentSync.js`) walks **every visit of the
day**. It runs day-wide `UPDATE giniflow_visits … WHERE visit_date = $1` statements (assigned
doctor, echo routing, lab-only billing, pharmacy and lab-only sweeps, coordinator holds), then a
short transaction per appointment that locks that visit and advances it.

It is started from four places, with **nothing stopping two runs from overlapping**:

| Caller | Process | How often |
|---|---|---|
| Reception refresh (`cron/index.js`, `syncFlow`) | worker | every 10 s |
| Gini Flow loop (`cron/index.js`) | worker | every 30 s |
| Triage board (`triage.js getTriageDay`, `ensure: true`) | **API** | every request: each open board polls every 15–60 s |
| The same three, from the local worker / dev API | local machine (runs against production, [[railway-ip-blocked-local-reads-bills]]) | the same |

Each run re-reads and re-checks the whole day. Two runs at the same time:

- lock the same visit rows in different orders, which causes the **deadlocks**;
- make every station action (vitals saved, patient called, Rx done) queue behind a sync
  transaction, which causes the **6 s waits**;
- double the CPU and disk work on an instance already short of both.

The in-process flags in `cron/index.js` (`syncInFlight` …) only stop the *worker's own loops*
from overlapping each other. The API's triage board and the second machine are not covered.

## Change

**At most one flow sync for a day runs at a time, across every process, and a sync that finished
moments ago is not repeated.**

### 1. A shared "sync lease" in the database

- New table `giniflow_sync_leases (day date PRIMARY KEY, holder text, started_at, until,
  finished_at)`.
- Before syncing a day, a process takes the lease in one statement:
  ```sql
  INSERT … ON CONFLICT (day) DO UPDATE SET holder = $2, started_at = now(), until = now() + '2 min'
    WHERE giniflow_sync_leases.until < now() RETURNING holder
  ```
  A row back means it holds the lease and runs. No row means another process is syncing that day,
  so it skips this round and returns "already running".
- When done, it sets `finished_at = now(), until = now()`. A crashed run's lease expires by itself
  after 2 minutes, so a dead process can never block the sync for long.
- Pooler-safe: plain rows and short statements. **No advisory locks**: session advisory locks
  leak across the 6543 pooler ([[cron-advisory-lock-pooler]]).
- One holder per process: `hostname:pid`.

### 2. Don't re-run a sync that just finished

- If the day's `finished_at` is less than **15 s** ago, a new call returns at once without syncing.
  The board reads what the last run wrote.
- This mostly affects the triage board: a busy board then causes at most one sync every 15 s
  instead of one per request per screen.

### 3. Same rule for every caller

- `syncAppointmentsToFlow` itself takes the lease, so the worker loops, the reception refresh, the
  triage board and tomorrow's pre-sync all follow it without changes at each call site.
- The in-process flags stay; they just avoid asking the database for nothing.
- The triage board shows the same day as now. Its `ensured` summary reads "already up to date"
  when it skipped.

### Expected effect

From up to 4–8 overlapping day syncs at any moment to **one**, plus one per 15 s from the board at
most. Station actions no longer queue behind a second sync, and the deadlocks between overlapping
syncs stop.

## Not changed

- What the sync does to each visit, and in what order.
- `machineSync` (per-visit bill reads). Its transaction already holds the visit lock only for the
  database work; the HealthRay read happens before it.
- Station actions and their transactions.

## Server

- Migration `server/migrations/2026-12-23_giniflow_sync_leases.sql`: the table.
- `services/giniflow/syncLease.js` (new): `takeSyncLease(db, day)`, `finishSyncLease(db, day)`,
  `recentlySynced(db, day, ms)`.
- `appointmentSync.js`: `syncAppointmentsToFlow` takes the lease first, returns
  `{ skipped: "running" | "fresh" }` when it can't or needn't run, and finishes the lease in
  `finally`.
- `triage.js`: passes the skip through to `ensured`.
- Settings: `GINIFLOW_SYNC_FRESH_MS` (default 15000) and `GINIFLOW_SYNC_LEASE_MS` (default
  120000). The e2e env sets `GINIFLOW_SYNC_FRESH_MS=0`, so tests that sync twice in a row still do.

## Tests

New `e2e/giniflow/G130-flow-sync-one-at-a-time.spec.js` (local test DB):

1. Two syncs of the same day started together: one runs, the other returns `skipped: "running"`.
   Only one set of visits and events is created.
2. A sync right after another finished returns `skipped: "fresh"` within the 15 s window, and runs
   again after it.
3. A lease left by a crashed run (`until` in the past) is taken over by the next sync.
4. A sync that throws still frees the lease. The next call runs.
5. Different days don't block each other: today and tomorrow can sync at the same time.
6. The triage board still shows the day, with `ensured` reporting the skip.
7. Existing sync suites still pass: the giniflow appointment-sync, triage and lab-only specs
   (G-series that call `syncAppointmentsToFlow`).

Manual check after deploy:
- Open two triage boards and the reception station. The floor still updates as before.
- A day later, `pg_stat_statements`: the `FOR UPDATE` lock wait on `giniflow_visits` averages
  well under 1 s, and `pg_stat_database.deadlocks` stops climbing.

## Decisions (30 Oct 2026)

1. **Cross-process guard:** a lease row in the database (`giniflow_sync_leases`).
2. **"Just synced" window:** 15 s.
3. **Triage board:** can still start a sync, under the lease and the window.

## Built (30 Oct 2026)

- Migration `2026-12-23_giniflow_sync_leases.sql` (not yet applied on prod).
- `services/giniflow/syncLease.js`: `takeSyncLease` checks the running lease and the 15 s window in
  one statement and returns `{ holder }` or `{ skipped: "running" | "fresh" }`. `finishSyncLease`
  frees the lease only for its own holder. A failed run frees it without stamping `finished_at`,
  so the next call runs at once.
- `appointmentSync.js`: `syncAppointmentsToFlow` takes the lease, then runs the unchanged day sync
  (`syncDay`). A skip returns `{ date, skippedRun }`, the same key the HealthRay sync uses.
- Reception's **Refresh from HealthRay** passes `reuseRecent: false`. It still waits for a
  running sync, but it isn't skipped by the 15 s window, so a walk-in just fetched appears at once.
- `triage.js`: `ensured` is `{ skipped }` when the sync was skipped.
- `e2e/.env.e2e`: `GINIFLOW_SYNC_FRESH_MS=0`.
- Tests: `G130-flow-sync-one-at-a-time` (6) and G60, G61, G77, G114 pass. V03 test 6 fails with or
  without this change (an existing failure, unrelated).
