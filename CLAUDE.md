# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Gini Clinical Scribe — clinical documentation + patient-flow system for Gini Advanced
Care Hospital (Mohali, India). Voice consultations → AI extraction → structured
prescriptions, plus OPD flow tracking, lab/document ingestion from HealthRay, and a
bi-directional sync with the MyHealth Genie patient app.

`README.md` was rewritten against the current code (2026-08-18) and is a reasonable
orientation for the domain and the three-process split. It is still a document, not the
source of truth — trust the code where they disagree, and update it when you move
something structural.

## Commands

```bash
npm run dev            # prettier --write, then vite (:3000) + server (:3001) concurrently
npm run dev:client     # vite only
npm run dev:server     # nodemon server/index.js  (API only, no cron)
npm run dev:worker     # nodemon server/worker.js (cron/sync jobs only)
npm run build          # vite build → dist/
npm run format         # prettier --write (run before committing)
npm run format:check

# one-off SQL migration (from server/)
node migrations/_runOne.mjs migrations/2026-07-14_patient_identity_health_id.sql

# the only scripted checks that exist (from server/) — end-to-end smoke, hits the real DB
npm run smoke:doctors
npm run smoke:med-collection
```

There is no test suite and no linter. `server/scripts/` and the repo root hold ~100
ad-hoc `.mjs`/`.js` diagnostic and backfill scripts — one-off tools, not runtime code.
To exercise one feature, run its script directly (`node server/scripts/<name>.js`) rather
than looking for a test runner. Put any new one-off in `server/scripts/`; the ~50 loose
scripts at the repo root are historical clutter, not a pattern to follow.

`server/` has its **own `package.json` and `node_modules`** — the API/worker deps are
declared there, the root manifest carries the client plus a duplicate copy for local
`npm run dev`. Adding a backend dep means installing it in `server/`, or the Docker image
(built from `server/`) won't have it.

## Architecture

Three processes, one Postgres:

| Process | Entry | Role |
|---|---|---|
| Client | `src/main.jsx` → `src/router.jsx` | React 18 + Vite, react-router, TanStack Query, Zustand |
| API | `server/index.js` | Express; mounts every `server/routes/*.js` under `/api` |
| Worker | `server/worker.js` | All cron/sync loops (HealthRay, lab, Genie, Sheets) |

Cron lives in the **worker**, not the API, so heavy HealthRay sync can't starve the
API's DB pool or event loop. `RUN_CRON_IN_API=1` falls back to single-process. Two pools
in `server/config/db.js`: `pool` (max 15, user requests) and `cronPool` (max 4,
background) — background work must use `cronPool`.

Frontend layout:
- `src/pages/*.jsx` — one file per route, lazy-loaded via `lazyWithRetry` in `router.jsx`
  (auto-reloads once on stale-chunk errors after a deploy — keep that wrapper).
- `src/stores/*.js` — Zustand, one store per domain (visit, patient, lab, plan, …).
- `src/queries/` — TanStack Query client + `keys.js`; `src/hooks/` for shared hooks.
- `src/services/api.js` — the single axios instance. Attaches `x-auth-token` from
  `localStorage.gini_auth_token`, redirects to `/login` on 401. Use it, don't call
  `fetch`/`axios` directly.
- `src/config/` — clinical constants (lab ranges, drug DB, prompts, route map).
- `src/OPD.jsx` and `src/Companion.jsx` are the two remaining large legacy screens.

Backend layout: `routes/` (HTTP only) → `services/` (domain logic) → `config/db.js`.
Notable service groups: `services/healthray/` (hospital HIS scraping/parsing),
`services/lab/`, `services/cron/`, `services/flow/`, `services/agent/` (SQL-tool agent
with `sqlGuard.js`), `services/medication/`.

### The consultation is a multi-page wizard held in Zustand

A consultation is not one page — it's a sequence of routes that each `navigate()` to the
next, with **all in-progress state living in `src/stores/visitStore.js`** (plus
`vitalsStore`, `examStore`, `labStore`, `planStore`, which `visitStore` reads/resets):

- follow-up: `/fu-load` → `/fu-review` → `/fu-edit` → `/fu-symptoms` → `/fu-gen`
- new patient: `/intake` → `/history-clinical` → `/exam` → `/assess` → `/plan`

The URL carries no visit id. Continuity across reloads and device switches comes from
the `active_visits` table (`/api/active-visit`, `server/routes/active-visits.js`), which
`visitStore` writes fire-and-forget: current `route`, `status`, and a `step_data` JSONB
blob it hydrates back on load. Several doctors/patients can have concurrent in-progress
visits, so every read is scoped by `patient_id` (`syncVisitForPatient`). A new step in
the flow therefore has to be wired in three places: the route list in `router.jsx`, the
store's reset/hydrate paths, and the `step_data` shape. Read `visitStore.js` before
touching any `FU*`/`Intake`/`Exam`/`Assess`/`Plan` page.

### What the worker actually runs

`server/worker.js` starts five independent things, each with its own cadence in
`services/cron/`: the main loop bundle (`cron/index.js` — HealthRay status, partial
visits, lab sync, plus lower-frequency PDF-retry / blank-sweep / stuck-status /
missing-meds / doc-recovery sweeps), `sheetsSync`, `todaysShowSync`, `genieSync`, and
`appointmentInsertListener` (Postgres LISTEN/NOTIFY, not polling). The loops are
self-rescheduling `setTimeout` chains rather than a cron library, so a slow run delays
the next one instead of overlapping it — preserve that shape when editing them.

