# Flow Manager — build plan

**Deliverable:** "Schema migration · status-engine functions (advance_status,
get_station_times) · role auth · shared theme extracted from prototypes · Flow Manager board
reading seeded demo visits with live timers and SLA drawer" — brief §5.

**Spec file:** `docs/gini-flow-manager.html` — match it closely; it is the design spec.

**Goal:** a Flow Manager can open one screen and see, for today, where every patient is, how
long they have been there, whether that is over budget, where the bottleneck is, and the full
timeline of any one patient. Read-only: no station writes yet (station screens are a later
build), and — because Gini Flow is separate from the existing `flow_*` module — it runs on its
own seeded demo visits, not on the old module's live floor data. See `00-OVERVIEW.md` §2.3.

**Depends on:** `00-OVERVIEW.md` §3. The two big questions are settled: the database is
Supabase project `vuukipgdegewpwucdgxa` (the one `DATABASE_URL` already uses; migrations run
through `_runOne.mjs` with `pg`, not the dashboard), and **Gini Flow is built as a separate
system from the existing `flow_*` module** — see §2.3.

> ### Separation rule — applies to every task below
>
> Gini Flow does not read, write, extend, import from, or share tables with `flow_*`. New
> tables (`giniflow_*`), new routes (`server/routes/giniflow.js`), new services
> (`server/services/giniflow/`), new pages (`src/pages/giniflow/`), new URLs (`/giniflow/*`),
> new capabilities (`GINIFLOW_*`). The only shared objects are `patients`, `doctors` and
> `appointments` — the hospital's data, referenced by FK, not the old module's.
>
> No task in this plan modifies anything under `flow_*`. The old module keeps running
> untouched until it is deleted whole (Task 1.13).

**Scope:** this file plans the Flow Manager screen only. The brief's other three phases are
specified by 7 HTML prototypes that are not in this repo; they are deliberately unplanned.
Where a column below is needed by a later build, it says so — those columns ship now with
sensible defaults so no migration is needed later, but nothing outside the board is built.

---

## Build status — 2026-08-31

Backend and page are built and green. What shipped:

| Task                             | Status       | Where                                                                                   |
| -------------------------------- | ------------ | --------------------------------------------------------------------------------------- |
| 1.0 namespace scaffolding        | done         | `server/{routes,services}/giniflow*`, `src/pages/giniflow/`, `shared/giniflowStatus.js` |
| 1.1 SLA config                   | done         | `server/migrations/2026-08-31_giniflow_sla_config.sql` (10 rows, applied)               |
| 1.2 visits + event log           | done         | `server/migrations/2026-08-31_giniflow_core.sql` (applied)                              |
| 1.2d lab orders                  | done         | `server/migrations/2026-08-31_giniflow_lab_orders.sql` (applied)                        |
| 1.3 status engine                | done         | `server/services/giniflow/{statusEngine,board}.js`                                      |
| 1.4 capabilities + routes        | done         | `GINIFLOW_VIEW`, `GINIFLOW_SLA_ADMIN`; `/giniflow/manager`                              |
| 1.5 hostname                     | **not done** | still open — decision 6                                                                 |
| 1.6 theme                        | done         | `src/styles/giniflow-theme.css` + `giniflow.css` (scoped under `.gf`)                   |
| 1.7 read API                     | done         | `server/routes/giniflow.js` — 5 endpoints                                               |
| 1.8–1.10 board, drawer, timeline | done         | `src/pages/giniflow/FlowManagerPage.jsx`                                                |
| 1.11 seeder                      | done         | `server/services/giniflow/demo.js` — 22 visits, 178 events, 3 lab orders                |
| 1.12 smoke                       | done         | `npm run smoke:giniflow` — 33 checks                                                    |
| 1.13 retirement plan             | **partial**  | parity list written below; names and dates still needed                                 |

**"Switch role"** (plan 1.8f-2, audit GF-13) is shipped and matches the prototype, whose own
button also only names the six station screens rather than navigating. It must not link into the
old `/flow/*` pages — that would reconnect the two systems in the UI, the one thing the separation
decision exists to prevent. It becomes a real switcher when Gini Flow has its own stations.

**Supported devices (audit GF-17):** the board is built for the floor's wall display and a
desktop, 1024px and wider. Below 900px it hides the board and says so rather than degrading into
eight unreadable columns. A phone-shaped station view is a different screen, not this one.

Deviation from the brief, made during the build: the chain gained a **`with_vitals`**
status. The brief goes `vitals_pending → vitals_done`, which leaves no state meaning
"on the chair having BP taken", so the "At vitals" column and the 5-minute vitals budget
would have had nothing to measure.

Not verified in a browser: the extension's `localhost` resolves to a different machine
than the dev server, so the page has only been checked via `npm run build` and its API.
Open `/giniflow/manager` to confirm it matches the prototype.

## Task list

