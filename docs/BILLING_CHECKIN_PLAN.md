# Billing Display at OPD Check-In — Implementation Plan

## Context
At the OPD check-in screen (`/flow/checkin`), when a coordinator searches and selects a
patient, fetch that patient's **billing report from HealthRay's billing API** and **display**
the extracted values (invoice no/date, line items, total, payment status) on the check-in
screen — so the coordinator sees the billing picture without leaving the page.

### Scope decisions (confirmed)
- **Source:** HealthRay's **billing API** — a separate endpoint from the OPD `medical_records`
  feed. (Verified: OPD appointments carry only `Prescription/Rx` records, never `Invoice/Bill`,
  so the existing `fetchMedicalRecords` path does **not** return billing.) The billing API returns
  structured JSON, so **no AI/PDF extraction is needed** — we map/normalise JSON fields.
  (If a specific bill is only a PDF, the existing `server/services/healthray/parser.js`
  extractor can be a later fallback; out of scope here.)
- **Effect:** **Display only** — no DB writes, no new table, no journey-step changes.
  A live, on-demand fetch rendered in the check-in UI.

### ⛔ Dependency to capture before wiring
The exact HealthRay billing **endpoint URL + a sample JSON response** is not yet known.
Capture from the billing screen via Chrome DevTools → Network (request URL + method + params,
and the response body for a patient who has a bill). This endpoint + its field names are the
**only fill-in** — the structure below is otherwise complete.

## Design
The check-in page already fetches patient detail and today's appointment **in parallel** when a
patient is picked (`FlowCheckinPage.jsx` `pickPatient()`, ~lines 267–348, calling
`GET /api/patients/:id` and `GET /api/flow/patient-appointment`). We add a third parallel fetch
for billing plus a display panel.

### 1. Billing client — `server/services/healthray/client.js`
Add `export async function fetchPatientBilling({ patientId, fileNo, appointmentId })` that calls
the HealthRay billing endpoint **through the existing `gatedFetch`** so it inherits the rate
limiter + session auth + cooldown (no new WAF exposure). Reuse `ORG_ID`, `sessionCookie`, and the
existing `healthrayFetch`/`gatedFetch` machinery. Returns the raw billing payload, or `null` when
none. *(Endpoint path = the captured URL.)*

### 2. Backend proxy route — `server/routes/flow.js`
Add `GET /api/flow/patient-billing?patient_db_id=&file_no=&appointment_id=` next to the existing
`GET /api/flow/patient-appointment`. It calls `fetchPatientBilling(...)`, **normalises** the
response into a stable UI shape, and returns it. Keeps the HealthRay session/limiter server-side.
Best-effort: on upstream error or no bill, return `{ billing: null }` with HTTP 200 so check-in is
never blocked.

Normalised response shape (final keys pinned once the sample JSON is captured):
```json
{
  "billing": {
    "invoice_no": "...",
    "date": "...",
    "items": [{ "desc": "...", "amount": 0 }],
    "subtotal": 0,
    "discount": 0,
    "tax": 0,
    "total": 0,
    "payment_status": "paid|pending"
  }
}
```

### 3. Query hook — `src/queries/hooks/useFlow.js`
Add `usePatientBilling({ patientDbId, fileNo, appointmentId })` mirroring the existing flow hooks,
with a short cache and `enabled` only when a patient is selected.

### 4. UI panel — `src/pages/flow/FlowCheckinPage.jsx`
In `pickPatient(p)`, start the billing fetch alongside the existing parallel fetches and store it
in state. Render a compact **"Billing"** card in the check-in form area with three states:
loading, "no billing found", and the data table (items + total + payment status). Pure display —
does **not** feed into the check-in `payload`.

## Critical files
| File | Change |
|---|---|
| `server/services/healthray/client.js` | new `fetchPatientBilling()` via `gatedFetch` (URL = captured endpoint) |
| `server/routes/flow.js` | new `GET /api/flow/patient-billing` (beside `/api/flow/patient-appointment`) |
| `src/queries/hooks/useFlow.js` | new `usePatientBilling()` hook |
| `src/pages/flow/FlowCheckinPage.jsx` | billing fetch in `pickPatient()` + display card |

## Reused, do not rebuild
- Rate-limited HealthRay transport: `gatedFetch` / `healthrayFetch` + `healthrayLimiter` in `client.js`.
- Patient search + select already wired (`GET /api/patients?q=`, `pickPatient()`).
- The parallel-fetch-on-select pattern from the existing `patient-appointment` call.

## Verification
1. **Endpoint check (once captured):** call `fetchPatientBilling` for a known patient with a recent
   bill; confirm it returns the expected JSON and goes through the limiter (no burst).
2. **Route:** `curl '/api/flow/patient-billing?patient_db_id=<id>&file_no=<P_...>'` → normalised
   `{ billing: {...} }`; a patient with no bill → `{ billing: null }`, HTTP 200.
3. **UI:** open `/flow/checkin`, search a patient with a bill → Billing card shows
   invoice/items/total; a patient with no bill → clean "no billing found"; check-in still submits
   normally either way.
4. **No regressions:** check-in POST payload unchanged; no new HealthRay 403s in worker/API logs
   (calls are rate-limited).

## Optional follow-on (out of scope)
To later make billing affect the journey: hook in `server/routes/flow.js` right after the check-in
`COMMIT` (~line 701) — store the normalised billing into the billing step's `flow_visit_steps.data`
(step_catalog_id `'billing'`), and optionally auto-complete that step when
`payment_status === 'paid'`.
