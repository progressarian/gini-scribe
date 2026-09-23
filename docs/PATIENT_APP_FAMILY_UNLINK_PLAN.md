# Remove a family member from a patient's app account

## Ask

When a registered patient asks for it, an **admin** can take a family member
off that phone's MyHealth Genie account. The family member's chart and history
stay exactly as they are — this is not an erasure. It only stops that person
appearing (and being reachable) in the app for that phone.

## How "family" works today

There is no family table. A family member is another `patients` row that shares
the phone number — `patients.phone` was made non-unique for this
(`server/migrations/2026-05-18_patients_phone_non_unique.sql`). The app's family
is recomputed on every request by matching the last 10 digits of the phone, in
both databases:

| Where                            | What it does                                                        | File                                                                              |
| -------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `findHospitalPatient`            | picks the row a login resolves to (`LIMIT 1`, no order)             | `server/routes/patientAuth.js`                                                    |
| `findAppPatient`                 | same, in the Genie (Supabase) DB                                    | `server/routes/patientAuth.js`                                                    |
| `listLinkedPatients`             | the family list returned as `linkedPatients` on every login/refresh | `server/routes/patientAuth.js`                                                    |
| `propagateToAllRows`             | copies password + OTP fields to every row on the phone              | `server/routes/patientAuth.js`                                                    |
| `GET /patient/app/gini-db-token` | signs `app_patient_ids` (1 h) that RLS on the hospital DB trusts    | `server/routes/patientApp.js`, `server/migrations/2026-10-11_patient_app_rls.sql` |

Why the obvious shortcuts don't work:

- **Clearing or changing the member's phone** — the HealthRay sync writes the
  phone back on every run (`upsertPatient`, `phone = COALESCE($3, phone)`,
  `server/services/healthray/db.js`), and staff edits can't clear it either.
- **Deleting the member's `patients` row** — ~40 tables reference it without a
  cascade and two billing tables `RESTRICT`; it would destroy clinical and
  billing history, and HealthRay would re-create the row on the next sync.

So the unlink has to be its own fact, stored apart from the phone.

## Design

### 1. Data — `patient_app_unlinks`

One row per (phone, patient) that must not appear on that phone's account.

| Column                       | Notes                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------- |
| `id`                         | serial                                                                                |
| `phone_last10`               | the account's phone, last 10 digits — the key the app matches on                      |
| `patient_id`                 | `patients(id)`, `ON DELETE CASCADE` (a merged/deleted chart takes its unlink with it) |
| `reason`                     | required free text                                                                    |
| `requested_by`               | who asked — patient name / relation, free text                                        |
| `unlinked_by`                | `doctors(id)` of the admin                                                            |
| `unlinked_at`                | `NOW()`                                                                               |
| `relinked_by`, `relinked_at` | set on undo; the row is kept as the audit trail                                       |

Active unlink = `relinked_at IS NULL`. Unique on `(phone_last10, patient_id)`
where active. Keyed on the phone, not just the patient, so the same person can
still be reached from a different number that is legitimately theirs.

App-DB-only family members (rows that exist only in Genie) are stored by their
Genie id in a sibling column `app_patient_id` (text) with `patient_id` NULL; a
check constraint requires exactly one of the two.

### 2. Server — enforce it everywhere the family is computed

One helper in a new `server/services/patientAppUnlinks.js`:
`unlinkedIdsForPhone(phone) → { hospital: Set<id>, app: Set<id> }`.

Applied in:

- `listLinkedPatients` — drop unlinked ids (both DB branches).
- `findHospitalPatient` / `findAppPatient` — never resolve a login to an
  unlinked row.
- `propagateToAllRows` — don't copy the account's password/OTP onto an
  unlinked row.
- `GET /patient/app/gini-db-token` — leave unlinked ids out of
  `app_patient_ids`, so RLS stops serving their data.

At the moment of unlinking:

- delete that patient's `auth_sessions` rows for the phone and call
  `revokePatientRefreshTokens` (`server/services/refreshTokens.js`) so any
  session already on that profile ends.
- a Genie DB token already issued keeps working for up to its 1 h TTL — stated
  in the UI rather than engineered away.

### 3. API — admin only

Mounted under `/api/patient-app-unlinks`, gated `CAP.ADMIN` in
`server/middleware/auth.js` (same precedent as `/api/patient-blocks`), Zod
schemas in `server/schemas/index.js`:

- `GET  /patient-app-unlinks/family?patientId=` — everyone on that patient's
  phone (both DBs) with their linked/unlinked state and last unlink row.
- `POST /patient-app-unlinks` — `{ phone, patientId | appPatientId, reason, requestedBy }`.
  Refuses to unlink the last remaining profile on a phone.
- `POST /patient-app-unlinks/:id/relink` — undo.

Routes stay HTTP-only; logic lives in the service.

### 4. UI

On **Find** (`src/pages/FindPage.jsx`), next to the existing admin-only Block
action (`canBlock = hasCapability(role, CAPABILITIES.ADMIN)`), a
**Family on this phone** action opens a modal modelled on
`BlockPatientModal`:

- lists every profile on the phone, marking the one being viewed;
- per row: **Remove from app account** (asks reason + requested by) or
  **Restore** with who/when it was removed;
- note: "Their medical record is not changed. They stop appearing in the app
  for this phone; an open app session may take up to an hour to drop."

### 5. Rollout

1. Migration `server/migrations/<date>_patient_app_unlinks.sql`.
2. Service + filters in `patientAuth.js` / `patientApp.js`; smoke script
   `server/scripts/smoke-patient-app-unlinks.mjs` that unlinks and relinks a
   test phone and asserts `listLinkedPatients` and the token id list change.
3. API + permissions.
4. Find page modal.

## Out of scope

- Erasing a family member's data (a DPDP erasure request) — a separate,
  larger job with record-retention limits.
- An in-app "remove" button for the patient — the app's own code is not in
  this repo.
- Fixing `findHospitalPatient`'s arbitrary `LIMIT 1` — noted, not changed here.
