# 92 — Outside reports: store each case's stage, read the list without recomputing

Follows [90](90-OUTSIDE-PENDING-LOAD-PLAN.md). 90 shares one result for 30 s. This plan removes
the heavy query from the read path entirely.

## Problem

The rule the lab works by is simple: **an outsourced sample stays on the list until its report
is uploaded**, then it drops off. Uploaded reports stay visible under **Uploaded** only on the
day they came in.

Scribe's own lab orders already follow that rule cheaply, because `giniflow_lab_orders` stores
`is_outsourced` and `sample_status`.

HealthRay lab cases (`lab_cases`) store neither. So every build of the list
(`outsidePending.js`, `PENDING_CTE`, the `case` branch) works out from scratch, for every case
in the last 30 days plus every case ever marked sent:

| Question | How it is worked out today |
|---|---|
| Is it outsourced? | `case_source = 'outsource'`, or every test name (flattened by regex) is on the outsourced list from Settings → Services |
| Was the sample taken? | Scribe's "sample taken" / "sent outside" actions, HealthRay JSON `phlebotomy_status` / `collected_on` |
| Is the report in? | `pdf_storage_path`, JSON `reported_on`, a `report_uploaded` action, the matching `documents` row |
| Is the case live? | not cancelled (action or HealthRay status), not "not on bill" (bill read, `lab_billing` step) |
| Is it already a Scribe order? | no `today` lab order for the same patient and day |
| Who is the patient? | `lab_cases.patient_id`, or a UHID lookup inside the JSON |

These facts change a few times a day per case. The list recomputes them for hundreds of cases
whenever it is built.

## Change

**Work out a case's stage when something about the case changes, store it on the case, and make
the list a plain read of stored values.**

### 1. Stored stage on `lab_cases`

New columns:

- `outside_stage text` — `'collected'`, `'sent'`, `'uploaded'`, or `NULL` (not on the list).
- `outside_uploaded_at timestamptz` — when the report was uploaded (drives "Uploaded today").
- `outside_stage_at timestamptz` — when the stage was last worked out (for checks and the sweep).

Partial index `ON lab_cases (outside_stage) WHERE outside_stage IS NOT NULL`, so the list reads
only the few dozen live rows.

### 2. One function works the stage out

`services/giniflow/outsideStage.js`:

- `refreshOutsideStage(db, caseNos)` runs **today's `case` branch predicate, unchanged**, scoped
  to `case_no = ANY($1)`, and writes the result with one `UPDATE … FROM (…)` that only touches
  rows whose stage actually changed (`IS DISTINCT FROM`).
- `sweepOutsideStage(db)` does the same for the whole window (cases from the last 30 days plus
  every case marked sent), in batches of 100 case numbers, one short transaction each.

Because the predicate is reused as it is, the list shows exactly the same cases as today.

### 3. When it runs

**Every stage change is saved at the moment it happens**, for the case (or the patient and day)
it affects. Nothing is re-checked on a list read.

| Event | Where |
|---|---|
| Sample taken, sent outside, any case action | `labStation.js` `markLabCaseAction`, `markCaseSentOutside`, `markCaseAtHome` |
| Report uploaded, replaced or deleted | `labStation.js` `uploadLabCaseReport`, `deleteLabCaseReport`, `labResults.js` `saveCaseResults` |
| Case or test cancelled / restored | `testCancel.js` `cancelCasesIn`, `cancelCaseTestIn`, `markCasesCancelledInHealthray`, `testRestore.js` |
| HealthRay lab sync: new case, updated case (blood taken, reported, cancelled), PDF stored, patient linked | `services/lab/db.js` `insertLabCase`, `markLabCaseSynced`, `linkLabCasePatient`, `downloadAndStoreLabPdf`, `setLabCaseSource`; `cron/labSync.js` after it writes a case |
| HealthRay bill read (a test taken off the bill) | `patientBill.js`, after the bill row is written: refresh that patient's cases for that day |
| Scribe lab order created for the same patient and day | `moStation.js` and `journey.js`, after the order insert: refresh that patient's cases for that day |
| `lab_billing` step marked done | the shared step-completion helper: refresh that patient's cases for that day |
| Outsourced tick or alias changed in Settings → Services | full sweep (rare) |

`refreshOutsideStageFor(db, { patientId, day })` covers the patient-and-day events: it finds
that patient's cases for that day and calls `refreshOutsideStage`.

**Safety check, once an hour**, in the worker: `sweepOutsideStage` over the whole window
(batched). It only corrects a stage that a missed code path left wrong, and logs how many it
fixed, so a missed path shows up in the log instead of silently.

### 4. The list reads stored values

- The `case` branch of `PENDING_CTE` becomes
  `FROM lab_cases lc WHERE lc.outside_stage IN ('collected','sent')
   OR (lc.outside_stage = 'uploaded' AND outside_uploaded_at is today)`,
  plus the cheap per-row joins for display (patient, sent by, document id). These run only for
  the listed rows.
- The `order` branch stays as it is. New partial index on `giniflow_lab_orders` for
  `is_outsourced AND kind = 'lab'` so it doesn't scan.
- The 30 s shared copy from plan 90 stays in front. With a cheap read it matters little, but it
  is already built and tested.

### Expected effect

A list build drops from 1–5 s, with temp-file spills, to a few milliseconds of index reads. The
heavy predicate runs only for the one case that changed, plus one safety sweep an hour, instead of
once per poll.

## Not changed

- What appears on the list, its stages, columns, filters, search, order, and actions (View,
  Replace, Mark sent).
- The badge count route and its 60 s polling.
- The HealthRay lab sync itself (only one call added after it writes a case).

## Risk

