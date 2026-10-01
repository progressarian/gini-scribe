# HealthRay patient import — plan

## Problem

Scribe only learns about a HealthRay patient through an **appointment** (OPD sync) or a **lab
case** (lab sync). A patient registered in HealthRay who has never been booked — `P_34080`,
Gurdeep Singh, registered 2023-01-01, `last_appointment_date: null` — is never seen by any sync,
so a UHID search in Scribe finds nobody and there is nothing to fix on the Scribe side.

## The HealthRay call

`GET /api/v1/doctor/walkin_patient_list?organization_id=1528&is_data=1&id=<orgDoctorId>&page=N&per_page=N[&search=…]`

Confirmed on 2026-10-01 with Scribe's own HealthRay login (no new credentials):

- `search=P_34080` returns exactly that patient.
- With no `search`, page 1 is the **newest registrations first** (`P_181992` registered 16:04 IST,
  then `P_181991`, `P_181990` …).
- Each row carries what a chart needs: `patient_case_id` (UHID), `family_member.healthray_id`
  (our `patients.health_id`), `family_member.first_name/last_name/gender/birth_date`, `mobile_no`,
  `email`, `address_detail`, `registration_date`, `last_appointment_date`.

## What gets built

### 1. Fetch by UHID (on demand)

- `POST /api/patients/healthray-fetch` `{ uhid }` — `P_\d+` only.
- One HealthRay search; only an **exact** `patient_case_id` match is imported (a search can return
  near matches).
- Gated by the `/api/patients` prefix (`PATIENT_READ`) **and** `RECEPTION_OPS` or `OBT_OPS` — the
  same roles that open `/find`. Creating a chart is more than reading one.
- Find page: when a search that looks like a UHID finds nobody, the empty state offers
  **"Fetch P_34080 from HealthRay"**. On success the search re-runs and the chart is there; on
  "not in HealthRay" or a HealthRay block the reason is shown in plain words.

### 2. New-patient sync (background)

- Worker loop every **10 min**. Reads page 1 (25 rows) and keeps paging only while every row is
  newer than the checkpoint, max **4 pages** a tick. A normal day (~20–30 registrations) is one
  request per tick.
- Checkpoint `app_kv.healthray_patients_checkpoint` = newest `registration_date` imported. The
  first run starts from the beginning of today (IST) — it does **not** back-fill old patients.
- Own cron lease (`CRON_LOCK_KEYS.HEALTHRAY_PATIENTS`), so two workers never run it together.
- Runs inside the existing HealthRay client: same rate limiter, same shared block/cooldown. While
  HealthRay is blocking, the tick fails fast and the checkpoint does not move, so nothing is lost.

### Shared import path

Both use the sync's existing `buildPatientData` → `upsertPatient`, unchanged. Identity therefore
behaves exactly as the appointment sync does: match on `health_id`; adopt a legacy/`GNI-` chart by
UHID or phone when it is the same person; a reassigned UHID is released from its previous owner.

## Not built

- **Back-filling all ~180,000 old patients.** ~1,800+ requests; risky while HealthRay keeps
  IP-blocking us. Revisit once `HEALTHRAY_PROXY_URL` (fixed IP) is live. Fetch-by-UHID covers the
  individual old patient meanwhile.
- No clinical history is imported — a patient with no appointment has none. Their visits arrive
  through the normal appointment sync.

## Privacy (DPDP)

The new-patient sync brings every newly registered HealthRay patient into Scribe, including people
who may never consult. That is the same data HealthRay already holds for the same hospital, imported
for the same care purpose, but it widens what Scribe stores. Switch: `SCRIBE_HEALTHRAY_PATIENT_SYNC=0`
turns the background sync off and leaves fetch-by-UHID working.

## Testing

All against the local e2e database (`localhost:5435/gini_scribe_test`), with the HealthRay call
stubbed — no production database, no HealthRay traffic:

- a list row maps to the right chart fields; importing twice updates, never duplicates;
- an exact UHID match is imported, a near match is not, an unknown UHID reports "not found";
- the sync imports only rows newer than the checkpoint, pages while needed, moves the checkpoint,
  and leaves it untouched when HealthRay fails.
