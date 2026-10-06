# 62 — Outsourced tests: collect here, send out, upload the report later

Status: **agreed 6 Oct 2026, building phase 1.** Follows the "Outsourced" label work
(`service_items.is_outsourced`, migration `2026-11-10_service_item_outsourced.sql`), which only
labels tests and changes no flow. Supersedes the unbuilt `48-OFFSITE-TEST-CATEGORY-PLAN.md` for
lab tests (48's "patient goes elsewhere" machine/imaging case is not covered here).

## 1. What was asked

> For an outsourced test we only collect the sample here and send it outside for the other steps.
> Later the report comes back and we upload it. Show the list of patients' tests whose reports are
> not uploaded — not only today's, other days as well — so the pending report does not block the
> other steps of the patient's journey.

## 2. How it works today (research, file:line in the two research notes behind this plan)

- **One status per order.** `giniflow_lab_orders.sample_status` walks the lab ladder
  (`shared/labStages.js`): paid → drawing → sample_collected → sample_sent → sample_received →
  processing → results_ready → uploaded. `advanceSample` (labStation.js ~1118) copies the order's
  status onto every test row, so tests in one order cannot differ.
- **Outsourced and in-house tests share one order.** `orderTests` (moStation.js ~801) and
  `raiseOrdersFromSteps` (journey.js ~365) split orders only by kind (lab / machine).
- **A drawn-but-unreported order holds the patient**, through one counter and several gates:
  - `TESTS_HOLD_SQL` (testsHold.js ~114) counts today's orders not `uploaded`/`reported`, plus
    HealthRay cases without a `report_uploaded` action. It drives:
    - the "no exit with tests open" gate (`statusEngine.assertNoExitWithTestsOpen`), which refuses
      pharmacy dispense, "Patient left — close visit" and the Rx desk's leaving exit;
    - the pharmacy and lab-only auto-exit sweeps;
    - room occupancy and the HealthRay-sync test hold (`appointmentSync.js`).
  - `assertReportsAreIn` (statusEngine.js ~110) keeps the patient from the first doctor visit
    until every report is in.
  - The board keeps the card on the Lab column while `lab_open`/`reports_outstanding` > 0
    ("⏳ Sample collected — waiting for lab reports"); `firstUnrecordedStation` returns
    `lab_results`; `results_status` stays `partial`.
  - The journey's `blood_sample` step is already done at collection. There is no report step.
- **Reports are uploaded from the lab station only for today.** `uploadReport` has no date check,
  but the lab queue (`getLabQueue`) shows one day only, so an order from an earlier day can't be
  reached in the UI. The upload lands in `documents` (`doc_type='lab_report'`, dated to the
  **visit** date) and shows on the doctor's Reports tab, MO station and visit page.
- **No cross-day pending-report list exists** for Gini Flow. The old `/flow` module had
  "Waiting on outside labs" (`flow.js applyOutsideTest`); it is the only precedent and is not
  connected to Gini Flow.
- **HealthRay cases.** Most of the floor's lab work arrives as HealthRay `lab_cases`. The sync
  already classifies a case `inhouse | mixed | outsource` (`lab_cases.case_source`) and stops
  waiting for results on outsource-only cases. Floor steps on cases live in
  `giniflow_lab_case_actions` (`sample_taken`, `sample_sent`, …, `report_uploaded`).

## 3. Decisions (proposed)

1. **An outsourced test gets its own order.** When tests are ordered, the outsourced ones (by
   `service_items.is_outsourced`, the same name matching the label uses) go into a separate lab
   order, marked `giniflow_lab_orders.is_outsourced = TRUE`. In-house tests keep their own order
   and their own ladder, so one slow outside report never holds the in-house results. Orders
   already in progress are left as they are.
2. **Ladder for an outsourced order:** paid → drawing → sample collected → **sent to outside lab**
   (new status `sent_outside`) → uploaded. The collection room sees one action after collection,
   "Send to outside lab". The processing-room rungs (received, processing, results) don't apply.
   Payment still has to be cleared first (`opensLabGate`, unchanged).
3. **Sent out = the floor's part is finished.** An order at `sent_outside` counts as done for every
   hold in §2. The patient can see the doctor, get the Rx explained, collect medicines and leave.
   One shared predicate (`OUTSIDE_PENDING`), defined once in `shared/labStages.js`, is used by
   `TESTS_HOLD_SQL`, `assertReportsAreIn`, the board's lab counts and column placement,
   `firstUnrecordedStation`, `results_status` and the MO/doctor "awaiting results" grouping.
   The settled rule "patients never go home with a test open" still holds: the sample must be
   collected and sent before the patient can leave. Only the report is outstanding.
4. **"Outside reports pending" list in the lab station.** A new tab beside the day's queue shows
   every outsourced order and outsourced HealthRay case, **across all days**, that is collected
   or sent but has no report yet:
   - **Columns:** patient name, Health ID / UHID, visit date, tests, collected at, sent at and by,
     days waiting, status (Collected / Sent to outside lab).
   - **Order:** oldest first.
   - **Filters:** search by name, Health ID or test; date range; status.
   - **Paging:** server-side, as the dues register does.
   - **Upload report** on each row, using the existing upload, so the report lands on the right
     patient and visit. The row then leaves the list. The count shows on the tab.
5. **HealthRay cases follow the same rule.** A case is outsourced when `case_source = 'outsource'`
   or all its tests are outsourced services. A new case action, `sent_outside` (CHECK widened),
   does for cases what `sent_outside` does for orders. `TESTS_HOLD_SQL` stops counting such a case
   once it is sent, and `uploadLabCaseReport` (existing) closes it from the pending list.
6. **A late report reaches the doctor the normal way.** The uploaded report goes into `documents`
   dated to the visit, so it appears in the doctor's Reports tab, the MO station and the visit
   page. No notification is added in this phase (see §6).
7. **Audit.** "Sent to outside lab" writes an order event (who, when), like every other rung.
   Uploads already record who and when.

## 4. Changes, by area

| Area | Change |
|---|---|
| Migration | `giniflow_lab_orders.is_outsourced BOOLEAN NOT NULL DEFAULT FALSE`; widen the `giniflow_lab_case_actions.action` CHECK with `sent_outside`; index for the pending list `(is_outsourced, sample_status)` |
| Shared vocabulary | `shared/labStages.js`: outsourced ladder, `sent_outside` rung label, `OUTSIDE_PENDING` statuses; `server/schemas/index.js` sample enum |
| Ordering | `moStation.orderTests`, `journey.raiseOrdersFromSteps`, bill-driven `machineSync`: split outsourced tests into their own order |
| Lab station | `advanceSample`: allow `sample_collected → sent_outside → uploaded` for outsourced orders; case action `sent_outside`; new `listOutsidePending` service and `GET /giniflow/stations/lab/outside-pending` route |
| Holds | `TESTS_HOLD_SQL`, `assertReportsAreIn`, board `MACHINE_HOLD_SQL`/`reports_outstanding`/placement, `observation.firstUnrecordedStation`, `results_status`, MO and doctor `open_orders`: treat `sent_outside` as done |
| UI | `LabRoom`: "Send to outside lab" button, "Outside reports pending" tab (table, filters, upload); board, MO and reception status labels for the new rung |
| Tests | e2e: split ordering, send-out, patient exits with the report pending, cross-day list, upload from an earlier day; P4-18 guard must stay green (`getPaymentQueue`/`clearPayment` untouched) |

## 5. Phases

1. **Orders:** split ordering, the `sent_outside` rung and the holds. After this the journey is
   never blocked by an outside report.
2. **Pending list:** the cross-day tab with upload.
3. **HealthRay cases:** same rule for outsourced cases.

Each phase is tested on its own before the next one.

## 6. Answers (user, 6 Oct 2026)

1. **Uploads:** collection-room lab staff may upload outside reports too, not only the
   processing bench. The outside-pending list and its upload are open to every lab role.
2. **Sending:** just a tick, "Sent to outside lab". No outside-lab name or expected date.
3. **Alerts:** none. The report showing on the doctor's Reports tab is enough.

## 7. Not in this plan

- Tests where the patient goes elsewhere (imaging, procedures): `48-OFFSITE-TEST-CATEGORY-PLAN.md`.
- Changing the payment gate or billing: outsourced tests are billed and cleared exactly as today.
- Per-test status inside a mixed order (decision 1 avoids it).
