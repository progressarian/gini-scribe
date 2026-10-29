# Patient registration: category, Aadhaar / card and ID scans — Plan

Status: built 2026-10-29 (steps 1–4, 6, 7). Step 5 needs no code: intake never registers a patient itself; new patients reach the consultation through `/patient`. The e2e spec is not written yet.

## 1. Goal

Every desk form that registers a **new** patient asks:

- **Category**: General by default, or any active category from Settings → Categories (CGHS, ECHS, Himachal Govt, …).
- **If General**: an Aadhaar number (12 digits), or, when the patient has none, another govt ID (Passport, Voter ID, PAN, Driving Licence) with its number. One of them is mandatory.
- **If the category needs a card** (`patient_schemes.requires_ref`, currently CGHS and ECHS; admin can switch it on for others): the card number plus a scan of the card.
- **No patient photo**: dropped on review (2026-10-29). `patients.photo_doc_id` was already migrated and stays unused.
- **ID scan**: a scan of the Aadhaar/govt ID or category card, taken with the camera or uploaded as an image or PDF (the flatbed scanner saves a file through its own software, then it is uploaded).

## 2. What already exists (reuse, don't rebuild)

| Piece | Where |
|---|---|
| Category list, a DB table | `patient_schemes` (`requires_ref`, `parent_code`, …); client copy in `shared/patientCategories.js`, hydrated from `GET /api/patient-schemes` |
| Category on the patient | `patients.scheme_code`, `patients.scheme_ref` (card no, encrypted); set today only by `PUT /api/patients/:id` |
| Category snapshot on the appointment | `appointments.patient_category` (GHM booking already copies it from `patients.scheme_code`) |
| Billing reads the category | `server/services/billing/categoryResolver.js` (appointment → `patients.scheme_code` → `category_rules`) |
| Aadhaar encryption | `server/utils/aadhaarCrypt.js`; the strict "refuse when the key is missing" sealing is `sealNumber` in `server/services/billing/bills.js:149` |
| File storage | `documents` row + `POST /api/documents/:id/upload-file` → Supabase bucket `patient-files` |
| Camera / file capture UI | `src/companion/CaptureScreen.jsx` (camera + file inputs), `CameraCaptureSheet` in `src/companion/MultiCaptureScreen.jsx`, HEIC→JPEG in `src/services/extraction.js` |
| Upload-after-create pattern | `src/components/billing/counter/PatientHeader.jsx:166-189` (create doc → upload-file) |

**The core bug this plan fixes:** `POST /api/patients` ignores `scheme_code`/`scheme_ref`. A category picked on `/patient` for a new patient is dropped silently.

## 3. Forms in scope (decided)

