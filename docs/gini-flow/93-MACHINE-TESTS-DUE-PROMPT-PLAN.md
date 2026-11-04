# 93 — "Tests due" prompt for ABI, VPT, Fundus and Echo

## Problem

ABI, VPT and Fundus are repeated yearly and Echo every six months for patients
who already have them on file. Today nothing reminds the doctor. A test
falls due only if someone remembers the date of the last report.

## Who sees it

| Screen                              | Route                            | Page                                                   |
| ----------------------------------- | -------------------------------- | ------------------------------------------------------ |
| Consultant                          | `/giniflow/station/doctor`       | `DoctorConsultPage` (Tests via `consult/TestsSection`) |
| Chief Endocrinologist (Dr Bhansali) | `/giniflow/station/mo`           | `MoStationPage`                                        |
| Dr Bhansali's Rx MO                 | `/giniflow/station/mo` (plan 89) | `MoStationPage`                                        |

The capability gates stay as they are (`doctorGate`, `moGate`), so no
`shared/permissions.js` changes are needed.

## Rule

A test is **due** for a patient when all of these are true:

1. The patient **has done it before**: there is at least one earlier record (see
   Evidence). A patient with no record of the test is **never** prompted.
2. The **latest** record is older than the interval:

   | Test   | Interval  | Floor machine id | Document `doc_type` |
   | ------ | --------- | ---------------- | ------------------- |
   | ABI    | 12 months | `abi`            | `abi`               |
   | VPT    | 12 months | `vpt`            | `vpt`               |
   | Fundus | 12 months | `fundus`         | `eye`               |
   | Echo   | 6 months  | `echo`           | `echo`              |

3. It is **not already ordered on this visit**, and no order is open for it
   (any `giniflow_lab_order_tests` row for the visit that resolves to that
   machine and is not cancelled).
4. **Nobody has already decided on it for this visit** (see Decisions).
5. The visit is a floor visit (Online/Tele visits never prompt; see
   _online-patients-never-on-floor_).

"Older than 12 months" means `last_done <= visit_date - INTERVAL '12 months'`,
computed in SQL on the visit's own date (DATE strings, no timezone math).

The intervals live in one shared constant, `shared/testsDue.js`
(`TESTS_DUE = [{ key: 'abi', label: 'ABI', months: 12, docTypes: ['abi'] }, …]`).
That keeps one source for server and client.

## Evidence ("done earlier")

**Recorded first.** "Last done" is the newest of these records:

- **Result**: `lab_results` rows named `ABI Left/Right` and `VPT Left/Right`
  (`resultNames` in `shared/testsDue.js`), dated by `test_date`. These are
  parsed from HealthRay notes and go back to Oct 2022 (about 1,120 patients for
  each test, counted 4 Nov 2026). Fundus and Echo have no results.
- **Floor**: `giniflow_lab_order_tests` reported on an earlier visit, matched by
  exact (flattened) test name to the machine. Dated by `visit_date`. Starts
  Sep 2026.
- **Bill**: HealthRay bill items (`giniflow_patient_bills`, `status = 'billed'`,
  live items only via `isLiveBillItem`) and Scribe bill lines (`bill_lines`,
  live, on a `final` bill). The line name maps to the machine with
  `machinesOnBillLine`. Dated by the bill or visit date. Bills start
  16 Sep 2026, and they are the only record that names Fundus.

**Report PDFs are the fallback.** `documents` with the test's `docTypes`, dated
`COALESCE(doc_date, created_at::date)`, are used when there is no recorded
date. They are also used when the PDF is newer than every record, so a patient
who had the test recently is never prompted. The dialog shows which source
the date came from (result on file, done on the floor, billed, or report).

Echo has almost no history in the PDFs (2 patients in production), so Echo
prompts build up from floor tests and bills, which start Sep 2026.

Patient identity is `patient_id` on both sides (never `file_no`).

Known limit: a HealthRay "Other" document that the classifier has not reached
yet does not count. That patient simply isn't prompted. The rule never
over-prompts because of it.

**Fundus is counted strictly.** The `eye` type also covers OCT, visual-acuity
and general eye-exam reports, and HealthRay file names carry no information.
So an `eye` report counts as fundus only if its title, file name or extracted
text names it: fundus, fundoscopy, retinopathy, NPDR/PDR, or retinal
photo/imaging (`docPattern` in `shared/testsDue.js`). A Fundus test reported on
the floor always counts. An eye report with no wording, which is typical of a
HealthRay PDF the classifier re-typed, does not count. That patient is treated
as never having done fundus, so they are not prompted.

## Decisions (audit)

New table `giniflow_tests_due_decisions` (migration
`server/migrations/2026-12-01_tests_due_decisions.sql`):

