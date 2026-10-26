# New-patient History & Examination, and MOs writing Dr Bhansali's Rx — Plan

Status: approved 2026-10-26. Building step by step (§8).

Requested on 2026-10-26, from a handwritten sheet ("New Doc 10-26-2026 13.30.pdf") and these notes:

- Dr Bhansali's prescriptions are written by three medical officers who sit in front of him: **Dr Jaschandrika, Dr Harshit, Dr Supreet**. The printout must still say Dr Bhansali.
- **Dr Beant** and **Dr Simran** take the full history themselves, for new patients.

Decided with the user:

| #   | Question                 | Decision                                                                             |
| --- | ------------------------ | ------------------------------------------------------------------------------------ |
| 1   | Where is the form filled | A new section on `/visit`, the page where the prescription is made and printed today |
| 2   | Which patients           | **New patients only**, for both History and Examination                              |
| 3   | Printed?                 | **Yes, both print** on the prescription                                              |
| 4   | The three MOs            | Logins **limited to Dr Bhansali's patients**; the Rx prints Dr Bhansali              |
| 5   | MO reach                 | **Bhansali patients only**, for opening charts as well as writing                    |
| 6   | Smoking / alcohol        | Free text                                                                            |
| 7   | History on the Rx        | **Replaces** the existing "Clinical history" line for new patients                   |
| 8   | Vaccination              | COVID vaccination                                                                    |
| 9   | Which printout           | The **Scribe Rx** (Gini letterhead) is what these patients get                       |
| 10  | MO floor screens         | **None** — the three MOs only work Dr Bhansali's patients on `/visit`                |
| 11  | Editing later            | Editable **on the visit day**, then read-only                                        |
| 12  | Allergies                | **None known / Not asked / Known + text** — a blank never prints as "none"           |

## 1. The form (from the sheet)

### History — general (new patients only)

| Field                  | Input                                                                                           |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| C/O (chief complaints) | free text                                                                                       |
| Past medical history   | free text                                                                                       |
| Past surgical history  | free text                                                                                       |
| Family history         | free text                                                                                       |
| COVID                  | Yes / No + additional info                                                                      |
| COVID vaccination      | Yes / No + additional info                                                                      |
| Smoking                | free text (e.g. "10/day × 15 yrs, quit")                                                        |
| Alcohol                | free text                                                                                       |
| Allergies              | Not asked / None known / Known allergy → text — **the patient's existing allergy record** (§11) |
| Previous medications   | free text                                                                                       |

### Examination

Every item has three states: **not examined** (default), **normal / absent**, **present / abnormal** + an optional note. Items with their own values are marked.

| Head & Neck                   | Upper limbs             | Chest & Abdomen     | Neck & Back                | Lower limbs  |
| ----------------------------- | ----------------------- | ------------------- | -------------------------- | ------------ |
| Androgenic alopecia           | Dupuytren's contracture | Gynaecomastia       | Acanthosis — **grade 0–4** | Pedal edema  |
| Frontotemporal recession      | Nails                   | Spleen              | Skin tags                  | Pedal pulses |
| Xanthelasma                   | Lipoma                  | Rectus divarication | Goitre                     | Nails        |
| Xanthoma                      | Neurofibroma            | Fatty liver         |                            | Arch of foot |
| Madarosis                     | Cysts                   | Hernia              |                            | Reflexes     |
| Pallor                        | Pulse                   |                     |                            |              |
| Icterus                       |                         |                     |                            |              |
| Arcus                         |                         |                     |                            |              |
| Dental hygiene                |                         |                     |                            |              |
| Double chin                   |                         |                     |                            |              |
| Acanthosis — **grade 0–4**    |                         |                     |                            |              |
| Skin tags                     |                         |                     |                            |              |
| B/L carotids                  |                         |                     |                            |              |
| JVP — **raised / not raised** |                         |                     |                            |              |
| Lymphadenopathy               |                         |                     |                            |              |
| Abnormal mass / growth        |                         |                     |                            |              |
| Ear lobule crease             |                         |                     |                            |              |

The config sits in `shared/newPatientWorkup.js` (not `src/config/`) because the server needs it both to validate saves and to print, and `shared/` is where client/server vocabularies live. The old wizard's `/exam` page and `src/config/exam.js` are not touched.