| Form | Rules |
|---|---|
| OPD → New Appt → Register (`NewPatientForm`, `src/OPD.jsx:5112`) | Full: category, Aadhaar/govt ID or card, scans |
| `/patient` new patient (`src/pages/PatientPage.jsx`, `patientStore.savePatient`) | Full |
| Flow check-in → New Patient (`src/components/flow/NewPatientModal.jsx`) | Full |
| Flow check-in quick create (`FlowCheckinPage.jsx:697`, name/phone only) | Removed: "no patient picked" opens `NewPatientModal` instead |
| Consultation intake (`uiStore.saveConsultation` → new patient) | Full rules on the number fields; scans optional (it's the doctor's screen) |
| GHM / Care → New appointment (`NewAppointmentModal`, `src/pages/GHMPage.jsx:1078`) | Lighter: category + card no / Aadhaar no only, **no uploads** (the patient isn't there, and OBT has no `PATIENT_CHART`). The patient is flagged "ID scan pending" and the scan is collected at reception |
| Find → Quick Book, OPD Excel import, `POST /appointments` auto-create | Out of scope: they keep creating name+phone shells, flagged "ID pending" |
| HealthRay / sheets / lab / Genie auto-creates | Untouched; rules are never enforced on syncs |

Existing patients are never blocked. The rules apply only when a row is **inserted** from a desk form, not on the upsert-match path or on edits.

## 4. Data model

Migration `server/migrations/2026-10-29_patient_registration_id.sql`:

```sql
ALTER TABLE patients ADD COLUMN IF NOT EXISTS photo_doc_id INTEGER REFERENCES documents(id) ON DELETE SET NULL;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS id_doc_id INTEGER REFERENCES documents(id) ON DELETE SET NULL;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS scheme_card_doc_id INTEGER REFERENCES documents(id) ON DELETE SET NULL;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS id_pending BOOLEAN NOT NULL DEFAULT FALSE;
```

- The files are ordinary `documents` rows with `doc_type` `id_proof` or `scheme_card` and `source = 'registration'`. `extracted_data.extraction_status = 'skipped'` keeps the AI extractor off them.
- `id_doc_id` / `scheme_card_doc_id` point at the current file, so screens can open it without searching documents.
- Aadhaar stays in `patients.aadhaar` and the card no in `patients.scheme_ref`, both sealed.
- Additive only: no backfill, and every column is nullable or defaulted, so existing screens keep working before the code deploys.

## 5. Shared rules

New file `shared/patientIdentity.js`, imported by both the client forms and the server:

- `cleanAadhaar(v)`: digits only, exactly 12, Verhoeff checksum → "Enter the 12-digit Aadhaar number." on failure.
- `GOVT_ID_TYPES`: the existing four, moved out of `OPD.jsx`/`NewPatientModal` so there's one list.
- `identityProblems({ scheme_code, scheme_ref, aadhaar, govt_id_type, govt_id }, schemeRow)` returns field-level messages:
  - General (`""`): Aadhaar **or** (govt_id_type + govt_id) required.
  - Category with `requires_ref`: `scheme_ref` required.
  - Other categories: nothing extra.

## 6. Server

- **`server/services/patients/identity.js`** (new):
  - `validateNewPatientIdentity(body, client)`: loads the scheme row (`isKnownScheme` / `patient_schemes`), runs `identityProblems`, and throws a 400 with field errors.
  - `sealIdentityNumber`: `sealNumber` moved from `bills.js` into `server/utils/aadhaarCrypt.js` so both use it. It refuses to store Aadhaar or card numbers in plain text when the key is missing.
- **`POST /api/patients`** (`server/routes/patients.js:579`):
  - Saves `scheme_code`/`scheme_ref` on insert, and on the match-update path with COALESCE.
  - Enforces identity only when `registration: "desk"` is in the body and a row is being inserted. Also saves `blood_group`, which the OPD form already sends and the route drops.
- **`POST /api/consultations`**: runs the same check when it inserts a new patient (camelCase fields mapped).
- **`POST /api/ghm-appointments`**: when `new_patient`, accepts `scheme_code`, `scheme_ref`, `aadhaar` and `govt_id*`, runs the same check, and sets `id_pending = true`.
- **`POST /api/patients/:id/registration-file`** (new, `PATIENT_CHART`):
  - Body `{ kind: id_proof|scheme_card, base64, mediaType, fileName }`.
  - Wraps the existing document create + upload, sets the matching `*_doc_id`, and clears `id_pending` once the required scan is present.
  - One endpoint keeps the three forms from re-implementing the two-step upload.
- **Zod**: `patientCreateSchema` gains `registration: z.enum(["desk"]).optional()` and `aadhaar` max 14. Files never ride on this body; they go through the file endpoint. GHM body gets a small schema for the new fields.
- **Responses**: `GET /api/patients/:id` returns `id_doc_id`, `scheme_card_doc_id`, `id_pending`, using the existing signed-URL helper.
- **Not in scope:** `scheme_ref` is returned unmasked today (§2 of the report). That's a separate privacy fix, listed as follow-up 10.1.

## 7. Client

- **`src/components/patient/RegistrationIdentityFields.jsx`** (new, one component used by all forms):
  - Category select (`PATIENT_CATEGORIES`, General first and default).
  - Then, depending on the category:
    - General → Aadhaar input (formatted `XXXX XXXX XXXX`) and a "No Aadhaar — use another ID" toggle that reveals the govt ID type + number.
    - Card category → "Card number" + "Card scan".
  - "ID scan" slot (Aadhaar/govt ID for General, card scan for card categories).
  - Props: `value`, `onChange`, `errors`, `withFiles` (false on GHM).
- **`src/components/patient/CaptureSlot.jsx`** (new, small):
  - Shows "Take photo" (webcam via `getUserMedia`, reusing the `CameraCaptureSheet` logic moved to `src/components/capture/`) and "Upload file" (`accept="image/*,application/pdf"`).
  - Shows a thumbnail with a Replace/Remove control.
  - Images are compressed to ≤ 1.5 MB, with HEIC converted first, to stay under the 5 MB JSON limit.
- **Submit order**:
  1. Validate locally (`identityProblems` plus "scan required").
  2. `POST /api/patients`.
  3. Upload each file to `/registration-file`, one by one, with a "Saving ID scan…" button state.
  4. If an upload fails, the patient stays created and the form shows "Patient registered. Card scan not saved. [Retry]". Nothing is faked: `id_pending` stays true until the upload succeeds.
- **Patient identity header**: `/patient`, the OPD details step and the reception walk-in card show an "ID pending" badge (label + icon, not color alone) when `id_pending`.
- **Reception**: the "ID pending" badge on the reception station walk-in card has a "Add ID scan" action that opens the same `CaptureSlot`, so GHM-booked patients get scanned on arrival.

## 8. RBAC

- No new capabilities.
  - Creating a patient stays on `PATIENT_READ` (`/api/patients`).
  - The file endpoint sits under `/api/patients`, so it needs an explicit `PATIENT_CHART` entry in `ROUTE_CAPABILITIES` (`server/middleware/auth.js`).
- Reception, MO and consultant have `PATIENT_CHART`; OBT doesn't, which is why GHM has no uploads.

## 9. Build order (each step tested before the next)

1. Migration + `shared/patientIdentity.js` + move `sealNumber`.
2. `POST /api/patients` saves the category and enforces identity for `registration: "desk"`; `/registration-file` endpoint.
3. `RegistrationIdentityFields` + `CaptureSlot`; wire into the OPD `NewPatientForm` first, to check the whole flow on one form.
4. `/patient` and Flow `NewPatientModal`; replace the Flow quick-create.
5. Consultation intake.
6. GHM `NewAppointmentModal` (numbers only, `id_pending`).
7. "ID pending" badge + "Add ID scan" at reception.

**Tests**: e2e spec `e2e/registration/new-patient-identity.spec.js` on the local test DB covers:
- General without Aadhaar is blocked.
- General with a govt ID passes.
- CGHS without a card no is blocked.
- A file upload sets `id_doc_id`.
- A GHM booking sets `id_pending`.
- A HealthRay-style insert (no `registration`) is still accepted.

## 10. Follow-ups (not in this change)

1. Mask `scheme_ref` in `GET`/`PUT /api/patients` responses the way Aadhaar is masked.
2. HealthRay has no field for the category or Aadhaar; reception still keys the category into HealthRay by hand, as today.
3. A direct scanner SDK was considered and rejected: it is paid and needs installing on every PC.