Each task is independently shippable and verifiable. Suggested order is top to bottom;
1.6–1.9 (UI) can start once 1.3 (the read API) returns shape-correct data.

### 1.0 — Namespace scaffolding

Create the empty shells first so every later task has an obvious home and nothing drifts into
the old module by habit:

- `server/routes/giniflow.js` — mounted flat under `/api` like every other route file
- `server/services/giniflow/` — `statusEngine.js`, `board.js`, `demo.js` land here
- `src/pages/giniflow/` — `FlowManagerPage.jsx` and its CSS
- `shared/giniflowStatus.js` — the status vocabulary (Task 1.2b)
- `src/styles/giniflow-theme.css` — the extracted design tokens (Task 1.6)

Also record here, once, what the old `/flow/coordinator` page does that the prototype does not:
station occupancy, the "don't add more" warning per station, per-visit stuck reasons. Those
came from real floor use. Carry the _ideas_ into the new board where they earn their place —
do not import the code.

**Done when:** the directories exist, `server/routes/giniflow.js` responds to a health-check
route, and nothing in `src/pages/flow/` or `server/routes/flow.js` has been touched.

### 1.1 — Schema migration: SLA config

**File:** `server/migrations/2026-09-XX_giniflow_sla_config.sql`

Create `giniflow_sla_config` — the editable time budgets behind every timer colour. Seed values
come from the brief §3 and the prototype's SLA drawer (they agree):

| `station` key       | Label in drawer          | Description                                  | Budget |
| ------------------- | ------------------------ | -------------------------------------------- | ------ |
| `checkin_to_vitals` | Check-in → Vitals        | Wait after check-in before vitals begin      | 10     |
| `vitals`            | Vitals station           | BP, weight, height entry time                | 5      |
| `wait_sd`           | Wait for SD / MO         | After vitals, before SD sees patient         | 10     |
| `sd`                | SD / MO station          | Workup + plan drafting                       | 15     |
| `wait_doctor`       | Wait for Dr. Bhansali    | After SD ready, before doctor sees           | 15     |
| `doctor`            | Dr. Bhansali station     | Consultation + prescription                  | 20     |
| `pharmacy`          | Pharmacy                 | Dispensing + counselling                     | 10     |
| `lab_total`         | Lab: sample → upload     | Parallel track · collection to report upload | 45     |
| `reception_payment` | Reception: payment clear | Test order to payment received               | 10     |
| `total_journey`     | Total journey target     | Check-in to exit — the headline number       | 90     |

Columns: `id uuid pk`, `station text unique not null`, `label text not null`,
`description text`, `budget_minutes int not null`, `category_overrides jsonb null`,
`display_order int`, `updated_at`, `updated_by`.

`category_overrides` is seeded `null` and unused for now (per-category budgets — the
teal hint box at the bottom of the drawer). Ship the column now so no migration is needed later.

Idempotent: `CREATE TABLE IF NOT EXISTS` + `INSERT … ON CONFLICT (station) DO NOTHING`.

**Done when:** `node migrations/_runOne.mjs migrations/2026-09-XX_giniflow_sla_config.sql` runs
twice with no error and `SELECT * FROM giniflow_sla_config ORDER BY display_order` returns 10 rows.

---

### 1.2 — Schema migration: visits + event log

**File:** `server/migrations/2026-09-XX_giniflow_core.sql`

The two tables that are the whole system's spine, per brief §3. Nothing here touches
`flow_visits` / `flow_events` — those belong to the module being retired.

#### `giniflow_visits` — one row per patient per OPD day

- `id uuid pk`, `patient_id int fk → patients(id)`, `visit_date date`, `appointment_time time`
- `appointment_id int fk → appointments(id) null` — the booking it came from, when there is one
- `current_status text` — denormalised latest chain status, for fast board grouping
- `results_status text default 'none'` — `none | partial | ready`
- `blocked_reason text null` — drives the red blocked strip on the card
- `category text` — `worse_out_of_range | worse_in_range | getting_better | in_control | no_reports`;
  this is the coloured dot (🔴 🟡 ✅ 🔵)
- `assigned_sd_id int fk → doctors(id) null`, `assigned_doctor_id int fk → doctors(id) null`
- `lifestyle_flagged boolean default false` — brief §3; unused by the board, shipped so the
  column exists
- `created_at`, `updated_at`
- **Unique** `(patient_id, visit_date)` — the brief's "ONE visit record per patient per day" is
  the core invariant; enforce it in the schema, not in application code. The old module learned
  this the hard way and needed two later migrations to add the constraint.
- Index on `(visit_date, current_status)` — the board's only hot query

#### `giniflow_visit_events` — the append-only timestamped log

- `id uuid pk`, `visit_id uuid fk → giniflow_visits(id) on delete cascade`
- `status text` — the status being entered
- `actor_role text` — `reception|vitals|mo_sd|doctor|lab|pharmacy|system`
- `actor_id int fk → doctors(id) null`
- `occurred_at timestamptz not null default now()` — the seeder passes it explicitly to
  backdate; every duration in the system is a diff between consecutive rows
