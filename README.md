# Gini Clinical Scribe

Clinical documentation and patient-flow system for **Gini Advanced Care Hospital, Mohali, India**. Turns doctor–patient voice consultations into structured prescriptions, tracks the patient's journey through the OPD floor, ingests labs and documents from the hospital's HIS (HealthRay), and syncs everything to the MyHealth Genie patient app.

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [How a Consultation Works](#how-a-consultation-works)
- [Patient Flow Management](#patient-flow-management)
- [External Systems](#external-systems)
- [Auth & Roles](#auth--roles)
- [Database](#database)
- [API](#api)
- [Environment Variables](#environment-variables)
- [Getting Started](#getting-started)
- [Deployment (Railway)](#deployment-railway)
- [Medicine Matching](#medicine-matching)

---

## Overview

During a consultation, a Medical Officer (MO) and/or Consultant speaks naturally while examining the patient. The system:

1. **Transcribes** the voice (Deepgram streaming or OpenAI Whisper batch)
2. **Extracts** structured medical data with Anthropic Claude — diagnoses, medications, labs, complaints, history
3. **Matches** prescribed medicines to Gini's pharmacy formulary via fuzzy matching
4. **Saves** the consultation to PostgreSQL in a single transaction
5. **Syncs** the visit to the MyHealth Genie patient app (non-blocking)
6. **Tracks** biomarker outcomes (HbA1c, BP, lipids, renal function, …) over time with trend charts

Around that core sit the OPD queue, the patient-flow (station) module, lab and document ingestion from HealthRay, appointment/GHM operations, pharmacy medicine collection, and a set of patient-facing request inboxes (refills, dose changes, lab requests, side effects).

---

## Architecture

Three processes share one PostgreSQL database:

| Process | Entry point | Role |
|---|---|---|
| **Client** | `src/main.jsx` → `src/router.jsx` | React 18 + Vite SPA. react-router, TanStack Query, Zustand |
| **API** | `server/index.js` | Express. Mounts every `server/routes/*.js` under `/api`, and serves the built SPA from `dist/` |
| **Worker** | `server/worker.js` | All cron/sync loops — HealthRay, lab, Genie, Google Sheets |

```
        Browser (React SPA)
   Deepgram / Whisper / Claude  <-- called directly from the browser for
              |                     transcription + extraction
              |  /api  (axios, x-auth-token)
              v
   +---------------------------+          +---------------------------+
   |  API  (server/index.js)   |          | Worker (server/worker.js) |
   |  routes/ -> services/     |          |  services/cron/*          |
   |  pool: max 15             |          |  cronPool: max 4          |
   +------------+--------------+          +-------------+-------------+
                |                                       |
                +------------------+--------------------+
                                   v
                          PostgreSQL (Railway)
                                   |
        +--------------------------+--------------------------+
        |                |                  |                 |
   Supabase Storage   HealthRay        MyHealth Genie     Google Sheets
   (PDFs, images,     (hospital HIS:   (patient app,      (appointment
    audio; signed     appointments,     Supabase RPC)      imports)
    URLs)             labs, docs)
```

Cron runs in the **worker**, not the API, so a heavy HealthRay sync can't starve the API's connection pool or event loop. `RUN_CRON_IN_API=1` collapses both back into one process for local work. `server/config/db.js` exports two pools accordingly: `pool` (user requests) and `cronPool` (background jobs).

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, Vite 5, react-router 7, TanStack Query 5, Zustand 5, Recharts |
| Backend | Node.js 20, Express 4, Zod (validation), pg |
| Database | PostgreSQL (Railway) |
| File storage | Supabase Storage (signed URLs) |
| Speech-to-text | Deepgram (streaming), OpenAI Whisper (batch) |
| AI | Anthropic Claude — extraction, vision OCR, Rx review, summaries, SQL agent |
| Scraping / PDF | Puppeteer (HealthRay report rendering), pdfkit, pdfjs-dist |
| Messaging | MSG91 (WhatsApp), Firebase (push) |
| Deployment | Railway (Docker) |

No TypeScript, no test runner, no linter. Prettier is the only formatter.

---

## Project Structure

```
gini-scribe/
├── src/                       # React SPA
│   ├── main.jsx               # entry — mounts router
│   ├── router.jsx             # every route, lazy-loaded via lazyWithRetry
│   ├── pages/                 # one file per route (+ a sibling .css each)
│   │   └── flow/              # patient-flow screens (checkin, coordinator, station, …)
│   ├── companion/             # mobile document-capture screens
│   ├── components/            # shared UI + AppLayout / ProtectedRoute / RequireCapability
│   ├── stores/                # Zustand, one store per domain (visit, patient, lab, plan, …)
│   ├── queries/               # TanStack Query client + key factory
│   ├── services/api.js        # the single axios instance (auth header, 401 -> /login)
│   ├── config/                # clinical constants: lab ranges, drug DB, prompts, route map
│   ├── medmatch.js            # fuzzy medicine matcher
│   ├── medicine_db.json       # Gini pharmacy formulary (~6,900 brands)
│   ├── OPD.jsx, Companion.jsx # the two remaining large legacy screens
│   └── styles/, hooks/, utils/, lib/
│
├── server/                    # API + worker (its own package.json / node_modules)
│   ├── index.js               # Express app; mounts routes/*, serves ../dist
│   ├── worker.js              # starts the cron loops
│   ├── routes/                # HTTP layer only (~44 files)
│   ├── services/              # domain logic
│   │   ├── healthray/         # hospital HIS scraping + parsing
│   │   ├── lab/               # labapi.healthray.com ingestion
│   │   ├── cron/              # every scheduled loop
│   │   ├── flow/              # patient-flow state machine
│   │   ├── agent/             # SQL-tool AI agent (with sqlGuard.js)
│   │   └── medication/        # reconciliation, auto-stop, refills
│   ├── middleware/auth.js     # JWT + capability enforcement
│   ├── schemas/index.js       # Zod request schemas
│   ├── config/db.js           # pool + cronPool
│   ├── schema.sql             # base schema
│   ├── migrations/            # dated incremental SQL (+ _runOne.mjs runner)
│   └── scripts/               # ~70 one-off diagnostic / backfill scripts
│
├── shared/permissions.js      # RBAC source of truth — imported by BOTH sides
├── docs/                      # design docs for flow, appointments, billing, MSG91
└── *.mjs, *.js (repo root)    # more one-off scripts; not runtime code
```

---

## How a Consultation Works

```
Doctor speaks during examination
         |
  [Deepgram / Whisper]        real-time or batch transcription
         |
  [Anthropic Claude]          structured extraction against a JSON schema
         |
  Diagnoses / medications / investigations / complaints / history
         |
  [medmatch.js]               fuzzy match to Gini pharmacy brands
         |
  Doctor reviews & edits across the wizard steps
         |
  [POST /api/consultations]   atomic save (BEGIN … COMMIT)
         |
    +----+----+
    |         |
  PostgreSQL  Genie sync (non-blocking — failures log, never fail the save)
```

A consultation is **not a single page**. It is a sequence of routes that each navigate to the next:

- **Follow-up:** `/fu-load` → `/fu-review` → `/fu-edit` → `/fu-symptoms` → `/fu-gen`
- **New patient:** `/intake` → `/history-clinical` → `/exam` → `/assess` → `/plan`

In-progress state lives in `src/stores/visitStore.js` (with `vitalsStore`, `examStore`, `labStore`, `planStore` alongside it). The URL carries no visit id — continuity across reloads and devices comes from the `active_visits` table, which the store updates fire-and-forget with the current `route`, `status`, and a `step_data` JSONB blob it hydrates back on load. Several patients can have concurrent in-progress visits, so reads are scoped by `patient_id`.

Also on the clinical side: **Quick mode** (one voice pass producing both MO and Consultant data), **Lab Portal** (upload a report image, Claude vision OCR extracts values and flags), **Rx Review** (AI check for interactions and dosing), **Clinical Reasoning** (audio-recorded decision rationale), **Outcomes** (biomarker trend charts), and **Clinical Intelligence** (aggregate analytics by doctor, diagnosis, and period).

---

## Patient Flow Management

Tracks a patient physically moving through the OPD, from check-in to pharmacy exit. Screens under `/flow/*`:

| Route | Who uses it |
|---|---|
| `/flow/checkin` | Reception — check the patient in and build their journey |
| `/flow/coordinator` | Floor coordinator — live dashboard of everyone in the building |
| `/flow/station/:role` | Station queues — vitals, MO, lab, dietitian, Rx |
| `/flow/reports` | Wait-time and bottleneck analytics |
| `/flow/admin` | Journey templates and station configuration |
| `/visit/:token` | **Public** — the patient's own journey tracker (opaque token, no login) |

Server side lives in `server/services/flow/` and `server/routes/flow.js`. The design rationale is in `docs/FLOW_MANAGEMENT_PLAN.md` and `docs/FLOW_INTEGRATION_PLAN.md`.

---

## External Systems

**HealthRay** — the hospital's HIS, and the authoritative source for appointments, visit completion, labs, and scanned documents. It has no webhooks, so sync is a set of self-rescheduling loops in `server/services/cron/`. The cadences are deliberately slow (roughly 2–3 minutes): tighter polling repeatedly tripped HealthRay's WAF into a 403 IP-block. `HEALTHRAY_PROXY_URL` points all HealthRay traffic through a static-IP proxy so the IP can be allowlisted — that is the permanent fix. `labapi.healthray.com` is a **separate** system from `node.healthray.com` with its own credentials and its own loop.

**MyHealth Genie** — the patient-facing app, on Supabase. Sync is bi-directional (`server/genie-sync.cjs`, `server/services/genieImport.js`) and always non-blocking: patient profile, care team, medications, labs, diagnoses, goals, lifestyle advice, self-monitoring. Patients raise refill, dose-change, lab and side-effect requests there; those land in the corresponding inbox pages here.

**Supabase Storage** — lab PDFs, document images, and audio, served as signed URLs.

**Google Sheets** — appointment imports, on its own cron loop.

**MSG91 / Firebase** — WhatsApp templates and push notifications (see `docs/MSG91_SETUP.md`).

---

## Auth & Roles

`shared/permissions.js` is the single source of truth for RBAC, imported by **both** the frontend (`src/config/routes.js` → `RequireCapability`) and the backend (`server/middleware/auth.js`). Roles — admin, consultant, mo, nurse, lab, tech, reception, coordinator, pharmacy, guest — map to coarse capabilities (`CLINICAL_WRITE`, `LAB_PORTAL`, `RECEPTION_OPS`, `FLOW_STATION`, …). Adding a page or endpoint means updating the map on both sides.

> Note: `GRANT_ALL_CAPABILITIES` is currently `true`, which short-circuits every capability check. The `ROLE_CAPABILITIES` matrix is maintained but not yet enforced; set the flag to `false` to turn it on.

JWTs come in two kinds — doctor and patient, distinguished by a `kind` claim — and are validated against the `auth_sessions` table, so logout and expiry are real revocation. A token is accepted as `x-auth-token`, `Authorization: Bearer`, or `?token=` (the query form exists so image and PDF URLs are self-authenticating). The unauthenticated surface is listed explicitly as `PUBLIC_PATHS` / `PUBLIC_PREFIXES` / `PUBLIC_PATTERNS` in `server/middleware/auth.js`.

On the client, only `/login` and `/visit/:token` sit outside `ProtectedRoute`; everything else renders inside `ProtectedRoute` → `AppLayout` → `RequireCapability`.

---

## Database

`server/schema.sql` holds the base schema — `patients`, `doctors`, `consultations`, `vitals`, `diagnoses`, `medications`, `lab_results`, `lab_test_requests`, `documents`, `goals`, `complications`, `active_visits`, and the patient-app log tables (`patient_vitals_log`, `patient_activity_log`, `patient_symptom_log`, `patient_med_log`, `patient_meal_log`), plus the views `v_latest_vitals`, `v_latest_hba1c`, `v_active_meds`, `v_patient_summary`.

Everything since — appointments, auth sessions, flow tables, doctor scheduling, medicine collection — arrives as dated files in `server/migrations/`. **`schema.sql` alone is not a current database**; it is the starting point that the migrations build on.

```bash
# from server/ — apply one migration
node migrations/_runOne.mjs migrations/2026-07-14_patient_identity_health_id.sql
```

Two things worth knowing before writing queries:

- DATE columns are parsed as **strings** (configured in `config/db.js`) to avoid timezone off-by-one errors.
- Patient identity keys on `health_id`, not `file_no` — HealthRay reassigns UHIDs to different people over time.

---

## API

Every file in `server/routes/` is mounted under `/api`, so paths are flat rather than nested by router. A representative slice:

| Area | Endpoints |
|---|---|
| Auth | `POST /api/auth/login`, `/api/auth/logout`, `GET /api/auth/me`, plus patient-side `/api/patient/auth/*` |
| Patients | `GET/POST /api/patients`, `GET /api/patients/:id`, `/api/patients/check-duplicate` |
| Consultations | `POST /api/consultations` (transactional), `GET /api/consultations/:id`, `/:id/prescription` |
| Clinical data | `/api/patients/:id/vitals`, `/labs`, `/medications`, `/documents`, `/history` |
| Active visit | `GET/POST/PUT/DELETE /api/active-visit`, `GET /api/active-visits` |
| Flow | `/api/flow/*` — check-in, stations, journeys, active visits, reports |
| OPD & appointments | `/api/opd/*`, `/api/appointments`, `/api/appointment-slots`, `/api/walkins`, `/api/ghm-appointments` |
| Patient requests | `/api/refills`, `/api/dose-change-requests`, `/api/lab-requests`, `/api/side-effects` |
| Analytics | `/api/outcomes/*`, `/api/reports/*`, `/api/dashboard/*` |
| AI | `/api/ai/*`, `/api/extract/*`, `/api/reasoning/*`, `/api/genie-chat/*`, `/api/summary/*` |
| Sync | `/api/sync/*` — HealthRay/Genie sync triggers and backfills |

Request bodies are validated with Zod schemas from `server/schemas/index.js` via `middleware/validate.js`.

---

## Environment Variables

Both the API and the worker load the **repo-root `.env`** (`server/loadEnv.js` resolves it relative to `server/`, not the working directory). There is no separate `server/.env`. `VITE_*` variables are inlined into the browser bundle at build time. See `.env.example` for the full annotated list.

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `PORT` | No | API port (default 3001); also the Vite dev port (default 3000) |
| `JWT_SECRET` / `JWT_EXPIRES_IN` | Yes | Session token signing |
| `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` | Yes | File storage |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DEEPGRAM_API_KEY` | Yes | Server-side AI and transcription |
| `VITE_ANTHROPIC_KEY`, `VITE_DEEPGRAM_KEY`, `VITE_OPENAI_KEY` | Yes | Browser-side extraction and transcription |
| `GENIE_SUPABASE_URL` / `GENIE_SUPABASE_SERVICE_KEY` | No | Genie sync; disabled with a warning if unset |
| `VITE_GENIE_SUPABASE_URL` / `VITE_GENIE_SUPABASE_ANON_KEY` | No | Browser Supabase client for the realtime lab/reception inboxes |
| `HEALTHRAY_MOBILE` / `_PASSWORD` / `_CAPTCHA` / `_ORG_ID` | No | HealthRay HIS login |
| `HEALTHRAY_PROXY_URL` | No | Static-IP egress proxy — the permanent fix for WAF 403 blocks |
| `LAB_HEALTHRAY_*` | No | Credentials and rate limits for the separate lab API |
| `GOOGLE_CREDENTIALS` | No | Service-account JSON for Sheets appointment import |
| `MSG91_*`, `FIREBASE_SERVICE_ACCOUNT` | No | WhatsApp and push notifications |
| `HOSPITAL_PHONE` / `HOSPITAL_NAME` | No | Shown on the patient chat's "call clinic" card |
| `RUN_CRON_IN_API` | No | `1` runs cron inside the API process instead of the worker |
| `AADHAAR_ENCRYPTION_KEY` | No | Encrypts stored Aadhaar numbers |

---

## Getting Started

### Prerequisites

Node.js >= 20, a PostgreSQL instance, and API keys for Anthropic, Deepgram, and (optionally) OpenAI.

### Install

```bash
npm install                    # client + dev tooling
cd server && npm install       # API/worker deps live in their own manifest
```

### Configure

Copy `.env.example` to `.env` in the repo root and fill it in. One file serves the client, API, and worker.

### Initialize the database

```bash
node server/db-init.js         # applies server/schema.sql
# then apply each file in server/migrations/ in date order:
cd server && node migrations/_runOne.mjs migrations/<file>.sql
```

### Run

```bash
npm run dev          # formats, then runs Vite (:3000) + API (:3001) together
npm run dev:client   # Vite only
npm run dev:server   # API only (nodemon, no cron)
npm run dev:worker   # cron/sync loops only
```

Vite proxies `/api` to `http://localhost:3001` (override with `VITE_DEV_API_URL`).

### Other commands

```bash
npm run build          # vite build -> dist/
npm run format         # prettier --write  (run before committing)
npm run format:check

# from server/ — the only scripted checks in the repo
npm run smoke:doctors
npm run smoke:med-collection
```

There is no test suite and no linter. `server/scripts/` and the repo root hold ~100 ad-hoc `.mjs`/`.js` diagnostic and backfill scripts; run one directly with `node`.

> ⚠️ The `DATABASE_URL` in `.env` points at **production**. Any script you run against it touches live patient data.

---

## Deployment (Railway)

The API and the worker deploy as **two Railway services built from the same image** (`server/Dockerfile`, `server/railway.json`), differing only in start command: `node index.js` and `node worker.js`. Running two workers would double every sync loop.

The frontend is a Vite static build; the API serves `dist/` for any non-`/api` path, so it does not need a separate service.

1. Create the PostgreSQL instance and copy its `DATABASE_URL`.
2. Deploy the API service with root directory `server`; Railway builds the Dockerfile.
3. Deploy the worker service from the same repo, start command `node worker.js`.
4. Set the environment variables on both services.
5. Build the frontend (`npm run build`) so `dist/` ships with the image.

---

## Medicine Matching

`src/medmatch.js` maps AI-extracted drug names onto the Gini pharmacy formulary in `src/medicine_db.json` (~6,900 brands).

```
AI extracts: "Tab Metformin 500mg BD"
      |
  Normalize    uppercase, strip punctuation, drop form words (TAB/CAP/INJ/SYP)
      |
  Score every formulary entry
      exact match            = 100
      first-word exact       = +20 bonus + Levenshtein similarity
      token overlap (>2 chr) = +10 per token + similarity
      full-string Levenshtein= baseline
      |
  Best score above threshold?
      yes -> {brand: "METFORMIN", form: "tablet", dose: "500mg", confidence}
      no  -> unmatched; the doctor picks manually
```

Each formulary entry looks like:

```json
{
  "raw": "THYRONORM 88MCG",
  "brand": "THYRONORM",
  "form": "tablet",
  "dose": "88MCG",
  "search": "thyronorm 88mcg tablet"
}
```

Exports: `matchMedicine(name)`, `fixMoMedicines(moData)`, `fixConMedicines(conData)`, `fixQuickMedicines(data)`, `searchPharmacy(query, limit)`.

A related rule lives on the server: when a new consultation is saved, previously active medications from the same doctor that are absent from the new plan are automatically stopped (`server/services/medication/`).

---

## License

Proprietary — Gini Advanced Care Hospital.