## Conventions

- ESM everywhere (`"type": "module"`). `.cjs` only where a dep forces it
  (`server/genie-sync.cjs`).
- Prettier is the only formatter: 2 spaces, double quotes, semicolons, width 100,
  trailing commas. `npm run dev` formats on start; run `npm run format` before committing.
- Plain JavaScript + JSX. No TypeScript (`jsconfig.json` has `checkJs: false`).
- Each page/component pairs a `.jsx` with a sibling `.css`; no CSS-in-JS, no Tailwind.
- The codebase is heavily commented with *why* — especially around sync cadences, WAF
  workarounds, and pool timeouts. Match that: when you change a tuned constant, update
  the comment explaining the tradeoff.
- Zod schemas live in `server/schemas/index.js`, used by `middleware/validate.js`.

## Auth & permissions

`shared/permissions.js` is the single source of truth for RBAC — imported by **both**
frontend (`src/config/routes.js` → `PAGE_CAPABILITIES`, `RequireCapability`) and backend
(`server/middleware/auth.js`). Roles map to capabilities; when adding a page or endpoint,
update the capability map on both sides.

⚠️ `GRANT_ALL_CAPABILITIES` is **`false`** as of 2026-08-18 — RBAC is **enforced**. The
`ROLE_CAPABILITIES` matrix now decides real access on both sides, so a mapping mistake
locks people out of production rather than being invisible. Two consequences:

- A route or page added **without** a capability mapping is open to every logged-in role
  (`capabilityForPath` returns null → allowed). Add the mapping in the same change.
- `normalizeRole()` fails closed: an unrecognized `doctors.role` silently becomes `guest`
  (zero capabilities) and that account sees nothing.

Route prefixes may map to a **single** capability or an **array** (any-of, via
`hasAnyCapability`) — `/api/flow` uses the array form because no one capability is common
to every flow role. Setting the flag back to `true` is the emergency bypass that reopens
everything; use it to unblock a lockout, then fix the matrix.

Two read-only checks, neither of which needs the app running:

```bash
node server/scripts/verify-rbac.mjs        # asserts the route→capability matrix
node server/scripts/audit-doctor-roles.mjs # flags stored roles that fall back to guest
```

JWTs (doctor and patient, distinguished by the `kind` claim) are validated against the
`auth_sessions` table, so logout/expiry is real revocation. Accepted via `x-auth-token`,
`Authorization: Bearer`, or `?token=` (the query form exists so image/PDF URLs are
self-authenticating). `PUBLIC_PATHS` / `PUBLIC_PREFIXES` / `PUBLIC_PATTERNS` in
`middleware/auth.js` list the unauthenticated surface — `/api/admin/*` and
`/api/sync/backfill/*` are public prefixes, so be careful what you mount there.

On the client, `/login` and `/visit/:token` (the patient-facing journey tracker, opaque
token, sanitized payload) sit outside `ProtectedRoute`; everything else renders inside
`ProtectedRoute` → `AppLayout` → `RequireCapability`.

## Data & external systems

- **Postgres** — schema in `server/schema.sql`, incremental changes as dated files in
  `server/migrations/`. DATE columns are parsed as strings (see `config/db.js`) to avoid
  timezone off-by-one; don't undo that.
- **HealthRay** — the hospital's HIS. No webhooks, so sync is a self-rescheduling loop
  with deliberately slow cadences (2–3 min) because tighter polling repeatedly tripped
  their WAF into a 403 IP-block. Do not speed these loops up.
- **MyHealth Genie** — patient app on Supabase; sync is non-blocking (`genie-sync.cjs`,
  `services/genieImport.js`), failures log but never fail a consultation save.
- **Supabase Storage** — lab PDFs, images, audio; signed URLs.
- **Anthropic / Deepgram / OpenAI** — extraction and transcription; some keys are
  `VITE_*` and called from the browser.

Env vars load from the **repo-root `.env`** for both API and worker
(`server/loadEnv.js` resolves it relative to `server/`, not cwd). See `.env.example`.

⚠️ The `DATABASE_URL` in `.env` points at **production**. Any script you run against it
touches live patient data — read-only unless the user explicitly asks otherwise, and
never run a destructive `server/scripts/wipe-*`/`fix-*` without confirming first.

## Docs

`docs/` holds the written plans behind the bigger subsystems (`FLOW_MANAGEMENT_PLAN.md`,
`FLOW_INTEGRATION_PLAN.md`, `APPOINTMENT_FLOW.md`, `BILLING_CHECKIN_PLAN.md`,
`OPD_DATA_FRESHNESS_PLAN.md`, `OBT_ROLE_PLAN.md`, MSG91 setup/handoff). They explain
intent that the code doesn't — read the relevant one before reworking flow,
appointments, check-in, or the OBT role (`routes/obt-status.js`).

`docs/medicines-management/` is a five-part spec (`00-overview` → `04-rollout`) covering
the data model, the pharmacy worklist, and doctor report history — read it before
touching `services/medication/`, `routes/medicineCollection.js`, or `routes/refills.js`.

## Deployment

Railway, Docker (`server/Dockerfile`, `server/railway.json`). API and worker deploy as
separate services from the same image with different start commands
(`node index.js` / `node worker.js`). Frontend is a Vite static build served from `dist/`.