## 2. Who sees the section

Shown on `/visit` when **all** are true:

1. The visit has an appointment (`opdApptId`). A chart opened with no appointment today shows nothing to fill.
2. That appointment is New — `appointment_is_new_type(visit_type)`, the same rule the DB triggers already enforce (a patient stops being New after their first attended visit).
3. The appointment's consultant has the new flag **`doctors.new_patient_workup = true`**. Set for Dr Anil Bhansali, Dr Beant, Dr Simran. The consultant is matched the way `patientScope.js` already does it: `appointments.doctor_id`, else the free-text `doctor_name` against the roster's name / short name.

Later visits (follow-ups) show the first workup **read-only** in the History tab, labelled with its date and who recorded it.

The old wizard's exam (`consultations.exam_data`, shown read-only on `/visit` as "Exam findings") stays as it is. When a new-patient workup exists, the workup's examination is shown instead, so the doctor never sees two exam blocks for the same visit.

## 3. The three MO logins

### Role

Capabilities are per **role**, not per person. A plain `mo` login also gets the Gini Flow vitals/MO stations and the floor view, which list every patient. Decision 10 removes those for these three, so they get a **new role, `rx_mo`** ("MO — prescriptions") in `shared/permissions.js`:

| Capability                                  | `mo` today | `rx_mo` |
| ------------------------------------------- | ---------- | ------- |
| PATIENT_READ, PATIENT_CHART, CLINICAL_WRITE | ✓          | ✓       |
| AI_TOOLS, LAB_REQUESTS                      | ✓          | ✓       |
| VITALS (enter vitals on `/visit`)           | ✓          | ✓       |
| GINIFLOW_PRINT_RX                           | ✓          | ✓       |
| REFILLS, DOSE_REVIEWS, SIDE_EFFECTS         | ✓          | —       |
| RECEPTION_OPS (narrowed by the guard, §11)  | ✓          | ✓       |
| FLOW*\* / GINIFLOW*\* stations, floor view  | ✓          | —       |

`rx_mo` is added to the role picker in Doctor Management, to `OWN_LIST_ROLES`, and to both the route map (`src/config/routes.js`) and the API map (`server/middleware/auth.js`) through the same capabilities — no per-route special case. Existing `mo` logins are untouched.

### Link to Dr Bhansali

New column **`doctors.assists_doctor_id`** (FK `doctors.id`), required for `rx_mo`, set to Dr Anil Bhansali. It is not in the JWT (it would stay stale until re-login); the server reads it from `doctors` with a short in-memory cache, cleared when Doctor Management saves the doctor.

### What they can reach — all enforced on the server

"Dr Bhansali's patient" = the patient has an appointment with Dr Bhansali **today**, or their most recent **past** appointment was with him. Future bookings with another doctor don't count, so a later booking can't lock him out.

| Surface                                                                                                                                              | Rule for `rx_mo`                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Home list, patient search (`/api/patients`), OPD list (`/api/opd`), home stats                                                                       | Filtered to Dr Bhansali's patients (via `doctorScope` returning the assisted doctor's id and names)                           |
| Any `/:patientId` route under `/api/visit`, `/api/patients`, `/api/consultations`, `/api/clinical`, `/api/ai`, documents/file URLs (incl. `?token=`) | 403 unless Dr Bhansali's patient — one guard (`server/middleware/assistedPatientGuard.js`), mounted once in `server/index.js` |
| Writes on `/api/visit/:patientId/*`                                                                                                                  | Additionally need **today's** appointment to be with Dr Bhansali                                                              |
| `/api/flow/*`, `/api/giniflow/*`                                                                                                                     | Blocked by capability (role has none)                                                                                         |
| `/api/genie-chats`, `/api/genie-patients`, `/api/app-patients` (opened by AI_TOOLS, which `/visit` needs for `/api/ai/complete`)                     | Blocked for `rx_mo` by the same guard — they list every app patient                                                           |

UI: a 403 from the guard shows "This patient isn't on Dr Bhansali's list" in place of the chart, not a raw error. Before building, every route with a patient id is listed (grep of `:patientId` / `:id` under those routers) and the list goes in this doc, so none is missed.

## 4. Printed prescription

### Doctor block — a fix needed first

