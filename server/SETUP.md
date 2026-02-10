# Gini Scribe — Database Setup Guide

## Step 1: Create Postgres on Railway

1. Go to your Railway project (where gini-scribe frontend is deployed)
2. Click **"+ New"** → **"Database"** → **"PostgreSQL"**
3. Railway creates a Postgres instance automatically
4. Click on the Postgres service → **"Variables"** tab → copy `DATABASE_URL`

## Step 2: Deploy the API Server

### Option A: Deploy from GitHub (recommended)

1. In Railway, click **"+ New"** → **"GitHub Repo"**
2. Select your gini-scribe repo
3. **IMPORTANT:** Set the root directory to `server` in deploy settings
4. Add these environment variables:
   - `DATABASE_URL` = (paste the Postgres URL from Step 1)
   - `PORT` = 3001
5. Deploy. Railway will build from the Dockerfile.

### Option B: Deploy as separate repo

1. Copy the `server/` folder to a new repo
2. Deploy that repo to Railway
3. Set the same environment variables

## Step 3: Initialize the Database

After the API server is deployed:

```bash
# In Railway, open the API server shell, or run locally:
DATABASE_URL="your-postgres-url" node db-init.js
```

Or use Railway's CLI:
```bash
railway run node db-init.js
```

This creates all tables: patients, consultations, vitals, medications, lab_results, documents, goals, complications.

## Step 4: Connect Frontend to API

1. Get your API server's public URL from Railway (e.g., `https://gini-scribe-api-production.up.railway.app`)
2. In your frontend Railway service, add environment variable:
   - `VITE_API_URL` = `https://your-api-server-url.up.railway.app`
3. Redeploy the frontend

## Step 5: Verify

1. Visit `https://your-api-url.up.railway.app/` — should show `{"status":"ok","service":"gini-scribe-api"}`
2. Open Gini Scribe, create a consultation, click Save
3. Status should show "✅ Saved (DB #1)"

## Database Tables

| Table | Purpose |
|-------|---------|
| patients | Demographics, IDs (ABHA, Aadhaar, etc.) |
| consultations | Each visit with full transcripts + structured data |
| vitals | BP, weight, etc. — tracks trends |
| diagnoses | Active diagnoses per patient |
| medications | Full prescription history |
| lab_results | All test results — HbA1c trends, etc. |
| documents | Uploaded reports, prescriptions (future) |
| goals | Health targets with progress tracking |
| complications | DM/HTN complications tracking |

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/patients?q=search` | GET | Search patients |
| `/api/patients/:id` | GET | Full patient record + history |
| `/api/patients` | POST | Create/update patient |
| `/api/consultations` | POST | Save full consultation |
| `/api/consultations/:id` | GET | Get consultation detail |
| `/api/patients/:id/vitals` | GET | Vitals history |
| `/api/patients/:id/labs?test=HbA1c` | GET | Lab trends |
| `/api/patients/:id/medications?active=true` | GET | Medication list |
| `/api/patients/:id/documents` | POST | Upload document/report |
| `/api/patients/:id/history` | POST | Add historical consultation |
| `/api/patients/:id/outcomes` | GET | Biomarker trends for outcomes |
| `/api/analytics/outcomes` | GET | Aggregate doctor analytics |

## Cost

- Railway Postgres: **Free** for first 500MB (enough for ~10,000 patients)
- API Server: **$5/month** on Railway Starter plan
- Total: ~$5/month until you hit 10K+ patients