| column                                           |                                    |
| ------------------------------------------------ | ---------------------------------- |
| `id` uuid pk                                     |                                    |
| `visit_id` uuid → `giniflow_visits`              |                                    |
| `patient_id` int → `patients`                    |                                    |
| `test_key` text (`abi`/`vpt`/`fundus`/`echo`)    |                                    |
| `last_done` date                                 | the date shown to the doctor       |
| `decision` text check in (`ordered`, `declined`) |                                    |
| `urgency` text null                              | when ordered                       |
| `lab_order_id` uuid null                         | the order it created               |
| `decided_by` int → `doctors`                     | the doctor or Rx MO who pressed it |
| `station` text (`doctor`/`mo`)                   | which screen it was pressed on     |
| `decided_at` timestamptz default now()           |                                    |

Unique on `(visit_id, test_key)`. Only inserts, never updates. A second press
from the other computer (Dr Bhansali and his MO share the patient) gets a 409
("no longer due"), and the dialog refreshes and closes.

Declined applies to this visit only. At the patient's next visit the test is
evaluated again and prompts again if still due.

## API

Both endpoints are in `server/routes/giniflowStations.js` and delegate to a new
`server/services/giniflow/testsDue.js`:

- `GET /giniflow/stations/{doctor|mo}/:visitId/tests-due` →
  `{ due: [{ key, label, months, testName, lastDone, source: 'report'|'floor' }], visitDate }`.
  It makes three small queries (reports, machine orders, decisions) and is
  cheap enough for every patient open.
- `POST /giniflow/stations/{doctor|mo}/:visitId/tests-due` body
  `{ order: ['abi', …], decline: ['echo', …], urgency }`
  (`giniflowTestsDueDecisionSchema`). Each station keeps its own gate: the
  doctor routes also use `requireOwnVisit`.
  1. Re-check what is due. A key that is no longer due gets a 409.
  2. For `order`: call the existing `orderTests(visitId, { urgency, tests, actorId })`
     with each machine's `order_test_name`. Order, billing and reception
     payment clearance stay exactly as when the doctor ticks the test in the
     Tests section. `assertOwner` still applies. `orderTests` commits in its
     own transaction.
  3. Insert one decision row per key with a single `jsonb_to_recordset`
     statement, `ON CONFLICT DO NOTHING`. If a race lets both screens past step 1,
     the second `orderTests` refuses the duplicate ("Already ordered").

The order step reuses `orderTests`. There is no second ordering path.

## UI

A shared component, `src/components/giniflow/TestsDueDialog.jsx`, plus a hook
`useTestsDue(visitId, station)` in `src/queries/hooks/`. It is mounted on both
pages.

- **When it opens:** the first time the patient's screen loads and `due` is not
  empty. It does not open on read-only/finalised visits. It stays closed once
  every due test has a decision (so it never reopens on reload or on the other
  computer).
- **Content** (existing dialog styles from `giniflow-station.css`):

  ```text
  Tests due — Gurpreet Kaur · P_182228

  These were done before and are due again.

  [x] ABI      last done 12 Oct 2025 (13 months ago) · yearly
  [x] VPT      last done 12 Oct 2025 (13 months ago) · yearly
  [x] Echo     last done 02 Mar 2026 (8 months ago)  · every 6 months

  Order for:  (•) Today   ( ) Next visit

                           [Not now]   [Order 3 tests]
  ```

  - Every due test starts ticked. Unticked tests count as declined when you
    press Order.
  - Urgency uses the Tests section's own `TEST_URGENCY` options and labels.
  - **Not now** declines every listed test for this visit (it is logged).
  - The primary button reads `Order N tests`, shows `Ordering…` while pending
    and is disabled when nothing is ticked. Esc and the close button don't
    record anything, and the dialog reopens on next load.

- **After:** invalidate the patient's test-panel and ordered-tests queries so the
  Tests section shows the new order at once. Toast "3 tests ordered", and the
  ordered rows appear in the Tests section as usual. On error, the dialog stays
  open with a plain message ("Couldn't order the tests. Try again.").
- Patient name + Health ID in the title (patient safety §7).

## Tests

- **Unit (service, e2e DB):** due when last report is 13 months old; not due at
  11 months; Echo due at 7 months, not at 5; **never prompted with no history**;
  floor-reported order counts as history; already ordered this visit → not due;
  decision this visit → not due; next visit → due again.
- **Playwright:** `e2e/giniflow/tests-due/TD-01-consultant.spec.js` and
  `TD-02-chief-and-rx-mo.spec.js`. Fixture patient with an old ABI document
  and a recent VPT document: the dialog lists ABI only. Order → the order row
  exists, the decision is logged, and the dialog does not reopen. Not now → the
  decision is logged and no order exists. The Rx MO ordering from one screen
  closes the dialog on Dr Bhansali's next poll.

## Not in scope

- Other periodic tests (HbA1c, lipid, UACR…) can be added later as rows in
  `TESTS_DUE`.
- Reminders outside the consultation (GHM/OBT call list).
- Changing the HealthRay document classifier.