- `meta jsonb default '{}'` — e.g. `{vitals:{bp:'143/90',weight:116.8}}`
- Index on `(visit_id, occurred_at)` — every timeline and duration read is ordered by it

**Append-only means append-only.** Never `UPDATE` a row here. A correction is a new event. All
timers, the timeline modal, the station averages and the day report derive from this table
alone — which is what makes the board reconstructible after any crash or reload.

**No backfill.** There is nothing to migrate from: the old module's data stays in the old
module. The board starts empty and is filled by the seeder (Task 1.11) until Gini Flow has its
own check-in.

**Rollback:** everything here is a new table. If the schema turns out wrong while nothing yet
writes to it, `DROP TABLE giniflow_visit_events, giniflow_visits` is safe and touches no live
data. That is only true _because_ the system is separate — one of the concrete benefits of the
separation decision.

#### 1.2b — The status chain

Single source of truth, `shared/giniflowStatus.js` (dependency-free pure data, imported by both
server and client, per the `shared/` convention):

```
booked → confirmed → checked_in → vitals_pending → vitals_done
  → sd_pending → with_sd → ready_for_doctor → with_doctor
  → doctor_done → pharmacy_pending → dispensed → exited
exception: no_show · cancelled · blocked_reports
lab track: ordered → payment_pending → paid → sample_collected
  → processing → results_ready → uploaded
payment track: pending | paid | insurance_claim
```

Export: `CHAIN` (ordered array), `LAB_TRACK`, `EXCEPTION_STATUSES`, `STATUS_LABEL`,
`STATUS_TO_SLA_KEY` (which `giniflow_sla_config.station` budget each status is measured
against), `BOARD_COLUMNS` (which statuses collapse into which kanban column) and
`nextStatus(current)`.

The old module's configurable step templates (`flow_step_catalog`, `flow_step_templates`) are
**not** consulted. Gini Flow uses the brief's fixed chain — that is the point of owning the
schema.

#### 1.2c — The visit sequence number

The prototype card reads `26M · P_51200 · Visit 19`. That is the patient's **visit sequence
number** — how many times they have been seen. Compute it in the board query as a window
function over the patient's visit history; do not store it.

Note the old module carries a `visit_token` (the opaque URL token for its public tracker) and a
`token_number` (reception's physical queue slip, deliberately not unique). Neither is this
number, and neither is read here — flagged only so nobody reaches for them out of habit.
Rendering a tracker token in a UI label would leak the tracker link.

**Done when:** the migration runs twice cleanly, the unique constraint rejects a second visit
for the same patient on the same day, and `shared/giniflowStatus.js` exists.

### 1.2d — Minimal `lab_orders` so the Lab track column has data

**The prototype's board has a "Lab track" column** — three cards showing "💰 Payment pending at
reception", "⚙️ Processing in analyzer", "📤 Results ready — awaiting upload", each with its own
timer against a 45-minute sample→upload budget. There is nowhere in the current schema to read
that from — and per the separation rule these are new tables of ours, unrelated both to the
existing `lab_test_requests` table and to the HealthRay-facing `lab_requests` route.

Two options:

- **(A) Ship the tables now, read-only** _(recommended)_ — create `giniflow_lab_orders` and
  `giniflow_lab_order_tests` as the brief §3 specifies, with no station UI writing to them. The
  demo seeder populates them; the board reads them. Additive, cheap, and it means the lab
  station build later has no schema work.
- **(B) Ship the column empty** — the board renders "Lab track" with a permanent empty state
  until the lab station is built. Honest, but it leaves a visible hole in the one screen this
  build is meant to deliver.

Going with (A): `giniflow_lab_orders (id, visit_id fk → giniflow_visits, ordered_by,
urgency today|tomorrow|next_visit, payment_status pending|paid|insurance_claim,
amount_total numeric, sample_status ordered|payment_pending|paid|sample_collected|processing|
results_ready|uploaded, report_file_url, uploaded_at)` and
`giniflow_lab_order_tests (id, lab_order_id fk, test_name, price)`.

State in the migration header comment that these are **not** `lab_requests` and **not**
`lab_test_requests`, and why, so the next person does not merge them.

**Done when:** the migration is idempotent and the seeder can produce the prototype's three
lab-track cards.

### 1.3 — Status engine (server service)

**File:** `server/services/giniflow/statusEngine.js` (the brief's `advance_status` /
`get_station_times`). Domain logic only — no HTTP, per the repo's routes → services → db rule.

Functions:

- `advanceStatus(client, { visitId, toStatus, actorRole, actorId, meta })`
  - Validates the transition against `shared/flowStatus.js` (reject a jump that skips the
    chain unless `toStatus` is an exception status).
  - Appends **one** row to `giniflow_visit_events` (`status`, `actor_role`, `actor_id`,
    `occurred_at`, `meta`). Append-only — never update an event.
  - Updates `giniflow_visits.current_status` + `updated_at` in the same transaction.
  - Returns the new status row.
  - This build only calls it from the demo seeder; station screens will call it for real.
    Build it now so the station work has no engine left to write.
- `getStationTimes(visitId)` — reads `giniflow_visit_events` alone (consecutive rows give
  wait and station durations; there is no separate steps table by design) and returns, per
  chain step: `{ status, enteredAt, leftAt, waitMinutes, stationMinutes, budgetMinutes,
pct, colour }` where `colour` = green <80 %, amber 80–100 %, red >100 % of budget. This one
  function powers the card timer chip, the timeline modal durations and the footer averages —
  do not compute durations anywhere else.
- `getDayBoard(visitDate)` — one query returning every visit for the date with its current
  status, minutes-since-last-event, total-journey minutes, category, results status, blocked
  reason, assigned SD/doctor name, visit sequence number, and the card's one-line subtitle.
  Must be a **single round trip** (lateral join / window function over `giniflow_visit_events`), not
  N+1 per visit.
  - **Excluded from the board:** `no_show` and `cancelled` visits. They are not on the floor,
    so they get no column and no card — but they still count in the stats (Task 1.3 stats),
    and the day report needs them. Filter them out of `columns`, not out of the query.

⚠️ **"Today" means the IST day, not `CURRENT_DATE`.** The server runs UTC, so between
00:00 and 05:30 IST `CURRENT_DATE` is still yesterday and the board would go blank mid-shift or
mix two days. The repo already has the correct idiom — `IST_TODAY` in
`server/services/ghmDayWindow.js`:

```sql
(now() AT TIME ZONE 'Asia/Kolkata')::date
```

Use the same expression (copy the idiom — do not import from the old module) for every date
default and comparison in the engine. Note `server/routes/flow.js:966` uses bare
`CURRENT_DATE`; that is one of the bugs not to inherit.

- `getBottleneck(board, slaConfig)` — pure function over the board result. Returns the
  station whose _average current wait_ most exceeds its budget: `{ station, label, count,
avgWaitMinutes, budgetMinutes, longest: { name, minutes }, suggestion }`. Suggestion text
  is rule-based, matching the prototype's copy ("SD closes green-category patients directly"
  when the over-budget station is `wait_doctor` and ≥1 queued patient is green-category).
  Returns `null` when nothing is over budget — the banner then hides.
