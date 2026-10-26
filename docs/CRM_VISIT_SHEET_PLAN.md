# CRM visit sheet — download my doctors, upload completed visits

Status: **built, reviewed and tested 2026-10-26** — 22 API + 8 browser tests (C17, C18). Production migration `2026-10-26_crm_visit_sheet.sql` not applied yet. Build notes in §12.

## 1. Goal

Each growth rep (Rajesh Sharma, Sandeep Sangroy, Virender Satija) can:

1. **Download** an Excel sheet of the doctors assigned to them, showing visits completed
   **today**, **this week** and **this month**.
2. Fill in the visits they completed (one row per visit) and **upload** it back.
3. Each valid row becomes a completed visit, so the counts on `/crm/home` (To visit, Today,
   Visits this month, Unique doctors) update straight away.
4. Rows that cannot be imported show on a **Failed** list with the reason, can be fixed and
   retried, and download as Excel with a Reason column.

Decisions already taken (2026-10-26):

| #   | Question             | Answer                                                                                                                                   |
| --- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Direction            | Both — download the sheet, upload it back                                                                                                |
| D2  | Who uploads          | Each rep for themselves; only their own assigned doctors                                                                                 |
| D3  | Sheet shape          | One row per visit                                                                                                                        |
| D4  | Same doctor/day      | Skip, shown as "Already logged" — never counted twice                                                                                    |
| D5  | Back-dating          | Only dates that feed today / this week / this month: from the earlier of the 1st of this month and this week's Monday, up to today (IST) |
| D6  | Statuses             | Completed, Doctor unavailable, Not visited                                                                                               |
| D7  | Undo                 | The rep can undo their own upload until midnight IST the same day                                                                        |
| D8  | Head of growth sheet | Summary tab per rep + team total; Visits tab only their own doctors                                                                      |

## 2. What exists today (from the code)

| Piece              | Where                                                                      | Relevant behaviour                                                                                                                                        |
| ------------------ | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Visit record       | `crm.visits`                                                               | No status column — a row **is** a completed visit. `executive_id`, `doctor_id`, `occurred_at`, `visit_type`, `outcome`, notes.                            |
| Visit write        | `server/crm/visits.js` `logVisit`                                          | One visit at a time from `/crm/visit/new`, idempotent on a client id.                                                                                     |
| Write policy (RLS) | `visits` insert policy                                                     | A rep may insert only with `executive_id = themselves` **and** a doctor they can access. A rep uploading their own sheet fits this with no loosening.     |
| Counts             | `repHome` in `visits.js`                                                   | `visits_today / visits_week / visits_month / unique_doctors_month` per rep, from `crm.visits`.                                                            |
| Doctor import      | `/crm/import`, `importDoctors.js`, `importAssign.js`, `importWorkbooks.js` | Upload → map → preview → commit, failed list + failed.xlsx. Staging in `crm.import_batches` / `crm.import_rows`. Locked to `CRM_IMPORT` (head of growth). |
| Excel              | `exceljs` (server), template + failed workbook                             | Reused for both workbooks here.                                                                                                                           |
| Undo policy (RLS)  | `visits_update`                                                            | A rep may update their own visit for 24 h after `created_at` — enough for a same-day soft delete, no policy change.                                       |
| Staging policy     | `import_batches_rw`                                                        | Head of growth can read **every** batch, a rep only their own. Visit batches add an explicit `uploaded_by = me` check on top (G7).                        |
| Due state          | `crm.v_doctor_visit_due`                                                   | `max(occurred_at)` over all non-deleted visits. An imported visit moves the doctor off **To visit** exactly like an app visit; undo puts it back.         |

**Existing bug this work fixes:** the today/week/month counts use `date_trunc(..., now())` on the
database clock, which is UTC. A visit logged between 00:00 and 05:30 IST counts as the
previous day, and the week/month roll over 5½ hours late. All new and existing counts move to
`Asia/Kolkata` days, with the week starting **Monday**.

## 3. Where it lives

- `/crm/home` header bar (next to the month summary): **Download my sheet** and **Upload visits**.
  Shown to everyone with `CRM_ACCESS` — reps included, unlike Import list.