There are three ways the Scribe Rx is built:

| Path                                                      | Built from                                      | Doctor printed today                                                                |
| --------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------- |
| Print button → `POST /visit/:id/prescription.pdf`         | client payload (`VisitPage.jsx` `visitPayload`) | appointment doctor's **name** + the **logged-in user's** qualification; no Reg. No. |
| End visit → `POST /visit/:id/complete`                    | client payload                                  | same; if the appointment has no doctor, the **logged-in user's name**               |
| Regenerate / HealthRay "seen" → `buildVisitPayloadFromDb` | server                                          | appointment doctor + roster qualification + Reg. No. — correct                      |

So an MO pressing Print today gets "Dr. Anil Bhansali" over the **MO's own qualification line**. Fix: all three paths resolve the doctor block on the server from the appointment (one helper shared with `prescriptionAutoSave.js`), ignoring the doctor sent by the browser. `/prescription.pdf` therefore needs the `appointment_id`, which the page already has. This also fixes the same mismatch for ordinary MOs and receptionists who print today.

### History and examination

The workup is also loaded on the **server** in all three paths, so the browser can't print a stale or missing copy.

For new patients with a workup, the History block **replaces** the existing "Clinical history" line. Without a workup the old line prints as today:

```
History
  C/O: …   Past medical: …   Past surgical: …   Family: …
  COVID: Yes — …   COVID vaccination: Yes — …   Smoking: …   Alcohol: …
  Allergies: None known | Not asked | Known — penicillin (rash)
  Previous medications: …
Examination
  Head & Neck: Xanthelasma (B/L), Acanthosis gr 2, JVP not raised
  Lower limbs: Pedal edema ++ ; pedal pulses feeble (L)
  Rest of the examination: NAD
```

- Filled history fields print. **Allergies always prints**, including "Not asked".
- Only **present/abnormal** exam items print, grouped by region, plus JVP and acanthosis when a value is chosen. Items marked normal become "Rest of the examination: NAD". If nothing was examined, the Examination block is left out.
- Long text wraps; page breaks avoid splitting a region's line.
- The MO's name is **not** printed. It is kept on the record and shown on screen ("Workup by Dr Harshit, 10:42").

## 5. Data and API

Migration `server/migrations/2026-12-xx_new_patient_workups.sql`:

```
doctors
  + new_patient_workup BOOLEAN NOT NULL DEFAULT false
  + assists_doctor_id  INTEGER REFERENCES doctors(id)

new_patient_workups
  id, appointment_id UNIQUE REFERENCES appointments(id), patient_id,
  history JSONB NOT NULL DEFAULT '{}', exam JSONB NOT NULL DEFAULT '{}',
  prepared_by_doctor_id, updated_by_doctor_id,
  created_at, updated_at
```

Only `id`/FK/flag columns; no backfill.