- `getDayStats(board, slaConfig)` — the six stat tiles: in-building now / of booked,
  completed + avg, over-budget count, blocked count, avg journey vs target, % within SLA.
  - **"14 of 18 booked" does not come from `giniflow_visits`.** A patient who never arrived has no
    flow visit, so the denominator must come from today's `appointments` rows (the
    HealthRay-synced table). Stats needs a second small query: booked / arrived / no-show /
    cancelled for the IST day. Spell this out or the tile silently reads "14 of 14".
- `getStationAverages(visitDate)` — the footer strip: per-SLA-station today's average vs
  budget, with the bar fill percentage.

**Done when:** a scratch script prints a plausible board, bottleneck and stats for today
against production data without mutating anything.

---

### 1.4 — Roles, capabilities and route guards

**Files:** `shared/permissions.js`, `src/config/routes.js`, `src/router.jsx`, `AppLayout`.

**Roles are shared, capabilities are not.** A role belongs to the person (`doctors.role`), so
`coordinator` is the same coordinator in both systems — no new roles. But Gini Flow gets its
own capability keys so access can be granted independently during the parallel-run period, and
so deleting the old module later means deleting every `FLOW_*` key without touching this one.

New capabilities:

| Capability           | Gates                                                  | Granted to                                                                          |
| -------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `GINIFLOW_VIEW`      | the board page + all read endpoints                    | `admin`, `coordinator`, `consultant`, `mo`, `nurse`, `lab`, `pharmacy`, `reception` |
| `GINIFLOW_SLA_ADMIN` | `PATCH /api/giniflow/sla-config` and the drawer's Save | `admin`, `coordinator`                                                              |

Brief role → existing role, for reference: `flow_manager` → `coordinator` (+ `admin`),
`mo_sd` → `mo`, `vitals` → `nurse`, `doctor` → `consultant`; `reception`, `lab` and `pharmacy`
already exist under their own names.

Register the route in the same change — three files, all required:

- `src/router.jsx` — lazy entry via `lazyWithRetry` (every page here uses it; skipping it means
  a stale-chunk error after the next deploy shows the user a blank error screen)
- `src/config/routes.js` — `PAGE_CAPABILITIES["/giniflow/manager"] = CAP.GINIFLOW_VIEW`
- nav entry in `AppLayout` so the page is reachable without typing the URL

Leave `ROLE_HOME` alone for now: during the parallel run the coordinator's landing page should
stay the old board until parity is agreed, then flip in one line as part of Task 1.13.

