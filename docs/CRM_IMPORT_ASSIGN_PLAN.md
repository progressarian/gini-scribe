# CRM import — "Assigned to" column

Status: **steps 1–6 built and tested 2026-10-17** (35 e2e tests on the local test DB). Step 7 —
the production migration and the real sheet — waits for your go-ahead. Build notes in §13.

## 1. Goal

On `/crm/import`, a sheet can carry an **Assigned to** column holding one of the growth staff
(Virender Satija, Rajesh Sharma, Sandeep Sangroy). On import:

1. Each row's typed name is matched to a CRM user and the doctor is assigned to them.
2. Rajesh and Sandeep then see only their own doctors on `/crm/home`; Virender sees all (§11 D2).
3. Rows that could not be matched land on a **Failed** list showing the typed name, the reason,
   the closest staff names and a picker of the assignable staff. The operator picks and
   re-submits just those rows.
4. Anything still failing downloads as an **Excel file with a Reason column**.

## 2. What exists today (from the code)

| Piece             | Where                                                                           | Relevant behaviour                                                                                                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wizard UI         | `src/pages/crm/DoctorImportPage.jsx`                                            | Upload → Map columns → Preview → Done. Renders every preview row client-side.                                                                                                                                                       |
| Fields + parsing  | `server/crm/importDoctors.js` `IMPORT_FIELDS`, `suggestMapping`, `interpretRow` | Header aliases auto-map columns. No assignee or doctor-ID field.                                                                                                                                                                    |
| Preview           | `previewBatch`                                                                  | Computed in memory on every call, nothing stored. Dedupes by mobile (hard `duplicate`) and name+territory (`possible_duplicate`).                                                                                                   |
| Commit            | `commitBatch`                                                                   | Re-runs the preview, inserts new doctors; **hard duplicates are skipped**, so an existing doctor is never touched. One transaction for the whole file, one INSERT per row.                                                          |
| Ownership         | `crm.doctor_assignments`                                                        | One open row per doctor (`effective_to IS NULL`); a gist exclusion forbids overlapping periods. Write policy: `ceo_admin`, `head_of_growth`, `growth_manager`. Already audited by `trg_doctor_assignments_audit` → `crm.audit_log`. |
| Doctor visibility | `crm.doctors` policy `doctors_read` → `crm.can_access_doctor`                   | `ceo_admin` / `head_of_growth` / `operations` see every doctor; everyone else only doctors assigned to them or their reports. **This applies to the import's own duplicate check too** (§12 C2).                                    |
| Mobile identity   | unique index on `crm.doctors (hospital_id, mobile_e164)`                        | A second doctor with the same mobile cannot be inserted.                                                                                                                                                                            |
| Onboarding script | `server/scripts/crm-onboard-user.mjs`                                           | Assigns a whole territory, never reassigns. No per-doctor assignment anywhere in UI or API.                                                                                                                                         |

**The sheet you shared** (`crm-home-2026-10-14.xlsx`, from `server/scripts/export-crm-home.mjs`)
has a `Doctors` tab of **587 doctors that already exist in the CRM** (full name, specialty, area,
city, priority, relationship stage, mobile, profile complete, missing fields, needs
verification, territory name, due state, last visit at — no doctor ID, the export hides it).
Importing it today marks nearly every row a duplicate and skips it, so this feature is mostly
**bulk-assigning existing doctors from a sheet**, plus assigning new doctors as they are created.

81 of the 587 have no mobile; on those rows the only identity is name + area, which is not
reliably unique. The template (§5.1) exists to remove that guesswork.

## 3. Sheet format

| Column                              | Required        | Notes                                                                                                       |
| ----------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------- |
| Doctor ID                           | In the template | New import field `doctor_id`; header aliases `doctor id`, `doctorid`, `id`. Exact match.                    |
| Full name, mobile, area, territory… | As today        | Used to match when Doctor ID is absent, and to create new doctors.                                          |
| **Assigned to**                     | Optional        | New import field `assigned_to`; aliases `assigned to`, `assignee`, `owner`, `rep`, `executive`, `assigned`. |

Blank **Assigned to** leaves the doctor's current owner unchanged (§11 D5).