| Method | Path                           | Capability     | Notes                                                                                                                                                                      |
| ------ | ------------------------------ | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/visit/:patientId/workup` | PATIENT_CHART  | `?appointment_id=` → that visit's row, plus whether it is editable; with no id → the patient's first workup (read-only view on follow-ups)                                 |
| PUT    | `/api/visit/:patientId/workup` | CLINICAL_WRITE | Zod schema built from the shared config (unknown item ids rejected); upsert on `appointment_id`; sends `updated_at` back and gets **409** if someone else saved in between |

PUT is refused (with a message the UI shows) when: the appointment isn't this patient's, isn't New, its doctor isn't flagged, or the visit day is over (IST). Logic in `server/services/visit/newPatientWorkup.js`.

## 6. UI on `/visit`

- A "New patient workup" section with two collapsible parts, History and Examination, placed before Diagnoses (it is filled first). Visible labels on every field.
- Examination: one compact row per item with a three-state radio group (— / Normal / Present), keyboard-operable, a note field that opens on Present, grade / raised selectors inline. Region headers show "3 abnormal · 12 normal", in words, not colour only. "Mark rest normal" per region.
- Saves on blur (debounced) with "Saving… / Saved 10:42". A failed save keeps the typed values and shows Retry. A 409 says "Dr X changed this at 10:44 — reload to see their version".
- After the Rx has been generated, an edit shows "Prescription out of date — regenerate" next to the print button.
- From the next day it is read-only, with who recorded it and when.

## 7. Tests

`e2e/visit/V01-new-patient-workup.spec.js` (new folder; the config already picks up `**/*.spec.js`):

- New patient of a flagged doctor → section shown; save; reload; values kept.
- Follow-up patient → section hidden; first workup shown read-only.
- Unflagged doctor's new patient → hidden; PUT refused.
- Yesterday's visit → PUT refused, UI read-only.
- Two sessions edit → second gets 409.
- `rx_mo`: home list and search show only the assisted consultant's patients; another consultant's chart, documents and `GET /api/visit/:id` return 403; `/giniflow` and `/flow` routes are blocked.
- Rx HTML through **each** of the three paths: consultant's name, qualification and Reg. No. (not the MO's); history lines; only abnormal exam items; "Rest of the examination: NAD"; allergies "Not asked" printed when blank; MO's name absent.

Fixtures in `e2e/fixtures/data.mjs`: one flagged consultant, one unflagged consultant, one `rx_mo` assisting the flagged one, a New and a Follow-Up appointment.

## 8. Build order (each step tested before the next)

1. Migration + shared config + `rx_mo` role and capabilities. ✓ done 2026-10-26, verified on the e2e DB.
2. Workup service and API, with its tests. ✓
3. Server-side doctor block for all three Rx paths (fix in §4), with its tests. ✓
4. Workup on the printed Rx. ✓
5. `/visit` section UI. ✓
6. `assists_doctor_id`: scoping, patient guard, Doctor Management fields (role, "Assists", "New-patient workup" toggle), with the `rx_mo` tests. ✓

Tests: `e2e/visit/V01` (API + print), `V02` (the form in the browser), `V03` (`rx_mo` lock) — 22 passing.

## 9. Rollout

1. Migration applied to the e2e DB, then to production by you — **before** the code is deployed: `PATCH /api/doctors` and the workup queries read the new columns.
2. Switch on "New-patient workup" for Dr Anil Bhansali, Dr Beant, Dr Simran, and create the three `rx_mo` logins assisting Dr Bhansali (see §10).
3. Check on the first morning that a new Bhansali patient's printed Rx shows the workup and his name.

## 10. Settled at review

1. Dr Beant and Dr Simran book under their own names, so the flag keys on the appointment's doctor as planned.
2. The three `rx_mo` logins (Dr Jaschandrika, Dr Harshit, Dr Supreet) are created by Claude at rollout, after the migration, with generated 4-digit PINs handed to the user. This is a production write and is confirmed with the user just before it runs.

## 11. Changed while building

1. **Allergies are the patient's existing record**, not a copy in the workup. `patients.allergy_status / allergy_note` (24-ADDENDUM-V11 §5.1) is already filled at the Vitals and MO stations and printed on referral letters. The form reads and writes it through `server/services/patientAllergy.js` (extracted from the Vitals station's `saveAllergy`, same forward-only rules), using the shared vocabulary in `shared/giniflowAllergy.js`. It is only sent when the user changes it, so autosaves don't re-stamp who asked. "Known" needs the allergy named before it saves.
2. **`rx_mo` holds RECEPTION_OPS**, because the day's appointment list and `/visit` itself call `/api/appointments`. To stop that opening GHM, bookings and walk-ins, `server/middleware/assistedPatientGuard.js` is **fail-closed** for `rx_mo`: only these API paths answer, everything else is 403.

   | Path                                                                                           | Rule                                                                           |
   | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
   | `/api/auth/*`, `/api/home-stats`                                                               | open (home counts scoped to the assisted consultant)                           |
   | `/api/doctors*`, `/api/patient-schemes`                                                        | read-only                                                                      |
   | `/api/ai/complete`, `/api/ai/transcribe`, `/api/ai/deepgram-key`                               | open — **not** `/api/ai/agent` (SQL agent reads any patient)                   |
   | `/api/appointments` (list)                                                                     | read-only, `doctor` forced to the assisted consultant                          |
   | `/api/visit/:pid/*`, `/api/patients/:pid/*`, `/api/appointments/:id/*`, `/api/documents/:id/*` | the patient must be the consultant's; writes need today's appointment with him |
   | `/api/patient-block-status?patient_ids=`                                                       | every id must be the consultant's                                              |

   Menu badges that count across all patients (`/api/lab-requests`, `/api/conversations`) are refused and fail quietly. The nav shows only Home, Patient and Visit. An `rx_mo` with no consultant set can only log in.

3. **AI tools**: kept for `/visit`'s AI panel, but limited to the three endpoints above.
4. **Doctor Management**: "Writes prescriptions for" picker on an `rx_mo` login (required when adding one), and a "New-patient History & Examination" toggle under a consultant's Prescriptions settings. Only an active consultant can be assisted.

## 11b. MOs see only patients assigned to them (decided 2026-10-26)

The three MOs do not see all of Dr Bhansali's patients — a coordinator assigns each patient to one of them, and an MO sees only those.

- **Where it is assigned:** the Gini Flow triage board's Assign dialog gets a third picker, **"MO writing the prescription"**, listing the active `rx_mo` logins with how many each already has that day. Anyone who can use the triage board can assign. The card shows "Rx MO <name>". The existing "Chief Endocrinologist who leads the workup" (`assigned_sd_id`) slot is untouched, so floor routing and the Chief step don't change.
- **Data:** `giniflow_visits.rx_mo_id` (migration `2026-12-16_giniflow_rx_mo.sql`). The board reads it as `(to_jsonb(v)->>'rx_mo_id')::int`, so the board keeps working on a database where the migration hasn't run; assigning answers 409 "needs a database update" until it has. Each assignment writes an `audit_log` row (`rx_mo_assigned`, who, visit, MO).
- **Access:** an MO can open a patient ever assigned to them, and can write only for a patient assigned to them **today**. The day's list and home counts are their assigned patients only — whatever doctor the browser asks for. Everyone else answers 403 "This patient isn't assigned to you. Ask the coordinator to assign them on the triage board."
- **Production accounts (done 2026-10-26):** Dr. JasChandrika (id 10) and Dr. Harshit (id 55) converted to `rx_mo` assisting Dr. Anil Bhansali — they have no patients of their own; their old slot templates stay in the table but no longer offer slots. Dr. Supreet created (id 103). New PINs were given to the user. The form is switched on for Dr. Anil Bhansali (1), Dr. Beant Sidhu (5), Dr. Simranpreet Kaur (34).
- **Matching:** bookings match a consultant by name **or short name** (Dr. Beant Sidhu's short name is "Dr. Beant Kaur", used on 31 recent bookings). Bookings written just "Dr Simran" (25 recent) match no roster entry and don't get the form — left as is by the user's choice.

## 11c. Browser walkthrough fixes (2026-10-26, on the local test copy)

Walked every step in a real browser on localhost:3100 (coordinator assigns on the triage board → MO logs in → fills History & Examination → Print Rx). Three gaps found and fixed:

1. **Rx printed the MO's name when the patient was opened from Home.** Home doesn't pass the appointment id, so the print request carried none and the page fell back to the logged-in user. Now, with no appointment id, the Rx (Print, End visit, Regenerate) and the Visit header use the patient's **today's** appointment. Test V01 #13.
2. **An unassigned patient opened by link spun on "Loading visit data…" for ever.** The patient restore now keeps the refusal and the Visit page shows "This patient isn't assigned to you…" with a Go Home button.
3. **The MO's Home showed Book Appointment / New Patient / Search and the Messages, Alerts, Refills and Dose panels**, all refused for them. For `rx_mo` Home is now just their counts and today's assigned list ("No patients assigned to you yet today" when empty); those panels' requests aren't sent.

## 12. Found on the way

1. **Fixed (user approved):** the `/visit` header pill read `patient.allergies`, a column that doesn't exist, so it said "No known drug allergies" for every patient. It now uses `allergyLine()` from `shared/giniflowAllergy.js` — red "Allergies: …", green "None known — asked", amber "Not recorded anywhere — ask the patient".
2. **Fixed (user approved):** `POST /api/auth/login` no longer returns the PIN hash.
3. **Already failing on `main`, untouched:** `P1-28` (admin settings tabs), `P1-38` (reception billing APIs), `P4C-43` #11 (cash needs an open shift), `G16` #1 (GHM missed tab). `CF02` #9 failed once and passed twice on rerun (flaky).

## 13. Verification

- New: `e2e/visit/V01–V03`, 24 tests, passing (V03 covers triage assignment).
- Regression: 46 spec files around auth, permissions, scoping, Vitals, OPD, appointments, prescriptions and Doctor Management — all pass except the three in §12.3, which fail identically with these changes stashed.
- Before the migration: on a database without `new_patient_workups`, the form stays hidden, the Rx prints as today with the consultant's details, and a save answers 409 "needs a database update first".

## 14. Phase 2 — MOs and consultants on the Gini Flow stations (plan, awaiting approval)

Asked 2026-10-26: "why not from /giniflow/stations". Decisions:

| #   | Question                                      | Decision                                                                                        |
| --- | --------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 1   | Where do the MOs work                         | **Both**: the Gini Flow Doctor station (daily work) and `/visit` (already built)                |
| 2   | History & Examination on consultants' station | **Yes** — on the Doctor station consult screen for new patients of Dr Bhansali / Beant / Simran |
| 3   | When does the MO write the Rx                 | **In Dr Bhansali's room, during his consult** — the MO works his consult screen on his behalf   |
| 4   | Who presses Start consult / Finalize          | **The MO** (recorded as the MO; the Rx prints Dr Bhansali)                                      |

### What already works

The Doctor station's Finalize, Print and edit-after-finalize all build the Rx through `savePrescriptionForVisit` with the visit's appointment, so a station Rx already prints Dr Bhansali's name, qualification and Reg. No. and the History & Examination block (§4, §11c).

### What changes

1. **Launcher.** `/giniflow/stations` shows an `rx_mo` login one tile: the Doctor station. Their nav gains "GF Stations"; Home and `/visit` stay.
2. **Queue.** For an `rx_mo`, `/giniflow/station/doctor` lists **only the visits assigned to them today** (`giniflow_visits.rx_mo_id`), with the same cards, statuses and elapsed times the consultant sees. The "All / Mine" switch is hidden for them.
3. **Consult screen.** On a visit assigned to them, the MO is treated as the consultant: not read-only, can Start consult, write complaints / Rx / advice / tests / referrals, and Finalize. `visitOwnership` and `rowOwnership` (`server/services/giniflow/doctorStation.js`) accept the visit's assigned MO as well as the assigned consultant. Every action is logged under the MO's id, as today for any user. Floor timings ("with doctor", consult minutes) still count against Dr Bhansali, because the patient is in his room.
4. **History & Examination on the consult screen.** For a new patient of a flagged consultant, the consult page gets the same History & Examination section as `/visit` (the existing `VisitNewPatientWorkup` component and `/api/visit/:pid/workup`), placed before Complaints. Shown to the consultant and to the assigned MO. Follow-ups show the first workup read-only.
5. **Access, still fail-closed.** `rx_mo` gains `GINIFLOW_VIEW`, `GINIFLOW_STATION_DOCTOR` and `GINIFLOW_PRINT_RX`. The `rx_mo` guard (§11) adds only:
   - `GET /api/giniflow/stations/doctor` (the queue) and the launcher's own endpoint;
   - `/api/giniflow/stations/doctor/:visitId/*` — only for a visit assigned to them (writes: today only);
   - prescription-item / proposal endpoints keyed by row id — resolved to their visit and checked the same way;
   - reference lookups the consult screen needs (`test-panels`, `medicines/alternatives`).

   Everything else under `/api/giniflow` (board, triage, other stations, reports) stays 403 for them. The exact endpoint list is taken from the consult screen's real calls in a browser walkthrough, as for `/visit`.

6. **Doctor Management / triage:** no change — the coordinator's triage-board assignment (§11b) is what puts a patient in an MO's station queue.

### Tests

`e2e/visit/V04-rx-mo-doctor-station.spec.js`: the MO's station queue shows only their assigned visits; the consult screen is editable for an assigned visit and 403 for another; Start consult → write Rx → Finalize by the MO; the finalized Rx shows Dr Bhansali and the History & Examination; the consultant still sees and can open the same patient; other `/api/giniflow` paths stay closed. Plus a browser walkthrough on the local test copy, as before.

### Not changed

Who the floor routes to, Chief step, billing, the Rx desk and pharmacy flow. No new migration.