**Done when:** `node server/scripts/verify-rbac.mjs` passes, a `coordinator` account reaches
`/giniflow/manager` from the nav, a `nurse` account can view the board but gets 403 on the SLA
write route, and every existing `/flow/*` page behaves exactly as before.

### 1.5 — Hostname / shell decision (`flow.ginihealth.com`)

Blocked on decision 4 in `00-OVERVIEW.md`. If option (A) — one app, two hostnames:

- Point the `flow.ginihealth.com` DNS/Railway domain at the existing service.
- Add `src/config/brand.js`: reads `location.hostname`, returns
  `{ product: 'flow' | 'scribe', logoText, homeRoute }`.
- `AppLayout` renders the navy Gini Flow rail (Instrument Serif italic logo, live dot,
  Day report / Time budgets / Switch role buttons, mono clock) when `product === 'flow'`.
- Scribe's shell and routes are untouched.

**Done when:** `flow.ginihealth.com` serves the app with the Flow rail and lands a
coordinator on the board; `scribe.ginihealth.com` is visually unchanged.

---

### 1.6 — Shared theme extracted from the prototypes

**File:** `src/styles/giniflow-theme.css` (imported once by the Gini Flow shell; the old
`src/pages/flow/` styles are left alone).

The brief is explicit: all 8 prototypes share identical `:root` custom properties — extract
them **first**, before building any screen, so later screens have nothing to re-derive. Copy the
full token block verbatim from `gini-flow-manager.html` lines 9–22. Full token list and
component rules are written up in `02-DESIGN-SYSTEM.md`.

Fonts: add the Google Fonts link for Inter (300–700), JetBrains Mono (400/500) and
Instrument Serif (regular + italic) — or self-host if the offline-in-clinic case matters.

**Done when:** a scratch page renders a card, a timer chip in all three colours, a stat tile
and a column header that are pixel-indistinguishable from the prototype at the same zoom.

---

### 1.7 — Read API for the board

**File:** `server/routes/giniflow.js` (created in Task 1.0; mounted flat under `/api`
automatically). Nothing is added to `server/routes/flow.js`.

| Endpoint                                  | Returns                                                                                                              |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `GET /api/giniflow/board?date=YYYY-MM-DD` | `{ columns, stats, bottleneck, stationAverages, slaConfig, serverTime }` — everything the board needs in one request |
| `GET /api/giniflow/visits/:id/timeline`   | ordered steps for the timeline modal, from `getStationTimes`                                                         |
| `GET /api/giniflow/sla-config`            | the 10 budget rows                                                                                                   |
| `PATCH /api/giniflow/sla-config`          | bulk update budgets; `GINIFLOW_SLA_ADMIN`                                                                            |
| `GET /api/giniflow/day-report?date=`      | the Day report summary — the one-line figure the prototype toasts (a full report is out of scope)                    |

`serverTime` matters: the card timers tick client-side, so the client must offset against
server time rather than trust the tablet's clock — a wall-mounted display with a drifting clock
would otherwise show every patient as over budget.

`date` defaults to the **IST** today and is optional; accepting it lets the same endpoint serve
yesterday's board and the day report without a second query path. Reject dates more than N days
back only if the query proves slow — the index from Task 1.2 covers it.

Validate query/body against a new schema block in `server/schemas/index.js` via
`middleware/validate.js`, per repo convention.

**Done when:** `curl` on a seeded day returns all five payloads and `GET /api/giniflow/board`
runs in one query (check with `EXPLAIN` or a query counter, not by eye).

---

### 1.8 — Flow Manager page

**File:** `src/pages/giniflow/FlowManagerPage.jsx` + `.css`, route `/giniflow/manager`,
lazy-loaded through `lazyWithRetry` in `src/router.jsx` like every other page.

Data: one `useGiniflowBoard(date)` hook in `src/queries/hooks/`, `refetchInterval: 10_000`,
`refetchIntervalInBackground: false` (repo pattern). One `setInterval(1000)` in the page
advances a `now` value in state; every timer renders as `now − enteredAt` so seconds tick
without refetching.

Two rules that matter for a screen left open all day:

- **Always recompute from the timestamp, never increment a counter.** Browsers throttle
  `setInterval` in a background tab to once a minute or less; an incrementing counter drifts
  badly on a wall display, a recomputed `now − enteredAt` self-corrects on the next tick.
- **One `now` in page state, not one timer per card.** ~20 cards each holding their own
  interval is 20 re-renders a second for no reason.

Sub-tasks, each verifiable on its own:

- **1.8a Rail** — navy bar: "Gini Flow" (Instrument Serif italic) · divider · "Flow Manager"
  · pulsing green live dot + "Live · <weekday date>" · right side: Day report, Time budgets,
  Switch role, mono clock.