- New page `/crm/visits/import` (lazy route, capability `CRM_ACCESS`): Upload → Preview → Done,
  same look as `/crm/import`, with **Back to CRM home**.
- No new capability. Who-can-write-what is enforced by RLS: the rep's own `executive_id`, their
  own doctors.

## 4. Download sheet (`GET /api/crm/visits/sheet.xlsx`)

File name `my-visits-<name>-<YYYY-MM-DD>.xlsx`. Two tabs.

### 4.1 Tab "Visits" — the upload template, pre-filled

One row per assigned doctor, ready to fill. Columns:

| Column                         | Filled by | Notes                                                                              |
| ------------------------------ | --------- | ---------------------------------------------------------------------------------- |
| Doctor ID                      | Sheet     | Hidden column, exact match on upload. Never edited by the rep.                     |
| Doctor                         | Sheet     | Full name                                                                          |
| Specialty, Area                | Sheet     | To recognise the doctor                                                            |
| Mobile                         | Sheet     |                                                                                    |
| Last visit                     | Sheet     | Date of the latest visit, IST                                                      |
| Today / This week / This month | Sheet     | This rep's completed visits to this doctor (Doctor unavailable included)           |
| **Visit date**                 | Rep       | Required. `DD-MM-YYYY` or an Excel date. Data validation: date, not in the future. |
| **Status**                     | Rep       | Dropdown: `Completed`, `Doctor unavailable`, `Not visited` (§6.4).                 |
| Visit type                     | Rep       | Dropdown from `VISIT_TYPES` (In person default)                                    |
| Outcome                        | Rep       | Dropdown from `VISIT_OUTCOMES`, optional                                           |
| Notes                          | Rep       | Optional, becomes `discussion_notes`, max 2,000 chars                              |

A rep who visited a doctor twice on different days copies the row. Rows with no Visit date
and no Status are ignored as "not filled", not failed. The pre-filled columns are greyed, not locked (§12). A rep with no assigned doctors gets the
sheet with a one-line note instead of rows. Values are written as plain string cells, so
nothing in a downloaded sheet runs as a formula.

### 4.2 Tab "Summary"

| Visits today | Visits this week | Visits this month | Unique doctors this month | Assigned doctors | Not visited this month |

Head of growth / admin downloads get one Summary row **per rep** plus a team total, and the
Visits tab covers only their own assigned doctors (they upload only for themselves, D2).

## 5. Upload flow

1. **Upload** — `.xlsx` / `.csv`, max 5 MB, max 2,000 rows. Header row auto-mapped (aliases:
   `visit date`, `date`, `visited on`; `status`, `visit status`; `doctor id`, `id`; `doctor`,
   `doctor name`, `name`…). A sheet that was not downloaded from §4 still works by matching on
   name/mobile (§6.1), with weaker guarantees.
2. **Preview** — server-side, paged (50 per page, same `ListPager`), filters **All / Ready /
   Already logged / Failed / Not visited**, counts at the top. Nothing is written yet.
3. **Confirm** — dialog: "Import **N** completed visits for **Rajesh Sharma** · M already
   logged will be skipped · F failed rows will not be imported." Then commit.
4. **Done** — imported / skipped / failed counts, **Download failed rows**, **Back to CRM home**.
   Failed rows can be fixed inline (doctor picker limited to my doctors, date field) and retried,
   like the doctor import.

## 6. Row rules

### 6.1 Row → doctor (first hit wins)

1. `Doctor ID` → that doctor, **and it must be assigned to me today**. Else fails:
   _"This doctor is not assigned to you"_ / _"Doctor ID not found — it may have been removed"_.
2. Mobile → one of my doctors with that mobile.
3. Name (+ area when given) → exactly one of my doctors. Two or more → fails
   _"More than one of your doctors is called X — pick the doctor"_ with a picker.
4. Nothing → fails _"No doctor of yours matches this name"_.

### 6.2 Field checks

