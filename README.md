# Gini Clinical Scribe

AI-powered clinical documentation system for **Gini Advanced Care Hospital, Mohali, India**. Converts doctor-patient voice conversations into structured prescriptions, tracks patient outcomes over time, and syncs data to the MyHealth Genie patient app.

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [File-by-File Breakdown](#file-by-file-breakdown)
- [Features](#features)
- [Database Schema](#database-schema)
- [API Endpoints](#api-endpoints)
- [Environment Variables](#environment-variables)
- [Getting Started](#getting-started)
- [Deployment (Railway)](#deployment-railway)
- [How It Works](#how-it-works)

---

## Overview

Gini Scribe is a full-stack clinical documentation assistant. During a patient consultation, a Medical Officer (MO) and/or Consultant speaks naturally while examining the patient. The system:

1. **Transcribes** the voice in real-time (Deepgram streaming or OpenAI Whisper batch)
2. **Extracts** structured medical data using AI (Anthropic Claude) — diagnoses, medications, labs, complaints, history
3. **Matches** prescribed medicines to Gini's pharmacy formulary using fuzzy matching (Levenshtein distance)
4. **Saves** the structured consultation to PostgreSQL with full audit trail
5. **Syncs** visit data to the MyHealth Genie patient-facing app (non-blocking)
6. **Tracks** biomarker outcomes (HbA1c, BP, lipids, renal function, etc.) over time with trend charts

---

## Architecture

```
+---------------------------------------------------------------+
|                  Frontend (React + Vite)                       |
|                                                                |
|  App.jsx ........... Main clinical interface (11,960 lines)    |
|  Companion.jsx ..... Mobile document capture app               |
|  medmatch.js ....... Fuzzy medicine matcher                    |
|  medicine_db.json .. 6,931 pharmacy brands                     |
|                                                                |
|  External APIs (called from browser):                          |
|    - Deepgram (streaming speech-to-text)                       |
|    - OpenAI Whisper (batch speech-to-text)                     |
|    - Anthropic Claude (structured extraction, Rx review, CI)   |
+---------------------------------------------------------------+
                           |
                    REST API calls
                           |
+---------------------------------------------------------------+
|                 Backend (Express + Node.js)                     |
|                                                                |
|  server/index.js ..... REST API (1,537 lines)                  |
|  server/genie-sync.cjs MyHealth Genie bi-directional sync      |
|  server/schema.sql ... PostgreSQL table definitions             |
|  server/db-init.js ... Schema bootstrap script                  |
+---------------------------------------------------------------+
                     |              |
              +------+------+  +---+-------------+
              | PostgreSQL  |  | Supabase        |
              | (Railway)   |  | Storage (files) |
              |             |  |                 |
              | patients    |  | Lab images      |
              | consults    |  | Prescriptions   |
              | vitals      |  | X-rays, MRIs    |
              | medications |  | Audio recordings|
              | lab_results |  +-----------------+
              | diagnoses   |
              | documents   |
              | goals       |
              | complications|
              +-------------+
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18, Vite 5, Recharts (charts) |
| Backend | Node.js, Express 4 |
| Database | PostgreSQL (Railway) |
| File Storage | Supabase Storage (signed URLs, 1-hour expiry) |
| Speech-to-Text | Deepgram (streaming), OpenAI Whisper (batch) |
| AI Extraction | Anthropic Claude (structured JSON, vision for images) |
| Deployment | Railway (Docker), Vite dev server |
| Sync | MyHealth Genie (Supabase RPC) |

---

## Project Structure

```
gini-scribe/
+-- index.html              # HTML entry point (loads Inter font)
+-- package.json             # Frontend dependencies
+-- vite.config.js           # Vite config (host 0.0.0.0, port from $PORT)
|
+-- src/
|   +-- main.jsx             # Entry point — path-based routing (/ -> App, /companion -> Companion)
|   +-- App.jsx              # Main clinical interface (11,960 lines)
|   +-- Companion.jsx        # Mobile document capture companion app (621 lines)
|   +-- medmatch.js          # Fuzzy medicine name matcher (155 lines)
|   +-- medicine_db.json     # Gini pharmacy formulary database (6,931 medicines)
|
+-- server/
|   +-- index.js             # Express REST API server (1,537 lines)
|   +-- schema.sql           # PostgreSQL schema (10 tables, 4 views, triggers)
|   +-- db-init.js           # Database initialization script
|   +-- genie-sync.cjs       # MyHealth Genie sync module (196 lines)
|   +-- package.json         # Server dependencies (express, pg, cors, sharp)
|   +-- Dockerfile           # Docker image for Railway deployment
|   +-- railway.json         # Railway deployment config
|   +-- SETUP.md             # Detailed deployment guide
|   +-- .gitignore           # Server-specific ignores
|
+-- *.py                     # One-off patch/migration scripts (not part of runtime)
```

---

## File-by-File Breakdown

### `src/App.jsx` (11,960 lines) — Main Clinical Interface

The core of the application. A single large React component implementing the entire clinical workflow.

**Key Sections:**

| Section | What It Does |
|---------|-------------|
| **Authentication** | PIN-based doctor login, JWT token stored in localStorage |
| **Patient Setup** | Create/search patients with deduplication (phone, file_no, name+age+sex) |
| **MO Tab** | Medical Officer records voice -> Deepgram/Whisper transcribes -> Claude extracts diagnoses, complaints, history, medications, investigations |
| **Consultant Tab** | Consultant dictates treatment plan -> Claude extracts assessment, medications, diet/lifestyle, goals, monitoring |
| **Quick Mode** | Single-step voice input that outputs both MO + Consultant data at once |
| **Lab Portal** | Upload lab report images -> Claude vision OCR extracts test values, flags, reference ranges |
| **Imaging Portal** | Upload X-ray/ultrasound/CT/MRI documents with metadata |
| **History Entry** | Bulk import of previous consultations from scanned prescriptions |
| **Outcomes Tab** | Biomarker trend charts (HbA1c, FBS, PPBS, LDL, HDL, creatinine, eGFR, TSH, BP, weight, BMI) using Recharts |
| **Clinical Reasoning** | Audio recording of doctor's clinical decision-making rationale |
| **Rx Review** | AI analysis of prescription for drug interactions, dosage appropriateness, severity flagging |
| **Clinical Intelligence** | Aggregate analytics — diagnoses distribution, top medications, outcomes by doctor/period |
| **Appointments** | Schedule/track patient appointments, mark completed |
| **Print View** | Professional formatted prescription document (CSS print styles) |

**Key Algorithms:**

- **Audio Transcription:** Dual-engine support — Deepgram for real-time streaming with medical keyword boosting (HbA1c, eGFR, metformin, etc.), OpenAI Whisper for batch processing with language selection (English, Hindi, multilingual)
- **AI Extraction:** Sends transcript to Claude with structured JSON schema prompts, validates response format, falls back gracefully on parse errors
- **Medicine Matching:** Calls `medmatch.js` to fuzzy-match extracted drug names against pharmacy formulary with confidence scoring (threshold > 65)
- **Medication Auto-Stop:** When saving a new consultation, previous active meds from the same doctor are automatically stopped if not present in the new plan
- **Biomarker Filtering:** Maps specific drugs to relevant lab tests (e.g., SGLT2i -> eGFR monitoring) for clinical intelligence

---

### `src/Companion.jsx` (621 lines) — Mobile Document Capture

A separate mobile-friendly interface accessible at `/companion` for patients/staff to capture and upload medical documents.

**Capabilities:**
- Browse patients (searchable, limit 50)
- Camera capture or file upload
- Document categorization (prescription, blood_test, thyroid, lipid, kidney, hba1c, urine, x-ray, ultrasound, MRI, DEXA, ECG, NCS, eye, other)
- AI extraction via Claude vision API — extracts structured data from prescription/lab images
- Patient name mismatch warning
- Saves history entries, individual lab values, and document records to the backend
- Retry logic with exponential backoff on API rate limits (3 retries, 529 status)

---

### `src/medmatch.js` (155 lines) — Fuzzy Medicine Matcher

Matches AI-extracted medicine names to the official Gini pharmacy formulary.

**Algorithm:**
1. **Normalize** input: uppercase, strip special characters, remove form abbreviations (TAB, CAP, INJ, SYP)
2. **Score** each pharmacy entry:
   - Exact match = 100
   - First-word exact match = +20 bonus + Levenshtein similarity
   - Token overlap (tokens > 2 chars) = +10 per token + similarity
   - Full-string Levenshtein = baseline score
3. **Return** best match if confidence > 60

**Exports:**
- `matchMedicine(name)` — Returns `{matched, brand, form, dose, confidence}`
- `fixMoMedicines(moData)` — Enhance MO-extracted medications
- `fixConMedicines(conData)` — Enhance consultant-extracted medications
- `fixQuickMedicines(data)` — Fix medications in quick mode
- `searchPharmacy(query, limit)` — Search pharmacy DB with scoring

---

### `src/medicine_db.json` — Pharmacy Formulary

JSON array of **6,931 medicines** available at Gini Hospital pharmacy. Each entry:

```json
{
  "raw": "THYRONORM 88MCG",
  "brand": "THYRONORM",
  "form": "tablet",
  "dose": "88MCG",
  "search": "thyronorm 88mcg tablet"
}
```

---

### `src/main.jsx` (12 lines) — Entry Point

Simple path-based router (no react-router dependency):
- `/` renders `<App />` (main clinical interface)
- `/companion` renders `<Companion />` (mobile document capture)

---

### `server/index.js` (1,537 lines) — Express REST API

The backend server handling all data persistence, authentication, and analytics.

**Key Design Decisions:**
- **Connection Pool:** pg.Pool with 10 max connections, 20s connect timeout, 30s idle timeout
- **SSL:** Auto-enabled for Railway (non-internal) PostgreSQL connections
- **Transactions:** Full consultation save is ACID-compliant (BEGIN → multiple inserts → COMMIT/ROLLBACK)
- **Deduplication:** Uses PostgreSQL `DISTINCT ON` for medications, labs, and diagnoses
- **Audit Logging:** Logs doctor actions (login, consultation save)
- **Non-Blocking Sync:** Genie integration runs after commit, errors don't fail the save

**Helper Functions:**
- `n(v)` — Null-safe string trim
- `num(v)` / `int(v)` — Safe number parsing
- `safeJson(v)` — JSON stringify with error protection
- `t(v, max)` — Truncate to max length

---

### `server/schema.sql` (263 lines) — Database Schema

Defines 10 tables, 4 views, and auto-update triggers.

**Tables:**

| Table | Key Fields | Purpose |
|-------|-----------|---------|
| `patients` | name, age, sex, phone, file_no, abha_id, aadhaar | Patient demographics with unique constraints |
| `doctors` | name, speciality, pin, role (MO/Consultant/Surgeon) | Doctor accounts with PIN auth |
| `consultations` | patient_id, doctor_id, mo_data (JSONB), con_data (JSONB), status | Full visit records with transcripts |
| `vitals` | bp_sys, bp_dia, pulse, temp, spo2, weight, height, bmi, rbs | Per-visit vital signs |
| `diagnoses` | diagnosis_id (dm2/htn/cad/ckd/...), status (Controlled/Uncontrolled/New/Resolved) | Active conditions tracking |
| `medications` | brand, composition, dose, frequency, timing, route, for_diagnosis[], is_active | Prescription history with active tracking |
| `lab_results` | test_name, value, unit, flag (HIGH/LOW), reference_range, source | Lab values with dedup by test+date |
| `documents` | doc_type, storage_path, extracted_data (JSONB) | Uploaded files (images, PDFs) |
| `goals` | metric, current_value, target_value, status | Health targets with progress |
| `complications` | name (Nephropathy/Retinopathy/...), status (+/-/screening), severity | DM/HTN complication tracking |

**Views:**
- `v_latest_vitals` — Most recent vitals per patient
- `v_latest_hba1c` — Most recent HbA1c per patient
- `v_active_meds` — Currently active medications per patient
- `v_patient_summary` — Patient + visit count + diagnoses summary

---

### `server/genie-sync.cjs` (196 lines) — MyHealth Genie Integration

Bi-directional sync with the MyHealth Genie patient app via Supabase RPC functions.

**Syncs:** Patient profile, care team, medications, lab results, diagnoses, goals, lifestyle advice, self-monitoring instructions.

Requires `GENIE_SUPABASE_URL` and `GENIE_SUPABASE_SERVICE_KEY` environment variables. Non-blocking — errors are logged but don't fail the consultation save.

---

### `server/db-init.js` (24 lines) — Schema Bootstrap

Reads `schema.sql` and executes it against the database. Run once after creating the PostgreSQL instance:

```bash
DATABASE_URL="postgres://..." node server/db-init.js
```

---

### `server/Dockerfile`

```dockerfile
FROM node:20-slim
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY . .
EXPOSE 3001
CMD ["node", "index.js"]
```

---

### `vite.config.js`

Vite build configuration:
- React plugin enabled
- Server listens on `0.0.0.0` (all interfaces) for container compatibility
- Port from `$PORT` env var (default 3000)
- All hosts allowed (Railway requirement)

---

### Patch Scripts (`*.py`)

One-off Python scripts used during development for code modifications. **Not part of the runtime** — they were used to apply patches to `App.jsx` and `server/index.js` during iterative development.

---

## Features

### Clinical Workflow
- **Voice transcription** with real-time streaming (Deepgram) or batch (Whisper)
- **Multi-language support** — English, Hindi, multilingual
- **AI-powered extraction** of diagnoses, medications, investigations, history, complaints
- **Pharmacy formulary matching** with fuzzy search (6,931+ medicines)
- **Medication reconciliation** — continue / hold / stop with reasons
- **Automatic medication auto-stop** when treatment plan changes
- **Print-ready prescriptions** with professional formatting

### Lab & Imaging
- **Lab Portal** — upload lab report images, AI OCR extracts test values
- **Imaging Portal** — upload X-ray, ultrasound, CT, MRI documents
- **Abnormal lab detection** with action item flagging

### Analytics & Outcomes
- **Biomarker trend charts** — HbA1c, FBS, PPBS, LDL, HDL, TG, creatinine, eGFR, TSH, BP, weight, BMI (25+ biomarkers)
- **Clinical Intelligence** — aggregate analytics by doctor, diagnosis distribution, medication patterns
- **Outcomes dashboard** — treatment effectiveness visualization over time

### Advanced AI
- **Clinical Reasoning** — audio-record doctor's decision rationale with transcription
- **Rx Review** — AI analysis of prescriptions for drug interactions, dosage appropriateness
- **Shadow AI** — consultant recommendation comparison

### Companion Mobile App
- Accessible at `/companion` — mobile-optimized document capture
- Camera capture or file upload with AI extraction
- Auto-categorization of document types

---

## API Endpoints

### Authentication
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/login` | PIN-based login (returns token) |
| POST | `/api/auth/logout` | Revoke session |
| GET | `/api/auth/me` | Check authentication |

### Patients
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/patients?q=search` | Search/list patients |
| GET | `/api/patients/:id` | Full patient record + history |
| POST | `/api/patients` | Create or update patient |
| GET | `/api/patients/check-duplicate` | Deduplication check |

### Consultations
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/consultations` | Save full consultation (transactional) |
| GET | `/api/consultations/:id` | Consultation detail |
| GET | `/api/consultations/:id/prescription` | Reconstructed Rx |

### Vitals, Labs & Medications
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/patients/:id/vitals` | Vital signs history |
| GET | `/api/patients/:id/labs` | Lab results (deduplicated) |
| POST | `/api/patients/:id/labs` | Add lab result |
| GET | `/api/patients/:id/medications?active=true` | Medication list |

### Documents
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/patients/:id/documents` | Create document record |
| POST | `/api/documents/:id/upload-file` | Upload file to Supabase |
| GET | `/api/documents/:id/file-url` | Signed download URL (1-hour) |
| POST | `/api/patients/:id/history` | Save historical consultation |

### Outcomes & Analytics
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/patients/:id/outcomes` | Biomarker trends (25+ markers) |
| GET | `/api/reports/today` | Today's consultation summary |
| GET | `/api/reports/diagnoses` | Diagnosis frequency by doctor |
| GET | `/api/reports/doctors` | Top doctors by patient volume |
| GET | `/api/reports/clinical-intelligence` | Aggregate clinical analytics |
| GET | `/api/analytics/outcomes` | Aggregate biomarker analytics |

### AI Features
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/consultations/:id/reasoning` | Save clinical reasoning |
| POST | `/api/reasoning/:id/audio` | Upload reasoning audio |
| GET | `/api/reasoning/:id/audio-url` | Audio signed URL |
| POST | `/api/consultations/:id/rx-feedback` | Save Rx review feedback |

### Appointments & Messages
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET/POST | `/api/appointments` | List/create appointments |
| PUT/DELETE | `/api/appointments/:id` | Update/cancel appointment |
| GET | `/api/messages/inbox` | Message list |
| PUT | `/api/messages/:id/read` | Mark message read |

---

## Environment Variables

### Frontend (`.env` file in project root)

| Variable | Required | Description |
|----------|----------|-------------|
| `VITE_API_URL` | Yes | Backend API URL (e.g., `https://gini-api.up.railway.app`) |
| `VITE_DEEPGRAM_KEY` | Yes | Deepgram API key for streaming transcription |
| `VITE_OPENAI_KEY` | Optional | OpenAI API key for Whisper batch transcription |
| `VITE_ANTHROPIC_KEY` | Yes | Anthropic API key for Claude (extraction, Rx review, CI) |
| `PORT` | Optional | Dev server port (default: 3000) |

### Backend (`server/.env` or Railway environment)

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `PORT` | Optional | Server port (default: 3001) |
| `SUPABASE_URL` | Yes | Supabase project URL (for file storage) |
| `SUPABASE_SERVICE_KEY` | Yes | Supabase service role key |
| `GENIE_SUPABASE_URL` | Optional | MyHealth Genie Supabase URL (for sync) |
| `GENIE_SUPABASE_SERVICE_KEY` | Optional | MyHealth Genie service key |
| `HOSPITAL_PHONE` | Optional | Hospital phone for Genie care team sync |

---

## Getting Started

### Prerequisites

- **Node.js** >= 20
- **PostgreSQL** (local or hosted — Railway, Supabase, etc.)
- API keys for: **Deepgram**, **Anthropic Claude**, and optionally **OpenAI**

### 1. Clone the repository

```bash
git clone <your-repo-url>
cd gini-scribe
```

### 2. Install dependencies

```bash
# Frontend
npm install

# Backend
cd server && npm install && cd ..
```

### 3. Set up environment variables

Create `.env` in the project root:

```env
VITE_API_URL=http://localhost:3001
VITE_DEEPGRAM_KEY=your_deepgram_api_key
VITE_ANTHROPIC_KEY=your_anthropic_api_key
VITE_OPENAI_KEY=your_openai_api_key          # optional
```

Set backend environment variables (export or create `server/.env`):

```env
DATABASE_URL=postgres://user:pass@localhost:5432/gini_scribe
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your_supabase_service_key
```

### 4. Initialize the database

```bash
DATABASE_URL="postgres://user:pass@localhost:5432/gini_scribe" node server/db-init.js
```

This creates all tables, views, and triggers from `server/schema.sql`.

### 5. Start the development servers

```bash
# Terminal 1 — Backend API
cd server && node index.js

# Terminal 2 — Frontend dev server
npm run dev
```

The frontend runs at `http://localhost:3000` and the API at `http://localhost:3001`.

### 6. Open the app

- **Main clinical interface:** `http://localhost:3000`
- **Mobile companion app:** `http://localhost:3000/companion`

---

## Deployment (Railway)

### Step 1: Create PostgreSQL

1. Railway dashboard -> New -> Database -> PostgreSQL
2. Copy the `DATABASE_URL` from the Variables tab

### Step 2: Deploy the API server

1. Railway -> New -> GitHub Repo -> select this repo
2. Set root directory to `server`
3. Add environment variables: `DATABASE_URL`, `PORT=3001`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`
4. Railway builds from `server/Dockerfile` automatically

### Step 3: Initialize the database

```bash
# From Railway shell or locally:
DATABASE_URL="your-railway-postgres-url" node server/db-init.js
```

### Step 4: Deploy the frontend

1. Railway -> New -> GitHub Repo -> select this repo (root directory: `/`)
2. Add environment variables: `VITE_API_URL=https://your-api.up.railway.app`, `VITE_DEEPGRAM_KEY`, `VITE_ANTHROPIC_KEY`
3. Build command: `npm run build`, Start command: `npx vite preview`

### Step 5: Verify

- API health check: `GET https://your-api.up.railway.app/` should return `{"status":"ok"}`
- Open the frontend URL, log in, and create a test consultation

### Estimated Cost

- Railway PostgreSQL: **Free** (first 500MB, ~10,000 patients)
- API server: **~$5/month** (Railway Starter)
- Frontend: **~$5/month** (Railway Starter)

---

## How It Works

### Consultation Flow

```
Doctor speaks during examination
         |
         v
  [Deepgram / Whisper]  -- real-time or batch transcription
         |
         v
  Raw transcript text
         |
         v
  [Anthropic Claude]  -- structured extraction with JSON schema
         |
         v
  Structured data:
    - Diagnoses (dm2, htn, cad, ckd, ...)
    - Medications (name, dose, frequency, timing)
    - Investigations ordered
    - Chief complaints
    - History / complications
         |
         v
  [medmatch.js]  -- fuzzy match to Gini pharmacy brands
         |
         v
  Doctor reviews & edits on screen
         |
         v
  [POST /api/consultations]  -- atomic save (transaction)
         |
    +----+----+
    |         |
    v         v
  PostgreSQL   Genie Sync (non-blocking)
  (all structured data)   (patient app)
```

### Medicine Matching Flow

```
AI extracts: "Tab Metformin 500mg BD"
         |
         v
  Normalize: "METFORMIN 500MG"
         |
         v
  Score against 6,931 pharmacy entries:
    - Exact match = 100
    - First-word match + Levenshtein = ~85
    - Token overlap = ~70
         |
         v
  Best match > 65 confidence?
    Yes -> Return: {brand: "METFORMIN", form: "tablet", dose: "500mg"}
    No  -> Return unmatched (doctor manually selects)
```

---

## License

Proprietary — Gini Advanced Care Hospital.