- **1.8b Stats strip** — the six tiles, last one dark (avg journey). Values from `getDayStats`.
- **1.8c Bottleneck banner** — red banner, 🚨, computed sentence with the station, count, avg
  wait vs budget, longest patient, and the suggestion. "Notify stations" button shows a toast
  — there are no station screens to alert yet.
  Banner hides entirely when `bottleneck === null`.
- **1.8d Board columns** — Checked in · At vitals · With SD/MO · Waiting — Dr. Bhansali ·
  With Dr. Bhansali · At pharmacy · Lab track (parallel) · Done today. Column header shows
  emoji, name, count pill, and an SLA sub-line ("Budget to vitals: **10 min**"). A column
  whose average exceeds budget gets the `hot` treatment (pink background, red header and
  count, "avg now 22m ⚠" in the sub-line).
- **1.8e Patient card** — avatar initials on a per-patient deterministic colour, name,
  category dot, a one-line subtitle (check-in time + visit number, or what is happening:
  "BP + weight in progress", "Dr. Beant Sidhu · workup", "Results ✓ · SD plan ready"), the
  station timer chip (green/amber/red), total-journey figure right-aligned (red + bold when
  over the 90 m target), and an optional bottom `wait4` strip — "→ Waiting for vitals
  station", "💡 Green category — SD could close", or the red blocked variant "🚫 Blocked —
  reports not uploaded".
- **1.8f Station performance footer** — one tile per SLA station: name, actual vs budget in
  mono, coloured, with a progress bar; last tile dark = total journey.
- **1.8f-2 "Switch role" and "Day report" buttons** — the rail carries both. There are no
  other Gini Flow screens to switch to in this build, and it must **not** link into the old
  `/flow/*` pages — that would reconnect the two systems in the UI. Show a toast listing the
  roles until Gini Flow's own station screens exist. Do not ship a dead button. "Day report"
  toasts the one-line summary from `GET /api/giniflow/day-report` (the full report is out of scope).
- **1.8g Empty / loading / error states** — the prototype has none. A column with no patients
  renders a muted "—"; a failed board fetch keeps the last good board visible with a stale
  banner rather than blanking the floor's screen.

**Done when:** side by side with the prototype at the same window size, the board is visually
matched; timers advance every second while data refreshes every 10 s; and leaving the tab in
the background for 10 minutes then returning shows correct times immediately, not drifted ones.

---

### 1.9 — Time-budgets drawer

Right-side 380 px drawer, navy header, one row per `giniflow_sla_config` row (name, description,
64 px mono number input, "min"), the total-journey row emphasised in teal, and the teal hint
box about per-category overrides — render it as informational text, not a control; the
overrides themselves are out of scope.

Save → `PATCH /api/giniflow/sla-config` → invalidate the board query → all card colours and
footer bars recompute → toast "✓ Time budgets saved — all timers recalculated". Cancel closes
without saving. Gated on `GINIFLOW_SLA_ADMIN`; a role without it sees the drawer read-only.

**Done when:** changing "Wait for Dr. Bhansali" from 15 to 45 turns that column from hot to
normal and re-colours every card in it, with no page reload.

---

### 1.10 — Patient timeline modal

Click any card → 520 px modal. Navy header with the patient's name in Instrument Serif italic
and a meta line (`41F · P_42220 · Visit 5`). Body = vertical timeline from
`GET /api/giniflow/visits/:id/timeline`: done steps get a green ✓ dot, the current step a solid
teal ● dot, future steps a hollow grey ○ with dimmed text. Each step: name, timestamp (or
"Since 09:51"), a duration pill ("8m wait + 12m station") coloured green/amber/red against
budget, and an optional note. Over-budget steps render red with the overage spelled out
("41m waiting — 26m OVER budget"). A blocked step shows the reason and the suggested action,
matching the prototype's blocked scenario copy. Future steps show "Budget 20m" and the last
one summarises the journey against the 90 m target.

Close on ✕ and on backdrop click (both are in the prototype).

**Done when:** opening a patient's timeline shows every `giniflow_visit_events` row exactly once,
in order, with durations that match a manual stopwatch check.

---

### 1.11 — Demo seeder for the board

**File:** `server/services/giniflow/demo.js`, wired to `POST /api/giniflow/demo/seed` and
`/demo/clean` (admin-gated). Written fresh — the old module's `server/services/flow/demo.js`
seeds `flow_*` and is not reused.

**This is the board's only data source for now.** Gini Flow has no check-in yet and does not
read the old module's visits, so what the seeder produces _is_ what the board shows. Make it
good: seed a day that reproduces the prototype — ~18 booked, 14 in building, 8 done, 3 over budget, 2 blocked, a hot
"Waiting — Dr. Bhansali" column with a 41-minute patient, and 3 lab-track patients (payment
pending, processing, upload pending). Seed via `advanceStatus` with an explicitly backdated
`created_at` and a realistic `actor_role` per event, so the timers, averages and the smoke
script's actor assertions are all real rather than faked. Seed against the **IST** day.

