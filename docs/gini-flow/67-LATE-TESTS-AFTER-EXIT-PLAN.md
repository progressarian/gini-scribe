# 67 — Tests ordered after the patient has exited

Status: built (2026-10-13). Code: `server/services/giniflow/lateTests.js`. Tests: `e2e/giniflow/G84-late-tests-after-exit.spec.js`.

## Why

Manisha (P_182174, new patient of Dr. Bhansali, 13 Oct) exited at 15:24 when the pharmacy
dispensed her medicines. A lab test was ordered around the same time. Scribe has no trace of it:

| Where Scribe looks         | What it has for her today                                             |
| -------------------------- | --------------------------------------------------------------------- |
| Floor test orders          | none (blood tests, ABI, VPT, Fundus dropped at check-in: not on bill) |
| HealthRay lab case         | none                                                                  |
| HealthRay bill (last read) | 15:12, "New Appointment ₹1,500" only                                  |
| Scribe bill GH26-000035    | final, consultation ₹1,500 only                                       |
| Visit                      | `exited` 15:24 (`pharmacy_dispense_all`)                              |

Once a visit is `dispensed` / `exited`, every path that turns a HealthRay test into floor work is
switched off, so a test billed or registered after exit never reaches reception, the lab or the
board.

## What exists today (read from code)

| Area                              | Today                                                                                                                                                                                                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| HealthRay bill reads              | `scanTargets` (`machineSync.js:186`) skips finished visits: `current_status <> ALL(FINISHED) OR updated_at > NOW() - EXIT_GRACE_MIN`. `SCRIBE_MACHINE_EXIT_GRACE_MIN` = **0** on purpose (plan 51 B6, plan 54): bill reads trip HealthRay's firewall.                          |
| Billed lab tests → orders         | `syncMachineOrdersForVisit` raises lab orders only when `!FINISHED` (`machineSync.js:287`); `followHealthrayCases`, step inserts and repricing are also FINISHED-guarded. Machine orders (`raiseOrder`) are not guarded, but the visit is never scanned.                       |
| Lab-only blockers                 | `labCaseAlreadyReported` and `benchAlreadyStarted` (`journey.js:219`, `:398`) stop new lab orders once any case of the day is reported / on the bench — they would also block a late test.                                                                                     |
| HealthRay lab case after exit     | `addLabStepsForArrivedLabCase` (`journey.js:1160`, called from `cron/labSync.js:96`) excludes `exited` / `dispensed`. The Payments tab's HealthRay cards need a pending `lab_billing` step (`receptionStation.js:323`), which an exited visit never gets.                      |
| Test ordered in Scribe after exit | `moStation.orderTests` (MO and doctor routes) has **no status check**: the order is created, `reopenResultsForNewOrder` runs, `linesForOrder` opens a new draft. No journey step, no status change. `machineStation.addMachineTestOn` **refuses** ("has left the floor").      |
| Screens for such an order         | Payments (`ORDER_SELECT`) and the Lab station list it (they filter only no-show/cancelled). Board: the card sits in **Done** and also in **Lab** (`board.js:1409`), with no sign it came back. Counter list files it under "Billed today / Exited" (`counterPatients.js:175`). |
| Billing                           | All bills final → `openDraftIn` (`bills.js:602`) opens a second draft (P4-08 test 4). The same item already on a final bill is refused ("Already billed…") and needs a repeat approval.                                                                                        |
| Statuses                          | `canTransition` only moves forward; nothing leaves `exited` except `reopenAfterLabOnlyExit` (`appointmentSync.js:290`, lab-only visit → `booked`) and manual scripts.                                                                                                          |
| Exit gate                         | `assertNoExitWithTestsOpen` (`statusEngine.js:163`) via `TESTS_HOLD_SQL`; system sweeps filter `tests_pending = 0` themselves.                                                                                                                                                 |

## Approach: reopen the visit for the test steps (L1)

The visit is reopened, but only for the new tests. The consultation, Rx desk and pharmacy stay done
and are never asked for again.

