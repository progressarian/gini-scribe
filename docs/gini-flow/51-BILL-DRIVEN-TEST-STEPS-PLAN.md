# 51 — Test steps follow the HealthRay bill, and the bill is read at most hourly

Status: **BUILT and migration applied 16 Sep 2026** (the API was already storing bills minutes later). Review fixes are in §6. `npm run smoke:bill-test-steps` passes (the cleanup test runs inside a rolled-back transaction); `smoke:giniflow-machine-board` and `smoke:journey-progress` still pass; `vite build` is clean. `smoke:machine-sync` was not run: it calls HealthRay live and writes orders. Follows `41-MACHINE-CATALOG-PLAN.md` (bill → machine orders),
`42-SYNC-COMPLETION-GATES-PLAN.md` (the bill recheck before the prescription) and
`47-XRAY-ECHO-BOARD-COLUMNS-PLAN.md` §13.

## 1. What was asked

> For any patient, whether test steps belong in their journey is decided at reception check-in
> from their HealthRay bill. If a test is on the bill, keep it. If not, remove it from the journey
> automatically. Don't read the bill every time: once it is read successfully, store it in the
> database. If the bill isn't there yet at check-in, leave the journey as it is, and check again
> whenever it is read.

Decisions taken on 16 Sep 2026:

| Question                                              | Answer                                                                                                                          |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| After the first bill is stored, read HealthRay again? | **At most hourly per visit, until the patient leaves.** A second bill later in the day (P_181774's 2D Echo) is still picked up. |
| A test a doctor/MO ordered that isn't on the bill yet | **Keep it.** Only tests that reception's check-in put there are removed.                                                        |

## 2. Why (16 Sep 2026)

- The **New Appt** template adds ABI, VPT and Fundus to every new patient. Reception often doesn't
  remove them. On 16 Sep, 7 of 16 new patients got machine orders they never paid for
  (P_181774 among them: his real bill was one 2D Echo).
- The bill is never stored. It is read live from `get_transactions`:
  1. when reception opens the check-in panel;
  2. again right after check-in;
  3. by the worker for every visit, every **20 min** (60 min once the visit has an order), until
     4 h after exit;
  4. by the prescription-step recheck (every 2 min while held).

  That endpoint is the one HealthRay's firewall blocked at 17:37 on 16 Sep (third block that day).

## 3. Design

### D1 — One stored bill per patient per day

`giniflow_patient_bills (patient_id, bill_date)` holds the billed items of that day's HealthRay
OPD transactions (`transactionsToBilling(...).billing.items`), a `status` and `read_at`.

- `billed`: HealthRay has at least one transaction for that day, even one with no tests (e.g.
  consultation only).
- `no_bill`: HealthRay answered, but there is nothing for that day yet.

Keyed by patient, not visit: reception reads the bill before a walk-in has a visit.

`server/services/giniflow/patientBill.js` → `readPatientBill(target, db, { maxAgeMin = 60 })`:

- A stored row read within `maxAgeMin` is returned **without calling HealthRay**.
- Otherwise it fetches, upserts and returns the new row.
- If HealthRay is blocked or the fetch fails, it returns the stored row (however old), or
  `{ status: "unknown" }` if there is none. Nothing is written.

### D2 — What "on the bill" means

- **Lab steps** (`lab_billing`, `blood_sample`) are billed when the bill has at least one
  PATHOLOGY line.
- **A machine step** is billed when a bill line matches that machine (`machinesOnBillLine`, as the
  bill sync already does).

Other steps are never touched.

### D3 — At check-in

- **Reception panel** (`withBilledSteps`): when the bill came back `ok` or `no_tests`, pending test
  steps not on the bill are dropped from the preview before the desk confirms. The panel note says
  so. For `no_bill`, `blocked` or `no_patient` the journey is left as it is.
- **Server** (`checkInWithJourney`): the same filter runs against the **stored** bill before steps
  are written and orders are raised. The panel may be stale, and orders must never be raised for
  unbilled template tests. No HealthRay call is made here.

### D4 — Whenever the bill is read later (worker, post-check-in, prescription recheck)

`reconcileTestSteps(client, visitId, bill, machines)` runs after the existing "raise billed
orders" step, **only when `status = 'billed'`**.

1. **Steps.** Pending test steps with `source IN ('template', 'added')` whose test is not on the
   bill are deleted. `auto` steps are never touched: those come from the bill or a doctor's order.
2. **Orders.** An order is removed only when all of these hold:
   - it was raised by the check-in itself (`o.created_at` equals the visit's check-in step write
     time; both are written in one transaction);
   - `payment_status = 'pending'`;
   - no `sample` event exists;
   - its test is not on the bill (machine: by machine id; lab: only when the bill has no lab line
     at all).

   Doctor/MO orders, bill-sync orders, and paid or started orders are never removed.

3. **A step still backed by a kept order is not removed.** This covers a doctor order for the same
   test.

### D5 — Hourly, until they leave

- `SCRIBE_MACHINE_RESCAN_MIN` and `SCRIBE_MACHINE_BILL_READ_RESCAN_MIN` both default to **60**.
- `SCRIBE_MACHINE_EXIT_GRACE_MIN` defaults to **0**: no reads after exit.
- The prescription-step recheck (`BILL_RECHECK_MS`) becomes 60 min.
- The post-check-in read and the panel read both go through `readPatientBill`, so a bill read in
  the last hour is never fetched again.

## 4. Work items

| #   | Change                                                                            | Files                                                     |
| --- | --------------------------------------------------------------------------------- | --------------------------------------------------------- |
| B1  | Table `giniflow_patient_bills`                                                    | `server/migrations/2026-10-06_giniflow_patient_bills.sql` |
| B2  | `readPatientBill`, `billedStepIds`, `dropUnbilledTestSteps`, `reconcileTestSteps` | `server/services/giniflow/patientBill.js`                 |
| B3  | Bill sync and panel read go through the stored bill; reconcile after raising      | `server/services/giniflow/machineSync.js`                 |
| B4  | Check-in filters steps against the stored bill                                    | `server/services/giniflow/journey.js`                     |
| B5  | Panel drops unbilled test steps; `no_tests` status note                           | `src/pages/giniflow/ReceptionStationPage.jsx`             |
| B6  | Hourly defaults, no reads after exit, recheck 60 min                              | `machineSync.js`, `appointmentSync.js`                    |
| B7  | Smoke: pure filter cases, reconcile inside a rolled-back transaction              | `server/scripts/smoke-bill-test-steps.mjs`                |

**B1 is a production migration.** Apply it with `node migrations/_runOne.mjs
migrations/2026-10-06_giniflow_patient_bills.sql` (from `server/`) before deploying B2–B6.

## 5. Limits

- Lab tests are judged as a group: an order with five picked tests and a bill with two keeps the
  order. The existing bill sync already adds the billed tests.
- A bill line HealthRay files under a name the machine catalogue doesn't know doesn't count as
  billed. Its template step would be removed. Add the name to the machine's `bill_names`.
- A test billed more than an hour after the last read waits for the next hourly read. Reception
  can still add it by hand.

## 6. Review fixes (16 Sep 2026, after the migration)

| Gap                                                                                                                                                                                                                                                                                                      | Fix                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Journeys the sync seeds itself (`ensurePlan`, patients reception never checked in) wrote their template steps as `source='auto'`, which the cleanup never touches. Their unbilled ABI/VPT/Fundus would have stayed for good.                                                                             | `ensurePlan` writes `source='template'` and filters the plan against the stored bill. `auto` now only means "from the bill or a doctor's order". The only other `source` check (`setStepStatus`) accepts both.                                                                                                                                                       |
| A test reception adds **by hand** at check-in was dropped silently as the desk confirmed, before it could be billed.                                                                                                                                                                                     | The check-in filter (panel and server) drops only **template** test steps. The cleanup still removes an unbilled hand-added step at the next bill read, which gives the desk time to bill it.                                                                                                                                                                        |
| A `no_bill` answer was trusted for an hour, but most patients pay after check-in, so wrong tests stayed and billed tests arrived up to an hour late.                                                                                                                                                     | A stored `no_bill` is re-read after **20 min** (`SCRIBE_NO_BILL_MAX_AGE_MIN`). The worker rescans at 20 min until a `billed` bill is stored, then hourly. The "has an order" test is replaced by the stored bill's status.                                                                                                                                           |
| Two bills in one day (ABI on the first, 2D Echo on a later one). The read kept only the transactions linked to today's appointment, so a separate Echo bill could be missed. Each read also **replaced** the stored items, so a later read without ABI would have made ABI look unbilled and removed it. | The bill read takes **every transaction of that day** (`transactionsToBilling(..., { wholeDay: true })`; `flow.js` keeps its old one-appointment read). Stored items are **only ever added to**: a test seen on any read that day stays billed, and a duplicate keeps its first saved copy (`keepEverySeenItem`). Once `billed`, a day never goes back to `no_bill`. |

End-to-end check against a real stored bill (P_179838: CBC, Sodium, Potassium, follow-up
consultation). The panel returned `ok` with 3 lab tests from the database in 171 ms, with no
HealthRay call. For the New Appt plan, only the lab steps were kept.