**Done when:** `POST /api/giniflow/demo/seed` then opening `/giniflow/manager` reproduces the
prototype's board, `POST /api/giniflow/demo/clean` removes exactly the seeded rows, and neither
touches a single `flow_*` row.

---

### 1.12 — Smoke script

**File:** `server/scripts/smoke-giniflow-manager.mjs`, wired as `npm run smoke:giniflow` in
`server/package.json` (matching the existing `smoke:*` scripts). Note there are 14 such scripts
already — follow their structure rather than inventing one.

Asserts: seed a demo day → `GET /api/giniflow/board` returns the expected column counts →
every seeded visit has exactly one `giniflow_visit_events` row per transition with the right
`actor_role` → `getStationTimes` durations match the seeded timestamps within a second →
bottleneck resolves to `wait_doctor` → `PATCH /api/giniflow/sla-config` changes the colour of a
known card → the unique `(patient_id, visit_date)` constraint rejects a duplicate → clean up.

Add one **isolation assertion**: the whole run leaves `SELECT count(*) FROM flow_visits` and
`flow_events` unchanged. That is the regression test for the separation rule.

**Done when:** `npm run smoke:giniflow` passes from a clean state and leaves no rows behind.

---

### 1.13 — Retirement plan for the old module (write it now, execute it later)

Not part of this build's code, but it must be written down while the reasoning is fresh —
otherwise the two systems quietly become permanent, which is the worst outcome.

Record here:

1. **Parity checklist** — what the old `/flow/coordinator` and `FlowReportsPage` do that Gini Flow
   must do before the old module can go:

   | Old capability                                                     | Gini Flow today                                  | Gap                                                                           |
   | ------------------------------------------------------------------ | ------------------------------------------------ | ----------------------------------------------------------------------------- |
   | Live floor list with per-visit elapsed time                        | ✅ kanban board with live timers                 | —                                                                             |
   | Per-visit "stuck at X for Nm, budget Nm"                           | ✅ card timer + timeline modal                   | —                                                                             |
   | Over-budget colouring                                              | ✅ green/amber/red against `giniflow_sla_config` | —                                                                             |
   | **Station occupancy panel** (who is at which desk now)             | ❌                                               | column counts imply it; a named-staff view does not exist                     |
   | **"N running over — don't add more"** capacity warning per station | ❌                                               | the bottleneck banner names one station, not per-station capacity advice      |
   | Journey promise vs actual on completion                            | ⚠️ partial                                       | "Xm total" on the card; no explicit promise-vs-actual line                    |
   | Wait-time analytics over a date range (`FlowReportsPage`)          | ❌                                               | day report covers one day only                                                |
   | Check-in, station desks, pharmacy exit                             | ❌                                               | out of scope for this build — the reason the old module cannot be retired yet |

   The last row is the real blocker: **the old module cannot be deleted until Gini Flow has its own
   check-in and station screens**, because deleting it would leave the floor with no way to record
   a patient at all. Everything above it is a smaller gap.

2. **Parallel-run period** — how long both run, and who (named person, not a role) signs off
   that parity is reached.
3. **The switch** — flip `ROLE_HOME` for `coordinator` to `/giniflow/manager`, remove the old
   nav entries.
4. **The deletion**, in this order, each its own commit so any step can be reverted alone:
   `src/pages/flow/` → `src/config/routes.js` entries → `server/routes/flow.js` →
   `server/services/flow/` → the `FLOW_*` capability keys → last of all, one migration dropping
   `flow_visits`, `flow_visit_steps`, `flow_events`, `flow_step_catalog`, `flow_visit_types`,
   `flow_step_templates`, `flow_staff`.
5. **Before that final migration** — the old module holds real historical floor data. Decide
   whether it is archived (dump to a file, or `_archive`-suffixed tables) or genuinely dropped.
   Once dropped it is gone; this is production and there is no staging copy.
6. **`/visit/:token`** — the public patient tracker runs on `flow_visits.visit_token`. Patients
   may hold live links. Either Gini Flow ships its own tracker first, or the old table survives
   the cull until outstanding links have expired. **Do not drop `flow_visits` before answering
   this** — it would break links already in patients' hands.

**Done when:** the checklist exists with names and dates against items 2 and 5–6.

---

## Definition of done

From the brief's per-phase definition of done, narrowed to what this build can actually prove:

- [x] The Flow Manager board renders live and reads nothing from `flow_*`. It now runs on **real
      patients** via the HealthRay appointment sync, not only seeded ones.
- [~] Timer arithmetic is asserted against seeded timestamps to the minute, and timers recompute
  from the timestamp each tick. **The stopwatch check against a real patient has not been done** —
  it belongs with the browser comparison.
- [x] Every status transition appears in `giniflow_visit_events` exactly once with the right `actor_role`.
- [~] Every date comparison uses the IST idiom, never `CURRENT_DATE`. **Not yet observed during
  the 00:00–05:30 window itself.**