- New status **`back_for_tests`** ("Back for tests"), an exception status like `blocked_reports`:
  it can be entered from `dispensed` / `exited`, and `resume_status = 'exited'` means the only way
  forward is back to `exited` (`canTransition` already enforces `chainIndex(to) >= resumeFrom` for
  exception statuses; `statusEngine.js:292` sets `resume_status` only for `blocked_reports` today
  and is widened to this status).
- The reopen writes event `back_for_tests` with the trigger, the tests and the actor, and appends
  the test steps (`lab_billing` + `blood_sample`, or the machine step) as **pending** with
  `source = 'auto'` after `pharmacy`; a step of the same kind skipped at the first exit is reused
  and moved to the end (`auto` keeps it safe from the bill reconcile that drops unbilled
  check-in steps).
- Late orders are ordinary `giniflow_lab_orders` (`urgency = 'today'`, order event
  `late_after_exit`), so Payments, the Lab station, machine queues, billing and `settleTestOrders`
  work unchanged.
- When the tests are done the visit goes back to `exited` (see Closing).

Things the reopen must not disturb:

| Area                  | Rule                                                                                                                                                                                                  |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HealthRay status sync | `appointmentSync.js` maps HealthRay `completed` to `exited`; a `back_for_tests` visit is left alone (HealthRay still says completed).                                                                 |
| Pharmacy / Rx gates   | Not re-run: `sweepPharmacyLeg`, the Rx gate and `dispenseAll` never act on `back_for_tests`.                                                                                                          |
| Exception readers     | `queue.js`, `appointmentSync.js`, `receptionStation.js`, `observation.js`, `statusEngine.js` read `EXCEPTION_STATUSES`; each is checked so the new status is not treated like no-show / cancelled.    |
| Turnaround reports    | `reports.js:38` takes `MAX` of the exit events; it changes to the first exit, so a late test does not stretch the consultation turnaround. Late-test time is reported apart (reopen → reports in).    |
| Lab blockers          | `labCaseAlreadyReported` / `benchAlreadyStarted` count only cases created after the reopen, so a morning report does not block an afternoon test. A test already ordered today is never raised twice. |
| Day end               | `staleVisits.js` closes a leftover `back_for_tests` visit to `exited` like other leftovers; the undone order stays as it is.                                                                          |

## How a late test is found

| #   | Trigger                                     | Cost to HealthRay                                  | Change                                                                                                                                                                                                                     |
| --- | ------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | Doctor / MO orders a test in Scribe         | none                                               | `orderTests` on an exited visit with `urgency = 'today'` → reopen. Already creates the order and bill line.                                                                                                                |
| T2  | HealthRay lab case appears after exit       | none (lab sync already fetches cases)              | `addLabStepsForArrivedLabCase`: a same-day case first fetched **after** the exit → reopen instead of being ignored. The Payments HealthRay card then shows (it needs the pending `lab_billing` step).                      |
| T3  | Test added to the HealthRay bill after exit | one extra bill read per exited visit, rate-limited | `scanTargets` keeps an exited visit for **3 h** after exit, re-read at most every **30 min**, inside the existing `SCRIBE_BILL_READS_PER_RUN` budget and after floor visits (lowest tier). New lab/machine lines → reopen. |
| T4  | Reception, patient walks back in            | none                                               | **Back for tests** action on an exited patient (Arrivals search / Payments tab): pick tests from the catalogue → reopen. Covers tests written only on paper.                                                               |

T3 touches the firewall risk plan 51 closed. It is bounded (3 h, 30 min, budget, lowest priority)
and has its own switch: `SCRIBE_LATE_TEST_BILL_READS=0` turns it off and leaves T1, T2 and T4
working. Machine tests (`machineStation.addMachineTestOn`, which refuses a finished visit today)
reopen the same way.

## What each screen shows

- **Board**: the card leaves Done and sits in Lab / the machine column (placement by its open
  orders, as for any patient with tests) with a **BACK FOR TESTS** tag in the same chip style as
  ONLINE and LAB ONLY. The in-building tile counts it. It returns to Done when the visit exits again.