## 4. Matching rules

### 4.1 Row → doctor

First hit wins:

1. `Doctor ID` present → that doctor. ID not found or doctor deleted → row fails _"Doctor ID not
   found — it may have been removed"_.
2. Normalised mobile equals an existing doctor's (not a shared clinic line — today's rule) →
   that doctor.
3. Name + territory/area matches **exactly one** existing doctor → that doctor, flagged
   _"matched by name — check"_.
4. Name + territory matches **more than one** → fails _"2 doctors named X in Mohali — add the
   mobile or Doctor ID"_.
5. No match → new doctor (existing create path), then assigned.

A doctor that resolves from **two rows in the same file** → the later row fails _"Same doctor as
row 12"_. (Two assignments for one doctor in one transaction would also trip the exclusion
constraint.)

Matched existing doctors are **never edited** beyond their assignment — the sheet's specialty,
area etc. on a matched row are ignored, since an exported copy can be stale.

### 4.2 Typed name → CRM user

Assignable staff = active `crm.users` with role `growth_executive`, `growth_manager` or
`head_of_growth`. `ceo_admin` is excluded, so the CEO "Sandeep" is never a candidate (§11 D1).
Normalise: lower-case, drop "Dr"/"Mr"/"Ms", punctuation and extra spaces.

| Rule                                                             | Example                             | Result                                                                                         |
| ---------------------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------- |
| Exact full name                                                  | `rajesh sharma`                     | Matched                                                                                        |
| First name alone, unique among assignable staff                  | `Sandeep`, `Virender`               | Matched — flag _"matched by first name"_                                                       |
| First name exact + surname within 2 letters, only one such staff | `Sandeep Sangory` → Sandeep Sangroy | Matched — flag _"check spelling"_ (§11 D3)                                                     |
| First name itself misspelt                                       | `Ramesh`, `Rajsh Sharma`            | **Failed** — _"No staff named Ramesh. Closest: Rajesh Sharma"_; picker pre-selects the closest |
| More than one candidate (e.g. a future second Rajesh)            | `Rajesh`                            | Failed — _"Matches 2 staff: …"_                                                                |
| Name of someone who is not assignable                            | `Gurjot`                            | Failed — _"Gurjot is not on the growth team"_                                                  |

The first name must be exact before a near-miss surname is accepted; a plain edit-distance
rule would turn "Ramesh" into Rajesh Sharma silently (§12 C3).

`resolveAssignee(typed, staff)` is a pure function in `server/crm/assignees.js` so the table above
is testable without a database.

## 5. UI (existing wizard, extended — no new page)

Only `ceo_admin` and `head_of_growth` see the assignment parts (§12 C2). Today that is Gurjot,
the CEO Sandeep, Virender — and Rajesh/Sandeep Sangroy until they move back to executive.

### 5.1 Upload step

- Secondary button **Download doctors template** → `GET /api/crm/import/template.xlsx`
  (built server-side with `exceljs`): every doctor, columns Doctor ID (hidden), name,
  specialty, mobile, area, territory, priority, **Assigned to** pre-filled with the current
  owner, and a dropdown (data validation) of the assignable staff names. If someone deletes the
  hidden column, matching falls back to mobile, then name.

### 5.2 Map columns step

- `Doctor ID` and `Assigned to` appear in the field list and auto-map from their aliases.

### 5.3 Preview step

Summary strip:

```
587 rows   Virender Satija 210   Rajesh Sharma 190   Sandeep Sangroy 160   New 0   Unchanged 20   Failed 7
```

- Filter chips **All · Will assign · New doctors · Unchanged · Failed**; search _"Search by
  doctor name, mobile or typed staff name"_.
- Columns: Row · Doctor (name, specialty, mobile) · Matched by (ID / mobile / name / new) ·
  Assigned to (typed → resolved, e.g. `Sandeep Sangory → Sandeep Sangroy · check spelling`) ·
  Current owner · Result.
- Filter, search and pagination (50 per page) run in SQL: the preview step **stores** each row's
  resolution on `crm.import_rows` (§7) — it still writes nothing to `crm.doctors` or
  assignments.
- Failed rows are visible here, read-only, so nothing is a surprise; they are fixed after the
  import (step 5.4), as you described the flow.