- [x] Editing a time budget recolours the board immediately, with no reload.
- [x] The timeline modal reconstructs a full journey from the event log alone.
- [x] Closing and reopening the tab loses nothing — the page holds no state of its own.
- [x] `npm run smoke:giniflow` (52), `smoke:giniflow-sync` (9), `smoke:giniflow-http` (9) and
      `smoke:giniflow-render` (11) all pass; `format:check` clean; `verify-rbac` 90/90.
- [x] Nothing in the existing `/flow/*` pages, `/visit/:token` tracker, `flow_*` tables, or Scribe
      changed at all — asserted by two of the smoke suites.
- [ ] The parallel-run period and the parity sign-off for retiring `/flow/coordinator` are agreed and written down (Task 1.13).

## Explicitly out of scope

Everything except the Flow Manager screen: station writes, check-in, vitals entry, lab orders,
payments, prescriptions, pharmacy, referrals, WhatsApp, MHG hooks, per-category SLA overrides,
the triage board, the doctor list and consult screen, and the full day report. "Notify
stations" is a toast, not an alert write. The board is read-only.

Those are all specified by the 7 prototype files the brief lists as attached but which are not
in this repo. Add them and each can be planned to this level of detail.

---

## Sequencing

Task 1.0 (scaffolding) then the three migrations land first. After that:

```
1.0 namespace scaffolding
      │
      ├─ 1.1 sla config ────┐
      ├─ 1.2 visits+events  ├─→ 1.3 status engine ─→ 1.11 seeder ─→ 1.7 read API ─┬─→ 1.8 board
      └─ 1.2d lab orders ───┘                                                     ├─→ 1.9 drawer
         1.4 capabilities + route registration ─────────────────────────────────  ┤
         1.6 theme ─────────────────────────────────────────────────────────────  ┴─→ 1.10 timeline
                                                                       1.12 smoke ─→ 1.13 retirement plan
```

1.5 (hostname) is independent and can land any time before release. The seeder sits early on
purpose — with no check-in of its own, it is the only way 1.7–1.10 get testable data.

## Risks

- **A production database with no staging.** Run every migration through
  `node migrations/_runOne.mjs` so it is recorded like every other migration — not through the
  Supabase dashboard SQL editor, which leaves no file in the repo and no trace for the next
  person. The risk here is unusually low: Tasks 1.1–1.2d only _create_ new `giniflow_*` tables,
  touch no existing row, and can be dropped outright if the shape turns out wrong.
- **The board is a wall display.** It must survive being left open all day: network blips
  (keep last good data, show stale, never blank), background-tab timer throttling (Task 1.8),
  and a drifting device clock (server time, Task 1.7).
- **Two live boards during the parallel run.** By design the floor briefly has the old
  `/flow/coordinator` (real patients) and the new `/giniflow/manager` (seeded data). They will
  disagree, because they are looking at different data. Tell the coordinator that explicitly
  before the first demo, and keep the parallel run short — Task 1.13.
- **The new board shows no real patients until Gini Flow has its own check-in.** This is the
  accepted cost of separation, not a defect, but it means "is it ready?" cannot be answered
  from this build alone.
- **The 7 missing prototypes.** Columns and statuses shipped here (`results_status`,
  `category`, `lab_orders`) are guesses at what the station and triage screens will write.
  They are cheap to change while nothing writes them; they are expensive to change afterwards.

## Still unanswered

Carried from `00-OVERVIEW.md` §3 plus what this plan surfaced:

**Settled — no longer blocking anything:**

1. ~~Which database~~ — Supabase project `vuukipgdegewpwucdgxa`, via `pg` through the port-6543
   pooler; migrations through `_runOne.mjs`.
2. ~~Extend `flow_*` or build separately~~ — separate, under `giniflow_*`; old module retired later.
3. ~~Fixed chain vs. configurable step templates~~ — moot once the schema is ours: the brief's
   fixed chain, in `shared/giniflowStatus.js`.
4. ~~What happens to `/flow/coordinator`~~ — replaced, not modified.
5. ~~Ship `lab_orders` now or leave the Lab track column empty~~ — ship them (Task 1.2d option A),
   read-only, seeded by the demo seeder.

**Open, none blocking the start:**

6. `flow.ginihealth.com` — one app on two hostnames (recommended) or a separate SPA. Needed
   before Task 1.5 only; tasks 1.0–1.4 and 1.6–1.12 do not care.
7. Is the board the coordinator's landing page (`ROLE_HOME`), or just a nav item? Task 1.4 keeps
   the old landing page during the parallel run either way — this is a one-line flip in Task 1.13.
8. Exact emoji ⇄ `category` mapping. Inferred from the board prototype's cards; the triage
   prototype is the authority and is not in the repo. Wrong-coloured dots are a cosmetic fix later.
9. Parallel-run length and who signs off parity (Task 1.13). Needed before retirement, not before
   the build.