| Check                                 | Failure reason shown                                          |
| ------------------------------------- | ------------------------------------------------------------- |
| Visit date missing (Status Completed) | "Enter the visit date"                                        |
| Not a date                            | "Visit date must be a date like 21-10-2026"                   |
| In the future (IST)                   | "Visit date is in the future"                                 |
| Before the window in D5               | "Only visits from DD-MM-YYYY to today can be uploaded"        |
| Ambiguous text date (`03/04/2026`)    | Always read day-first (DD-MM-YYYY); `MM/DD` is never guessed  |
| Status not in the list                | "Status must be Completed, Doctor unavailable or Not visited" |
| Visit type / outcome not in the list  | "Choose a visit type from the list"                           |
| Notes over 2,000 characters           | "Notes are too long (max 2,000 characters)"                   |

### 6.3 Duplicates (D4)

A row is **Already logged** when the same rep already has a visit to the same doctor on the same
IST day — logged in the app, an earlier upload, or an earlier row of this same file. Skipped,
never counted, listed in the failed export with that reason. Completed and Doctor unavailable
are the same for this check: one visit per doctor per rep per day.

The check runs again inside each commit chunk (not only at preview), under a per-rep
transaction advisory lock, so two uploads committed at the same time — two tabs, a double
click — cannot both insert the same visit (G4).

### 6.4 What a Completed row writes

`crm.visits` with `executive_id = me`, `occurred_at` = the visit date at 12:00 IST (date-only
sheets have no time; noon keeps the day stable) — **except today's date uploaded before noon,
which uses the upload time**, so a visit is never stamped in the future (G3). Visit type,
outcome, notes,
`source = 'sheet'`, `import_batch_id`. **Doctor unavailable** writes a visit too, with
`outcome = 'doctor_unavailable'` (the attempt counts, as it does when logged in the app); if
the row's Outcome column says something else, Status wins and the preview flags it.
**Not visited** rows write nothing and are shown as "Not visited" in the preview.

### 6.5 Undo (D7)

The Done screen and a small "My uploads" list on `/crm/visits/import` show **Undo this upload**
until midnight IST on the upload day. Undo soft-deletes (`deleted_at`) that batch's visits only —
never app-logged visits — after a confirm dialog naming the count and date range, and marks the
batch `cancelled`. Only the uploader can undo; it is audited by the existing visits trigger.

## 7. Data changes (one migration)

```sql
ALTER TABLE crm.import_batches ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'doctors'
  CHECK (kind IN ('doctors', 'visits'));
ALTER TABLE crm.visits ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'app'
  CHECK (source IN ('app', 'sheet'));
ALTER TABLE crm.visits ADD COLUMN IF NOT EXISTS import_batch_id uuid REFERENCES crm.import_batches(id);
```

Plus visit-row staging columns on `crm.import_rows`: `visit_date date`, `visit_status`,
`visit_type`, `visit_outcome`, `visit_notes`, `visit_state` (`ready | already_logged | failed |
not_visited | not_filled | imported`) and `visit_id`. The existing `outcome` column has a CHECK
list for doctor imports, so visit rows use their own `visit_state` instead of widening it (G8).
`fail_reason` is reused. A partial index `crm.visits (executive_id, doctor_id, occurred_at)` for
the duplicate check.

Existing doctor imports are untouched (`kind` defaults to `doctors`). **Every** existing
`/crm/import/batches/:id/...` endpoint gets a `kind = 'doctors'` guard and the new endpoints a
`kind = 'visits'` guard, so a batch id can never be replayed through the other flow (G6).
The new CHECK values (`kind`, `source`, `visit_state`) go into `shared/crmVocab.js` so
`checkVocabSync` keeps passing (G9).

## 8. Server

- `server/crm/visitSheet.js` — `sheetWorkbook(crmUser)`, `createVisitBatch`, `previewVisitBatch`
  (paged), `commitVisitChunk`, `retryVisitRows`, `failedVisitWorkbook`.
- Routes in `server/routes/crm.js` under `/crm/visits/sheet.xlsx` and
  `/crm/visits/import/batches/...`, all `CRM_ACCESS`, all through `withCrmContext` so RLS applies.
  A rep can only ever read and commit their own batches (`uploaded_by = me`).