- Primary action **Import and assign 580 rows** (excludes Failed).

### 5.4 Importing + Done step

- The browser commits in chunks of 100 rows (one request per chunk) and shows real progress:
  _"Assigning… 300 of 580"_. A closed tab or error stops after the last finished chunk; reopening
  the batch and pressing the button again continues from there.
- Done: counts per staff member, plus New doctors / Reassigned / Unchanged / Failed.
- **Failed list** (when Failed > 0):

```
Row  Doctor               Typed name   Reason                                Assign to
33   Dr P Gupta           Ramesh       No staff named Ramesh                 [ Rajesh Sharma  ▾ ]
40   Dr K Bansal          (blank→n/a)  Same doctor as row 12                 — fix in sheet —
51   Dr R Singh (Mohali)  Rajesh       2 doctors named R Singh in Mohali     — fix in sheet —
```

- Picker = assignable staff; pre-selected when there is exactly one suggestion.
- Rows that failed on the **doctor** (ambiguous, ID not found, repeated) have no picker — a
  staff name cannot fix them.
- **Retry selected (n)** → re-runs only those rows with the chosen staff; the list refreshes.
- **Export failed rows** (secondary, while any remain) → `GET
/api/crm/import/batches/:id/failed.xlsx`: original columns exactly as uploaded
  (`import_rows.raw`) + `Reason` + `Suggested staff`. Fix and upload it through the same wizard.

States: loading text on buttons (`Building preview…`, `Assigning… n of m`, `Retrying…`),
skeleton rows while a preview page loads, empty Failed filter _"No failed rows — every row
matched"_, the existing `dimp__err` banner with a plain message (no SQL text), toasts only as an
extra to the on-page counts.

## 6. API

All behind the existing `crm` middleware; every query through `withCrmContext` (the CI guard
`checkNoDirectPool.mjs` fails the build otherwise).

| Method | Path                                               | Change                                                                                                                  |
| ------ | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| GET    | `/crm/import/fields`                               | adds `doctor_id`, `assigned_to`                                                                                         |
| GET    | `/crm/import/assignees`                            | **new** — assignable staff for the picker                                                                               |
| GET    | `/crm/import/template.xlsx`                        | **new**                                                                                                                 |
| POST   | `/crm/import/batches/:id/resolve`                  | **new** — runs matching, stores results on `import_rows`, returns counts. Replaces computing the preview on every read. |
| GET    | `/crm/import/batches/:id/preview?status=&q=&page=` | now a paged SQL read of the stored resolution                                                                           |
| POST   | `/crm/import/batches/:id/commit`                   | body `{ limit: 100 }`; processes the next ≤100 `pending` rows in one transaction, returns `{ done, remaining, counts }` |
| POST   | `/crm/import/batches/:id/retry`                    | **new** — `{ rows: [{ row_number, assignee_id }] }`; re-resolves and commits only those rows                            |
| GET    | `/crm/import/batches/:id/failed.xlsx`              | **new**                                                                                                                 |

Assignment endpoints return 403 _"Only an admin or the head of growth can assign doctors"_ to
other roles before touching the database.

## 7. Data model

Migration `server/migrations/2026-10-XX_crm_import_assign.sql` (columns only, no policy change):

```sql
ALTER TABLE crm.import_rows
  ADD COLUMN IF NOT EXISTS doctor_match     text CHECK (doctor_match IN ('id','mobile','name','new')),
  ADD COLUMN IF NOT EXISTS assignee_typed   text,
  ADD COLUMN IF NOT EXISTS assignee_id      uuid REFERENCES crm.users(id),
  ADD COLUMN IF NOT EXISTS assignee_note    text,
  ADD COLUMN IF NOT EXISTS assign_status    text
    CHECK (assign_status IN ('pending','assigned','unchanged','skipped','failed')),
  ADD COLUMN IF NOT EXISTS fail_reason      text;
```

Existing `status` / `matched_doctor_id` keep their meaning; an existing doctor that only gets an
owner ends `status='updated'` (already allowed by the CHECK).

Assignment write (`server/crm/assignments.js`, reusable later for a per-doctor Reassign button),
set-based per 100-row chunk:

1. Same open owner → `unchanged`, nothing written.
2. Otherwise close the open row (`effective_to = now()`) and insert the new one: `executive_id`,
   `manager_id` = the assignee's manager (none today), `territory_id` = the doctor's,
   `assigned_by` = operator, `reason = 'Import <file>, row <n>'`. The audit trigger records both
   writes; the assignment history itself shows who, when and why.

**Bulk-write rules (CLAUDE.md):** 100 rows per transaction, one set-based statement per step
(`… FROM jsonb_to_recordset($1)`), commit before the next chunk, only `pending` rows are picked
up so a rerun never double-assigns or double-creates, the first error stops the run. New-doctor
inserts move to the same chunked path (today they are one long transaction).

## 8. Roles after the import (§11 D2)

RLS already narrows a `growth_executive` to their assigned doctors — nothing to build. After the
real import is committed, Rajesh Sharma and Sandeep Sangroy are moved back to
`growth_executive` with `crm-onboard-user.mjs --role growth_executive --commit`. Auto mode blocks
me from changing roles, so you run those two commands (or approve them outside auto mode).
Virender stays `head_of_growth`.

## 9. Tests

**e2e (Playwright, local test DB only)** — new folder `e2e/crm/`, the first Playwright CRM
suite. The test DB applies every migration not in `baseline-migrations.txt`, which includes the
CRM ones; step 1 confirms the `crm` schema and `crm_app` role really come up there.

| Spec                                    | Checks                                                                                                                  |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `C01-assign-columns-map.spec.js`        | "Doctor ID" and "Assigned to" auto-map                                                                                  |
| `C02-assign-existing-by-mobile.spec.js` | existing doctor matched by mobile is assigned, not skipped; old assignment closed, new one open, audit rows written     |
| `C03-assign-by-doctor-id.spec.js`       | template round-trip: download, change owners, re-upload → only changed rows reassigned, rest Unchanged                  |
| `C04-assignee-name-rules.spec.js`       | "Sandeep" and "Sandeep Sangory" → Sandeep Sangroy (flagged); "Ramesh" → Failed with Rajesh suggested; CEO never offered |
| `C05-failed-retry.spec.js`              | Failed → pick staff → Retry → assigned                                                                                  |
| `C06-failed-export.spec.js`             | xlsx has the original values + Reason + Suggested staff                                                                 |
| `C07-doctor-failures.spec.js`           | ambiguous name, unknown ID, same doctor twice → Failed, no picker                                                       |
| `C08-executive-sees-only-own.spec.js`   | after import, executive's `/crm/home` lists only their doctors                                                          |
| `C09-who-can-assign.spec.js`            | growth_manager / executive get the plain 403; assignment UI hidden                                                      |
| `C10-chunked-commit-resumes.spec.js`    | ~250 rows; stop after chunk 1, resume → all assigned once, no duplicate doctors                                         |

Fixtures: Virender (head_of_growth), Rajesh and Sandeep Sangroy (growth_executive), a CEO
"Sandeep" (ceo_admin), ~250 doctors including no-mobile and same-name pairs.

**No-DB checks:** `server/scripts/smoke-crm-assignee-match.mjs` runs the §4.2 table.
**CI:** `checkNoDirectPool.mjs`, `checkVocabSync.mjs` and the RLS suite in
`.github/workflows/crm-guards.yml` must stay green.

## 10. Delivery steps (each tested before the next)

1. Migration + `resolveAssignee` + smoke cases; confirm CRM schema in the test DB.
2. `doctor_id` / `assigned_to` fields, `/resolve`, paged `/preview`; C01, C04, C07.
3. Chunked commit with assignments; C02, C10.
4. Failed list + `/retry`; C05.
5. Template + failed export; C03, C06.
6. Role gate; C08, C09.
7. Production: resolve your real sheet (writes only to `import_rows`), report counts to you,
   commit on your go-ahead, then you move Rajesh/Sandeep back to `growth_executive`.

## 11. Decisions (2026-10-17)

- **D1** — Two different Sandeeps: "Sandeep" (ceo_admin) is the CEO; "Sandeep Sangroy" is growth
  staff. `ceo_admin` is not assignable, so "Sandeep" means Sandeep Sangroy.