- **Timeline**: "Exited 15:24", then "Back for tests — HbA1c, 15:30 by …", the lab steps as they
  happen, then the second "Exited".
- **Reception Payments**: the order shows as any unpaid test, with the tag; paying it opens the lab
  gate as today (no test before payment — settled rule unchanged).
- **Bill tab**: a new draft holds the test (existing behaviour, P4-08). The visit is no longer
  finished, so the counter lists it under **Pending bill** while the test is unbilled.
- **Lab / machine stations**: unchanged lists, with the tag so staff know the patient left once.

## Closing again

When every late order is `uploaded`, `reported` or `sent_outside` (or cancelled), a sweep beside
`sweepLabOnlyExits` moves the visit `back_for_tests → exited` as `system` with reason
`late_tests_done`, filtered on `tests_pending = 0` like the other sweeps. A manual "Patient left —
close visit" while a late test is still open is refused by the existing exit gate
(`assertNoExitWithTestsOpen`), and allowed once the sample is sent outside (plan 62).

## Safety and audit

- Only `exited` / `dispensed` → `back_for_tests` → `exited`; no other backward move is opened.
- Every reopen and re-exit is an event naming the trigger (`scribe_order`, `healthray_case`,
  `healthray_bill`, `reception`) and the actor.
- Money: only through the new draft and the existing payment / settle path; a test already on a
  final bill keeps needing admin approval (unchanged).
- Reception's T4 needs `GINIFLOW_STATION_RECEPTION` (server and `shared/permissions.js`); the panel
  shows patient name, Health ID and visit date before ordering.
- Only `today` orders reopen a visit; tomorrow / next-visit orders do not.

## Tasks (each tested before the next)

1. **Status** `back_for_tests`: `shared/giniflowStatus.js` (exception list, label, resume rule),
   `statusEngine.js` resume handling, no migration (no CHECK constraint lists visit statuses). Test (G84): `exited →
back_for_tests → exited` allowed; `back_for_tests → with_doctor` refused.
2. **Reopen service** `server/services/giniflow/lateTests.js`: `reopenForTests(client, visitId,
{ trigger, orderIds, stepIds, actorRole, actorId })` — status, event, steps at the end.
   Test (G84): steps appended after pharmacy, earlier skipped steps untouched.
3. **Guards**: HealthRay status sync, pharmacy/Rx sweeps and exception readers leave the status
   alone; `reports.js` uses the first exit. Test (G84).
4. **T1** Scribe order after exit (MO, doctor, machine). Test (G85): MO orders HbA1c on an exited
   visit → reopened, Payments lists it, new draft bill holds it.
5. **T2** HealthRay case after exit. Test (G85): case fetched after exit reopens and shows on
   Payments; a case fetched before exit does not.
6. **T3** bounded bill reads after exit + switch. Test (G86): exited visit is a scan target inside
   3 h and not after, never with the switch off; a new billed test reopens the visit.
7. **Board / timeline / counter list**: tag, placement, Pending bill. Test (G86).
8. **Close sweep**: reports in → `exited`, event written, card back in Done; manual exit refused
   while open. Test (G87).
9. **T4 reception "Back for tests"** endpoint + panel. Test (G87) incl. permission refusal.
10. **Manisha (P_182174)**: once deployed, add her test through T4 (or T2 if HealthRay has a case).
    No prod write before then without approval.

## Decisions (2026-10-13)

| #   | Decision                                                                                                        |
| --- | --------------------------------------------------------------------------------------------------------------- |
| L1  | Reopen the visit for the test steps only (`back_for_tests`), then exit again; consult/Rx/pharmacy not repeated. |
| L2  | Read the HealthRay bill after exit for 3 h, at most every 30 min, lowest priority, with an off switch.          |
| L3  | Reception gets the **Back for tests** action.                                                                   |
| L4  | A patient coming back on a later day: nothing is built for it.                                                  |