- Commit in chunks of 100 rows, each its own short transaction, rerunnable (rows already
  imported are skipped) — per the bulk-change rule.
- Safe error messages only ("Unable to read the sheet. Please check it is an Excel file").
- One shared SQL helper for the IST day / Monday week / month boundaries, used by `repHome`,
  the Today list, the sheet and the summary — so the sheet and `/crm/home` can never disagree
  (G1).
- The new module uses `withCrmContext` only (the `checkNoDirectPool` guard enforces it).

## 9. Client

- `src/pages/crm/VisitSheetPage.jsx` (+ small components under `src/components/crm/visits/`),
  reusing `ListPager`, `ListToolbar`, `ConfirmModal` and the import wizard's step styles.
- Two buttons on the `/crm/home` month bar.
- Doctor 360 timeline and the Today list tag sheet visits **From sheet** so a manager can tell
  them from visits logged on the spot (G11).
- The upload page works on a phone (reps are on the move): single column, file picker,
  preview as cards below 560 px.

## 10. Tests (e2e, local test DB)

`e2e/crm/C17-visit-sheet.spec.js`:

1. Download has my doctors only, correct today/week/month counts, hidden Doctor ID.
2. Upload filled sheet → preview counts → commit → `/crm/home` counts rise.
3. Already-logged (app visit, same file twice, re-upload) is skipped and not double-counted.
4. Another rep's doctor ID → "not assigned to you"; future / bad date / bad status fail.
5. Name-only sheet: unique match imports, ambiguous name asks to pick.
6. Retry a fixed failed row; failed.xlsx has the Reason column.
7. Rep cannot open another rep's batch (403/404).
8. IST boundary: a visit at 00:30 IST counts as today.
9. Doctor unavailable creates a visit with that outcome; Not visited writes nothing.
10. A date before the D5 window fails with the window in the message.
11. Undo same day removes only that batch's visits; after midnight IST it is refused.
12. Today's date uploaded at 10:00 IST is stamped 10:00, not 12:00.
13. Two concurrent commits of the same file insert each visit once.
14. A visits batch id sent to a doctor-import endpoint is refused, and the reverse.
15. Head of growth cannot commit or undo a rep's visit batch.

## 11. Review — gaps found and how the plan covers them

| #   | Gap                                                                                                     | Covered in |
| --- | ------------------------------------------------------------------------------------------------------- | ---------- |
| G1  | Counts on the sheet and on `/crm/home` must use the same IST boundaries                                 | §8         |
| G2  | Week crossing a month start (e.g. Thu 1st) — Mon–Wed of that week still uploadable                      | D5         |
| G3  | Noon stamp on today's date before noon would be a future visit                                          | §6.4       |
| G4  | Duplicate race between two commits                                                                      | §6.3       |
| G5  | Offline app visit synced after the sheet upload can still double-count (the app path has no day dedupe) | D9         |
| G6  | Batch id replayed across doctor/visit flows                                                             | §7         |
| G7  | Head of growth can read every batch under RLS; D2 means they must not commit/undo a rep's               | §2, §8     |
| G8  | `import_rows.outcome` CHECK list is doctor-only                                                         | §7         |
| G9  | Vocab CHECK guard in CI                                                                                 | §7         |
| G10 | Doctor reassigned mid-month: the old rep can no longer upload an earlier visit to them                  | D10        |
| G11 | Managers need to tell sheet visits from on-the-spot visits                                              | §9         |
| G12 | Formula injection in downloaded sheets                                                                  | §4.1       |
| G13 | `DD/MM` vs `MM/DD` text dates                                                                           | §6.2       |
| G14 | Rep with zero assigned doctors                                                                          | §4.1       |
| G15 | Status vs Outcome conflict on a Doctor unavailable row                                                  | §6.4       |
| G16 | Uploading from a phone                                                                                  | §9         |

### Decided after review (2026-10-26)