A path that changes a case without calling `refreshOutsideStage` leaves its stage stale until
the next hourly sweep. The sweep is the safety net. Test 8 below compares stored stages
with the live predicate so a missed path shows up.

## Rollout

1. Migration `2026-12-24_lab_cases_outside_stage.sql`: columns and indexes (index with
   `CONCURRENTLY`, applied on its own).
2. Backfill: `server/scripts/backfill-outside-stage.mjs`, dry run first, batches of 100,
   rerunnable (skips rows whose `outside_stage_at` is newer than the run start), stops on the
   first error. A few thousand cases at most.
3. Deploy the code that writes the stage (worker and API) **before** the code that reads it, or
   in the same deploy after the backfill. The read path falls back to nothing if the backfill
   has not run, so the order matters: migrate → backfill → deploy.

## Tests

New `e2e/giniflow/G131-outside-stage-stored.spec.js` (local test DB):

1. A new outsourced HealthRay case with the sample collected gets `outside_stage = 'collected'`
   when it is inserted through `insertLabCase`, and appears on the list.
2. **Mark sent** moves it to `'sent'` at once. The list shows "sent" with who sent it.
3. Uploading the report moves it to `'uploaded'` with `outside_uploaded_at` set. It shows under
   Uploaded today and leaves Collected / Sent. Deleting the report puts it back to `'sent'`.
4. A HealthRay `reported_on` arriving through the lab sync takes it off the list.
5. Cancelling the case (Scribe action or HealthRay status) clears the stage. Restoring brings it
   back.
6. An in-house case (test not outsourced) never gets a stage. Turning the test's outsourced tick
   on in Settings → Services gives it one at once (full sweep on that change).
7. A Scribe `today` lab order for the same patient and day clears the case's stage at once. A
   HealthRay bill read that takes the test off the bill clears it at once too.
8. **Same rows as before:** for a seeded mix (collected / sent / uploaded, several days,
   outsourced and in-house, cancelled, not on bill, covered by an order), the stored-stage list
   returns exactly the same rows, stages and order as the old live query.
9. The list build no longer runs the heavy predicate: a counting pool sees no `outside_names` /
   regex query on a list call.
10. The sweep is batched and rerunnable: a second run changes nothing, and it reports 0 fixed
    after the event paths above have run.

Existing `G63-outside-reports-pending`, `G64-outsourced-healthray-cases` and
`G129-outside-pending-shared` must pass unchanged.

Manual check after deploy:
- Lab Collection → Outside reports shows the same patients and badge number as before.
- Mark a sample sent, upload a report: both move at once.
- A day later, `pg_stat_statements`: the outside-pending query is gone from the top of total
  time, and the hourly sweep logs 0 (or very few) fixed stages.

## Decisions (30 Oct 2026)

1. **When stages are saved:** at the moment each event happens, including a bill read that takes
   a test off the bill, a Scribe order for the same patient and day, and the `lab_billing` step.
2. **Background check:** only a safety sweep once an hour, not every minute.
3. **30 s shared copy (plan 90):** kept in front of the list.

## Built (30 Oct 2026)

How "saved at the event" is done: **database triggers note every event, and the stage is worked
out from that note.** Hooking each of the ~20 code paths that change a case by hand would miss
some (scripts, the lab sync's many update paths). A trigger fires whichever code makes the change.

- Migration `2026-12-24_lab_cases_outside_stage.sql`:
  - `lab_cases.outside_stage`, `outside_uploaded_at`, `outside_stage_at`.
  - `giniflow_outside_stage_queue`, a small change queue (case, or patient and day, or "every
    case").
  - Triggers that add one queue row per event:
    - `lab_cases` insert, and updates of the columns that matter (dates, patient, HealthRay JSON,
      status, tests, source, PDF, results)
    - every `giniflow_lab_case_actions` change
    - a `giniflow_patient_bills` insert, or a status or items change
    - a `giniflow_lab_orders` insert, delete, or visit/kind/urgency change
    - a `lab_billing` step insert or status change
    - Settings → Services: outsourced tick, active, catalogue link, aliases, catalogue name
  - A trigger only adds one small row. It never runs the stage check inside the station's
    transaction.
- Index migrations `…_outside_stage_index_pending.sql` and `…_outside_stage_index_uploaded.sql`
  (`CONCURRENTLY`, one each).
- `services/giniflow/outsideStage.js`:
  - `refreshQueuedOutsideStages()` empties the queue and saves the stage of exactly those cases,
    in one statement.
  - `refreshOutsideStage(db, caseNos)` does the same for a given list of cases.
  - `sweepOutsideStage()` re-checks the whole window in batches of 100. It has a dry-run mode.
  - The predicate is today's, unchanged.
- `outsidePending.js`: the list empties the queue first, then reads the stored stage. The
  outsourced-name cache is gone, because the list no longer needs it.
- `middleware/outsidePendingRefresh.js`: one rule. Billing master changes clear the shared copy
  like lab actions do.
- Worker (`cron/index.js`): the hourly check `sweepOutsideStage`, logged as "Outside reports stage
  check: N of M case(s) corrected". `GINIFLOW_OUTSIDE_SWEEP_MS` overrides the hour.
- `server/scripts/backfill-outside-stage.mjs`: dry run by default, `--commit` to save. Batches
  of 100 with a short pause, rerunnable, stops on the first error.
- Tests:
  - `G131-outside-stage-stored` (11) passes.
  - `G63`, `G64` and `G129` pass. G129 test 5 now checks that a billing master change clears the
    shared copy (the name cache it used to test no longer exists). G129 also puts the 30 s window
    back after it runs, so later specs aren't served its cached rows.

Note found while building: "not on bill" only applies to a case whose sample was never taken, and
such a case is never on this list. So the bill and `lab_billing` triggers rarely change a stage.
They are kept because they cost one small row each.
