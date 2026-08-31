# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Gini Clinical Scribe — clinical documentation and patient-flow system for Gini Advanced Care Hospital, Mohali. Turns doctor–patient voice consultations into structured prescriptions, tracks patients physically through the OPD floor, ingests labs/documents from the hospital's HIS (HealthRay), and syncs to the MyHealth Genie patient app. The core value: surface patient history, current reports, and vitals on one page so doctors decide faster and can see more patients per day.

Roles: admin, consultant, mo (medical officer), nurse, lab, tech, reception, coordinator, pharmacy, obt (call/lead/appointment-confirmation team, works the `/ghm` sheet), guest. Must stay GDPR/DPDP-compliant (patient data handling, Aadhaar encryption, access control).

`README.md` has the full write-up (architecture diagram, consultation flow, patient-flow routes, external systems, full env var table, API surface, medicine matching algorithm) — read it before making non-trivial changes; this file only adds what the README doesn't.

## Commands

```bash
npm install && cd server && npm install   # two separate node_modules — client and server/worker

npm run dev          # prettier + Vite (:3000) + API (:3001) together
npm run dev:client   # Vite only
npm run dev:server   # API only (nodemon, no cron)
npm run dev:worker   # cron/sync loops only

npm run build          # vite build -> dist/
npm run format          # prettier --write, run before committing
npm run format:check

# from server/ — the only scripted checks in the repo
npm run smoke:doctors
npm run smoke:med-collection

# apply one migration (from server/)
node migrations/_runOne.mjs migrations/<file>.sql
```

There is **no test suite and no linter** — Prettier is the only automated check. `server/scripts/` holds ~70 ad-hoc diagnostic/backfill scripts; run individually with `node`. Put new one-offs there, not in the repo root.

⚠️ `DATABASE_URL` in `.env` points at **production**. Any script or query you run touches live patient data — there is no separate dev/staging database. Treat migrations, backfills, and one-off scripts accordingly.

## Architecture

Three processes, one Postgres database:
- **Client** (`src/main.jsx` → `src/router.jsx`) — React 18 + Vite SPA, react-router, TanStack Query, Zustand.
- **API** (`server/index.js`) — Express; every `server/routes/*.js` mounted flat under `/api`; also serves the built SPA from `dist/`.
- **Worker** (`server/worker.js`) — all cron/sync loops (HealthRay, lab API, Genie, Google Sheets). Runs separately from the API so a slow HealthRay sync can't starve request handling; `server/config/db.js` exposes two pools (`pool` for requests, `cronPool` for background jobs). `RUN_CRON_IN_API=1` collapses both into one process for local dev.

Routes are HTTP-only and delegate to `server/services/*` for domain logic (`healthray/`, `lab/`, `cron/`, `flow/`, `agent/` SQL-tool AI agent, `medication/`). Request bodies validate against `server/schemas/index.js` (Zod) via `middleware/validate.js`.

**RBAC**: `shared/permissions.js` is the single source of truth, imported by both the frontend (`src/config/routes.js` → `RequireCapability`) and backend (`server/middleware/auth.js`). Adding a page or endpoint means updating capabilities on both sides. Note: `GRANT_ALL_CAPABILITIES` is currently `true` and short-circuits all capability checks — the matrix is maintained but not enforced yet.

**Auth**: JWTs are doctor or patient kind (a `kind` claim), validated against `auth_sessions` for real revocation on logout/expiry. Accepted as `x-auth-token`, `Authorization: Bearer`, or `?token=` (query form so image/PDF URLs can self-authenticate). Public paths are listed explicitly in `server/middleware/auth.js`.

**Consultation flow**: voice → Deepgram/Whisper transcription → Claude structured extraction → `src/medmatch.js` fuzzy-matches drugs against `src/medicine_db.json` (~6,900 brands) → doctor reviews across a multi-page wizard → `POST /api/consultations` saves atomically (BEGIN…COMMIT) → non-blocking Genie sync. A consultation is a sequence of routes, not one page (new patient: `/intake → /history-clinical → /exam → /assess → /plan`; follow-up: `/fu-load → /fu-review → /fu-edit → /fu-symptoms → /fu-gen`). In-progress state lives in `src/stores/visitStore.js` + sibling stores, persisted fire-and-forget to `active_visits` (route/status/`step_data` JSONB) so it survives reloads/devices; there is no visit id in the URL, so reads scope by `patient_id`.

**Patient flow** (`/flow/*`, `server/services/flow/`, `server/routes/flow.js`): tracks a patient physically moving check-in → vitals/MO/lab/dietitian/Rx stations → pharmacy exit. `/visit/:token` is the public patient-facing journey tracker (opaque token, no login).

**HealthRay** is the authoritative source for appointments, visit completion, labs, and scanned documents — it has no webhooks, so sync is self-rescheduling polling loops in `server/services/cron/`, deliberately slow (~2-3 min) because tight polling trips its WAF into a 403 IP-block; `HEALTHRAY_PROXY_URL` routes traffic through a static-IP proxy as the permanent fix. `labapi.healthray.com` is a separate system with separate credentials from `node.healthray.com`. Patient identity keys on `health_id`, not `file_no` (UHID) — HealthRay reassigns UHIDs to different people over time.

**Database**: `server/schema.sql` is only the starting point — real schema is `schema.sql` + every dated file in `server/migrations/` applied in order. DATE columns parse as strings (configured in `config/db.js`) to avoid timezone off-by-one errors.

**Env**: both API and worker load the repo-root `.env` (`server/loadEnv.js` resolves it relative to `server/`) — there is no `server/.env`. `VITE_*` vars are inlined into the browser bundle at build time.

## Conventions

- No comments in code — names should carry meaning; keep code minimal and clean.
- Before writing new code, check for existing utilities/components/services that already do it (`src/lib`, `src/utils`, `src/services`, `server/services`) rather than duplicating.
- Use correct semantic HTML (e.g. `<button>` for clickable actions, not a `div` with `onClick`).
- Follow MVC-style separation: routes (HTTP) → services (domain logic) → db; keep components/pages modular.
- Break work into small tasks; test each one before moving to the next rather than doing one large change.
- Do not commit or push to git unless explicitly asked.