- **D9** (G5): one visit per doctor per rep per IST day **everywhere**. `logVisit` (the app and
  the offline queue) runs the same day check under the same per-rep lock. A second visit that
  day is not inserted and returns `{ duplicate: true, reason: "already_logged_today" }`, so the
  offline queue still drains instead of retrying forever; the visit form shows
  "Already logged today for Dr X" and links to the existing visit. Test 16: an app visit after a
  sheet visit for the same doctor/day is not inserted and the queue empties.
- **D10** (G10): only doctors assigned to the rep **now**. A reassigned doctor's earlier visit
  fails with "This doctor is not assigned to you"; no access-rule change.

## 12. Build notes (2026-10-26)

- **Changed from the plan:**
  - **The pre-filled columns are not locked.** Copying a row for a second visit means pasting
    into them, and a protected sheet would block that. They are greyed instead (blue headers for
    the columns the rep fills).
  - **No formula prefix is added.** The server writes every value as a plain string cell, so
    Excel never runs it as a formula. A prefix would only alter the data.
  - **The visit form disables Save** when this doctor already has a visit today, and shows
    "Already logged today…" with a link to that visit. The server rule (D9) still applies to
    queued offline visits.
- **Files:**
  - server:
    - `server/crm/visitSheet.js` (new);
    - `server/crm/istPeriods.js` (new);
    - `server/crm/visits.js`: IST counts, the same-day rule and the per-rep lock;
    - `server/routes/crm.js`: the `/crm/visits/*` routes, plus the `kind` guard on
      `/crm/import/batches/:id`;
  - shared: `shared/crmVocab.js`;
  - client:
    - `src/pages/crm/VisitSheetPage.jsx`;
    - `src/components/crm/visits/*`;
    - CRM home buttons;
    - visit-form notice;
    - "From sheet" tags;
    - the route and its capability;
    - `src/styles/crm.css`;
  - CI smoke: `server/scripts/smoke-crm-visits.mjs` now logs its second same-doctor visit on the
    previous day and asserts the one-per-day rule.

### Review fixes (2026-10-26, second pass)

- **Row numbers stay true with blank rows.** Rows are numbered from the sheet's own row (`__rowNum__`),
  so a blank row no longer shifts the numbers shown on failed rows and in the export.
- **The date rule in the sheet is `TODAY()`, as a warning.** Before, the check was fixed at the
  download date, so a sheet downloaded on Monday blocked Tuesday's visits.
- **`Dr.Asha Kapoor` (no space) matches `Dr Asha Kapoor`.**
- **Half-staged uploads are closed off.** If an upload fails while its rows are being saved, it is
  marked `failed`, hidden from "Your recent uploads", and cannot be imported.
- **Download file names are cleaned** before they go into the download header.
- **A row lists every problem at once,** so the rep fixes it in one pass.
- **The doctor picker falls back to the rep's own doctors** when the typed name matches nobody.
  Before, it showed an empty list.
- **"Back to CRM home"** is no longer underlined.
- **Test cleanup** relies on the CASCADE truncate. Visits block hard deletes, so a plain DELETE
  would fail once rows exist.

### Follow-up (2026-10-26, D11 — revised)

The sheet has one follow-up column, **Next visit date**. It must be a date after the visit date
and within a year, and the cell warns otherwise. The "Needs follow-up" Yes/No column was added
and then removed at the user's request.

- **A filled Next visit date** saves the visit with `follow_up_required = true` and that
  `next_visit_date`. The doctor's page shows "Follow-up by …".
- **A blank date** means no follow-up. Nothing is filled in from the visit schedule.
- **An older sheet** that still has a "Needs follow-up" column uploads fine. That column is
  ignored.

Failed rows with a bad next visit date get a **Next visit date** field in the fix panel; clearing
it imports the visit with no follow-up. The To visit list and the counts are unchanged.

### Recent uploads list (2026-10-26)

"Your recent uploads" lists only uploads that imported at least one visit (`created_count > 0`).
That includes uploads later undone, which show as "Undone". Hidden from the list:

- uploads that were previewed but never imported;
- uploads where every row failed;
- uploads that failed to read.

The data itself is kept, because `crm.import_batches` and `crm.import_rows` block hard deletes.
Two of Rajesh's previewed-only test uploads on production were also marked `cancelled` on request.
