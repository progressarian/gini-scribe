# Gini Flow — Flow Manager build plan

**Scope: the Flow Manager screen only.** This folder plans exactly one deliverable — the
live kanban board specified by `docs/gini-flow-manager.html`. Nothing else is planned yet.

> **Database confirmed:** Supabase project `vuukipgdegewpwucdgxa` — the same project
> `DATABASE_URL` already points at. See §2.1.

Source documents:

- `docs/gini-flow-manager.html` — the visual and interaction spec for this build
- `docs/Gini-Flow-Developer-Brief.docx` — read for the architecture, status chain, data model
  and role list that the board depends on

| File                      | Covers                                                                      |
| ------------------------- | --------------------------------------------------------------------------- |
| `00-OVERVIEW.md`          | This file — reconciliation with the existing codebase, decisions to confirm |
| `01-FLOW-MANAGER-PLAN.md` | The task-level build plan for the Flow Manager                              |
| `02-DESIGN-SYSTEM.md`     | Tokens, components and interaction rules extracted from the prototype       |

### Scope now

All 8 prototypes arrived in `docs/Flow-Manage/` (plus an addendum mockup the brief never
mentions). **Phase 2 is now planned in `06-PHASE-2-PLAN.md`** — vitals, reception, lab, MO/SD and
the triage board.

Still unplanned: Phase 3 (doctor list and consult — `gini-doctor-v3.html`,
`gini-doctor-final.html`, plus addendum v1.1) and Phase 4 (pharmacy, referrals, day reports,
MHG hooks).

---

## 1. What the Flow Manager is

One screen for the person running the OPD floor. For today, it shows where every patient is,
how long they have been there, whether that is over budget, where the bottleneck is, and the
full timeline of any one patient — as a kanban board with live SLA timers.

The spine it reads from: **one visit row per patient per day**, plus an **append-only
timestamped event log**. Every timer, colour and average on the board derives from that log —
nothing is stored pre-computed.

This build is **read-only**. Station screens that write status are a later phase, so the board
runs on seeded demo visits plus whatever real `flow_visits` the floor already produces.

---

## 2. Reconciliation with the existing codebase — read this first

The brief was written against assumptions that do not all match this repo. Five gaps, each
with a recommendation. **These need Nikhil's/Gurjot's sign-off before Task 1.1 starts** — they
change the schema and the deploy target.

### 2.1 The Supabase project is `vuukipgdegewpwucdgxa` — the brief is right

Scribe's database **is** a Supabase project. `DATABASE_URL` in `.env` points at
`postgresql://postgres.vuukipgdegewpwucdgxa@aws-1-ap-south-1.pooler.supabase.com:6543/postgres`,
and `SUPABASE_URL` is the same project (used by `server/config/storage.js` and
`server/routes/ai.js`). So the brief's instruction — "add these tables to the existing Scribe
Supabase project, do NOT create a second one" — is correct as written. Build there.

Three Supabase projects appear in `.env`; do not mix them up:

| Project ref            | Env vars                                               | What it is                                        |
| ---------------------- | ------------------------------------------------------ | ------------------------------------------------- |
| `vuukipgdegewpwucdgxa` | `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | **Scribe — this is the one Flow builds on**       |
| `purzqfmfycfowyxfaumc` | `GENIE_SUPABASE_*`, `VITE_GENIE_SUPABASE_*`            | MyHealth Genie patient app — Scribe syncs into it |
| `rxgcvvmeurobuncynjsx` | commented out in `.env`                                | older Genie project, dead                         |

How the app actually talks to it matters for the build:

- The API and worker connect with the **`pg` driver through the connection pooler on port 6543**
  (`server/config/db.js`), not with `supabase-js`. Schema work is therefore plain SQL through
  `node migrations/_runOne.mjs` — the normal repo migration path, not the Supabase dashboard.
- Port 6543 is **transaction pooling** mode. Session-scoped features — `LISTEN`/`NOTIFY`,
  session advisory locks, prepared statements across statements — behave badly or not at all
  through it. The repo has already been burned by this (a switch to port 5432 to fix cron
  advisory locks broke production and was reverted). Any design that reaches for `NOTIFY` to
  push updates needs to account for the pooler first.
- `supabase-js` is currently only wired to the **Genie** project, never to Scribe's.

### 2.2 Realtime is possible, but not free — polling is still the recommendation

Since the database is a Supabase project, Supabase Realtime **is** available in principle, and
this repo already uses it — `src/lib/genieSupabase.js` runs a browser Realtime client for the
Lab/Reception inboxes. But it points at the **Genie** project, and pointing one at Scribe's
project means new work:

- A browser client needs Scribe's **anon key** and `VITE_` env vars — neither exists today
  (only `VITE_GENIE_SUPABASE_*` are defined).
- Browser Realtime respects **RLS**. Scribe's tables are currently reached only with the
  service key through the server, so they have no policies written for anon/authenticated
  access. Exposing `flow_visits` and `flow_events` to a browser subscription means writing and
  auditing RLS policies over live patient data — a GDPR/DPDP-relevant change, not a config flag.
- Scribe's auth is its own JWT system (`auth_sessions`, doctor/patient `kind` claims), not
  Supabase Auth, so there is no Supabase session for RLS to key off without extra plumbing.

**Recommendation: still 10 s polling for this build.** The repo's established pattern is
TanStack Query `refetchInterval` + `refetchIntervalInBackground: false` (`src/OPD.jsx:7010`,
`src/pages/PatientJourneyPage.jsx:40`, `src/queries/hooks/useGhm.js:155`). The board is one
query for the whole day (~20 visits), and the prototype's live feel comes from the client-side
timer ticking every second off `last_event_at`, **not** from the fetch interval — so 10 s
polling is visually indistinguishable from realtime.

Realtime is then a clean upgrade later, once the RLS and anon-key work is scoped deliberately
rather than assumed. Note it is also the _better_ upgrade path than SSE here, because SSE via
`LISTEN`/`NOTIFY` runs into the transaction-pooler problem in 2.1.

### 2.3 A flow system already exists — build separately from it, replace it later

`server/migrations/2026-06-15_flow_management.sql` (+ 8 follow-up migrations) ships
`flow_visits`, `flow_visit_steps`, `flow_events`, `flow_step_catalog`, `flow_visit_types`,
`flow_staff`, `flow_step_templates`. On top of them sit 7 pages (`src/pages/flow/`), ~4,000
lines of `server/routes/flow.js`, `server/services/flow/`, and the public `/visit/:token`
tracker.

**Decision (taken): Gini Flow is built as a separate system. It does not read, write, extend,
import from, or share tables with `flow_*`.** When it is complete and proven on the floor, the
old module is deleted as a unit.

What that means concretely:

| Layer        | Existing (to be retired) | Gini Flow (new)             |
| ------------ | ------------------------ | --------------------------- |
| Tables       | `flow_*`                 | `giniflow_*`                |
| Routes       | `server/routes/flow.js`  | `server/routes/giniflow.js` |
| Services     | `server/services/flow/`  | `server/services/giniflow/` |
| Pages        | `src/pages/flow/`        | `src/pages/giniflow/`       |
| URLs         | `/flow/*`                | `/giniflow/*`               |
| API          | `/api/flow/*`            | `/api/giniflow/*`           |
| Capabilities | `FLOW_*`                 | `GINIFLOW_*`                |

**On the prefix:** `giniflow_`, not `gflow_`. The two systems will live side by side for a
while and the old one ends in a `DROP`; a prefix one character away from `flow_` is a typo
away from dropping the live module. `giniflow_` is unambiguous to read and to grep.

**Shared, because they are the hospital's data and not the module's:** `patients`, `doctors`,
`appointments`. Gini Flow references them by FK exactly as `flow_*` does. This is not coupling
to the old module — it is both modules pointing at the same patient.

**The consequence, stated plainly:** the two systems have no shared spine, so the new board
cannot see patients checked in through the old one. Until Gini Flow has its own check-in, the
board runs on **seeded demo data** (Task 1.11), not the live floor. That is the price of a
clean separation, and it is the right price — a bridge that syncs `flow_visits` into
`giniflow_visits` would be exactly the coupling this decision exists to avoid, and would have
to be built, debugged, and then deleted.

**Retirement path:** Gini Flow reaches feature parity → runs alongside for an agreed period →
the coordinator confirms nothing is missing → `/flow/*` routes, pages, services and tables are
dropped in one migration. Until that day, **no change to `flow_*` is in scope** — the old
module keeps running untouched.

### 2.4 Roles

Brief roles: `flow_manager, reception, vitals, mo_sd, doctor, lab, pharmacy`.
Existing `shared/permissions.js` roles: `admin, consultant, mo, nurse, lab, tech, reception,
coordinator, pharmacy, obt, guest`.

`GRANT_ALL_CAPABILITIES` is now `false` — the matrix is enforced. Any new page or endpoint must
be mapped in `shared/permissions.js` **and** `src/config/routes.js` in the same change, or it
is either invisible or open to everyone.

**Roles are shared; capabilities are not.** A role is a property of the person
(`doctors.role`), so `coordinator` is the same coordinator in both systems and there is no
sense in inventing a second one. But the new pages get their **own** capability keys —
`GINIFLOW_VIEW`, `GINIFLOW_SLA_ADMIN` — rather than borrowing `FLOW_FLOOR_VIEW`. Two reasons:
access to the two boards can be granted independently during the parallel-run period, and
deleting the old module later means deleting every `FLOW_*` key without touching Gini Flow.

### 2.5 The existing floor dashboard is the thing being replaced

`src/pages/flow/FlowCoordinatorPage.jsx` (656 lines) is already "Real-time floor · time
tracking · bottleneck alerts", and `FlowReportsPage.jsx` (520 lines) already does wait-time
analytics. Per 2.3 these are **not** reused, extended, or refactored — the new board is built
clean against the prototype at `/giniflow/manager`, and the old page is deleted when Gini Flow
is ready.

One thing worth doing before it goes: **list what the old page does that the prototype does
not** — station occupancy, the "don't add more" warning per station, per-visit stuck reasons.
Those came from real use on a real floor. Copy the _ideas_ forward into the new board where
they earn their place; do not copy the code.

### 2.6 Separate domain

> `flow.ginihealth.com`, not `flow.scribe.ginihealth.com` — Flow is a peer product to Scribe.

Today this is one Vite SPA + one Express API serving `dist/`. Two options:

- **(A) One app, two hostnames** _(recommended)_ — point `flow.ginihealth.com` at the same
  Railway service; the SPA reads `location.hostname` and renders the Flow shell instead of the
  Scribe shell. Zero infrastructure work, no duplicated auth, no second deploy.
- **(B) Separate Vite app + shared packages** — true separation, but forces extracting auth,
  the API client, patient components and the theme into shared packages first. A week of work
  that ships nothing visible.

**Recommendation:** (A), keeping all Flow code under `src/pages/flow/` and
`server/routes/flow*.js` so (B) stays cheap later.

---

## 3. Decisions needed before the build starts

1. ~~Which database~~ — **answered:** Supabase project `vuukipgdegewpwucdgxa`, reached with `pg`
   through the port-6543 pooler; migrations via `_runOne.mjs` as usual. No longer blocking.
2. ~~Extend `flow_*` or build separately~~ — **answered: build separately** under a
   `giniflow_` namespace; the old module is retired later, untouched until then (2.3).
3. ~~Fixed status chain vs. existing configurable step templates~~ — **moot**: the new system
   owns its own schema, so it uses the brief's fixed chain. The old templates stay where they are.
4. ~~What happens to `/flow/coordinator`~~ — **answered: replaced**, not modified (2.5). Agree
   the parallel-run period and who signs off that parity is reached.
5. Confirm 2.6 — one app on two hostnames vs. a separate SPA. Blocking for Task 1.5 only.
6. Ship a read-only `lab_orders` now so the prototype's Lab track column has data, or ship that column empty? Task 1.2d.
7. Polling (10 s) accepted for this build, with Supabase Realtime as a later upgrade once RLS
   and a Scribe anon key are scoped (2.2)? Non-blocking — polling can ship and be swapped.

Also relevant from the brief's own question list (§5), for later phases but worth settling now:

- HealthRay appointment seed for `booked` — **already solved**: `server/services/cron/healthraySync.js`
  syncs appointments, and `POST /api/flow/from-appointment/:appointmentId` creates a flow visit
  from one. Reuse it; no manual entry needed.
- WATI template approvals — note this repo already sends WhatsApp via **MSG91**
  (`server/services/msg91.js`, `docs/MSG91_SETUP.md`). Confirm WATI vs MSG91 before committing
  to a second vendor and a multi-day approval wait.

---

## 4. Working rules

- **No test suite in this repo.** "Tested" means a smoke script under `server/scripts/`
  (`npm run smoke:*` pattern) plus a manual walkthrough. The plan lists its smoke script as a task.
- `DATABASE_URL` is **production**. Migrations run via `node migrations/_runOne.mjs`, are
  idempotent (`IF NOT EXISTS` / `ON CONFLICT DO NOTHING`), and are additive-only — no drops,
  no destructive alters on `flow_*` while the floor is using it.
- Every task is sized to be finishable and verifiable on its own, per the repo convention of
  small tasks tested one at a time.
- **"Today" means the IST day.** The server runs UTC; use the repo's existing
  `IST_TODAY` idiom (`server/services/ghmDayWindow.js`), never bare `CURRENT_DATE`, or the
  board shows the wrong day between 00:00 and 05:30 IST.
- `npm run format` before committing. Do not commit unless asked.