- **D2** — Rajesh and Sandeep Sangroy see only their own doctors (back to `growth_executive`
  after the import); Virender stays `head_of_growth` and sees all.
- **D3** — A near-miss surname auto-matches with a "check spelling" flag.
- **D4** — Template download is in scope.
- **D5** (default) — Blank "Assigned to" leaves the current owner unchanged.
- **D6** (changed by the re-check, §12 C2) — Only `ceo_admin` and `head_of_growth` can run an
  assigning import, not `growth_manager`.

## 12. What the re-check changed

- **C1** — Removed leftovers that contradicted D1 (the "Sandeep is ambiguous" fact and examples).
- **C2** — The import's duplicate check reads `crm.doctors` under RLS. A `growth_manager` sees only
  their team's doctors, so every other existing doctor would look **new**: the import would try
  to create duplicates and hit the unique-mobile index (or silently create no-mobile duplicates).
  Assigning imports are therefore limited to roles that see every doctor.
- **C3** — The fuzzy rule was too loose: edit distance ≤ 2 would have matched "Ramesh" to Rajesh
  Sharma. Now the first name must be exact before a surname typo is accepted.
- **C4** — Added the doctor-level failures that were missing: Doctor ID not found, and the same
  doctor on two rows (which would also break the no-overlap constraint).
- **C5** — Added the `doctor_id` import field; without it the template's Doctor ID column could
  not be read back.
- **C6** — The preview was going to be paged while still computed in memory on every call;
  resolution is now stored on `import_rows`, so paging, search, retry and the failed export all
  read the same stored result.
- **C7** — "Progress per batch" was not possible from one long request. Commit is now driven by
  the browser in 100-row requests: real progress, short transactions, natural resume. New-doctor
  inserts move to the same chunked path.
- **C8** — Noted that assignments are already audited by an existing trigger (nothing to add),
  and that the role switch back to `growth_executive` needs you to run it.

## 13. Build notes (2026-10-17)

Files: `server/crm/assignees.js` (name matching), `server/crm/importAssign.js` (resolve, paged
rows, chunked commit, retry, failed rows), `server/crm/importWorkbooks.js` (template + failed
export), `server/crm/importDoctors.js` (new fields, doctor-ID/assignee classification),
`server/routes/crm.js`, `src/pages/crm/DoctorImportPage.jsx`,
`src/components/crm/import/*`, `src/lib/downloadBlob.js`, `src/styles/crm.css`, migration
`server/migrations/2026-10-17_crm_import_assign.sql`, tests `e2e/crm/C01–C12` +
`e2e/helpers/crm.mjs`, `server/scripts/smoke-crm-assignee-match.mjs`.

Differences from §6/§7:

- Paged rows are `GET /crm/import/batches/:id/rows` and counts `GET …/summary`; the old
  `GET …/preview` is left untouched for `crm-import-doctors.mjs`.
- The migration also adds `import_batches.headers` (original column order for the failed
  export) and `import_rows.outcome` / `flags` (the stored preview result).
- The failed export is named after the uploaded file by the browser
  (`<file>-failed-rows.xlsx`).
- The old `commitBatch` (scripts only) now creates only `create` / `possible_duplicate` rows,
  so it can never insert a second copy of a doctor the assignment path matched.

**Pre-existing issue found while testing (not fixed here):** a `growth_manager` importing a
_plain_ doctor list also runs the duplicate check under RLS, sees only their team's doctors,
and the commit fails with "A doctor in this file already exists in the CRM" when the list
contains an unassigned doctor already in the CRM. Same root cause as §12 C2. Options: restrict
every import to `ceo_admin` / `head_of_growth`, or add a SECURITY DEFINER mobile lookup for the
duplicate check.

**Added after the first real preview (2026-10-17):** staff can be chosen or corrected in the
preview itself, not only after the import. Every assignment row has an "Assigned to" dropdown
(`POST /crm/import/batches/:id/pick`); a failed row with a suggestion marks it "(suggested)".
Rows that failed on the doctor have no dropdown. Tested in `e2e/crm/C13-pick-in-preview.spec.js`.
