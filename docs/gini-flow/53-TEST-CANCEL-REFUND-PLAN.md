# 53 — Cancel or refund a test, by hand at the station and automatically from the HealthRay bill

Status: **BUILT on local, 18 Sep 2026 — migration C1 applied to production; code not deployed.**
All of C1–C14 are in; §9 lists what was checked and where the build differs from the design.
Follows `51-BILL-DRIVEN-TEST-STEPS-PLAN.md` (the stored bill, `reconcileTestSteps`) and the
bill-charges work of 18 Sep (`giniflow_bill_charges`). Floor-side only: money still moves in
HealthRay. Scribe's own billing (`52-BILLING-PLAN.md`) keeps refunds on hold (Q14); nothing here
builds a refund ledger.

## 1. What was asked

> A patient took a refund for VPT, but reception has no way to delete the test from the bill in
> Scribe, only a refund in HealthRay. Put a cancel / refund icon with a reason on the machine
> test station and the lab test station. HealthRay can also refund and delete a line from the
> bill. If reception starts using that, it must sync to Scribe and remove the test from its
> station automatically, even after the patient was marked arrived: any change in the billing
> report after arrival must sync.

Also asked: HealthRay-only lab cases (the lab station's HealthRay cards) are cancellable too; the
reception Payments tab gets the same control.

## 2. What happens today

### Renu Bala P_181797, 18 Sep

| HealthRay                                                                | Scribe                                                 |
| ------------------------------------------------------------------------ | ------------------------------------------------------ |
| Bill line `ABI,VPT` ₹600, `refunded_amount: 300` on the line and invoice | ABI order done; VPT order paid, waiting at the machine |
| The printed bill does not show the refund                                | No way to cancel it                                    |

VPT was deleted by hand at 11:5x. **The bill sync raised it again at 12:23** (unpaid, with its
step) because `ABI,VPT` is still a live bill line and no VPT order existed. Deleted again at 12:24;
it will return at the next hourly read until B1 (§8) ships. Script:
`server/scripts/remove-refunded-vpt-renu-2026-09-18.mjs`.

### What HealthRay actually sends (30 billed patients, 17–18 Sep, read-only)

- A refund is **`billing_items[].refunded_amount`** on the line, plus the transaction's
  `refunded_amount` total. Seen: ₹300 of ₹600 (`ABI,VPT`), ₹1,500 of ₹1,500 and ₹50 of ₹1,500
  (consultations).
- **No `is_cancelled` line or transaction and no deleted line was seen**: reception does not use
  those HealthRay features yet. The cancelled/deleted paths are built defensively and must be
  checked against the first real case (§7).
- Every line has a HealthRay **item id** (`billing_items[].id`).
- A transaction can be `payment_status: "Pending"` (billed, not paid yet).

### Gaps

1. No cancel action anywhere. Cancel-start only undoes a start; `removeStep` deletes a step, not
   its order; `markCancelled` cancels the whole visit.
2. `transactionsToBilling` ignores `refunded_amount` and `is_cancelled`.
3. `keepEverySeenItem` keeps every line ever seen (51 §6, on purpose), so a deletion is invisible.
4. The bill sync re-raises any billed test that has no order (`alreadyRaised`, `notYetOrdered`,
   `syncBillCharges`), so deleting an order by hand does not hold.
5. A billed bill is re-read hourly.
6. HealthRay's own lab-case cancellation is ignored after a case is first stored
   (`upsertLabCase … ON CONFLICT DO NOTHING`; `labSync` skips only new cancelled cases).

## 3. Design

### D1 — Cancelling removes the live test and keeps a full record

A cancelled Scribe test is **deleted** from the live tables (the order, or one test line of a lab
order, and its journey step), as `reconcileTestSteps` already does. About 55 queries read
`giniflow_lab_orders` without a status filter, and both station queues fall back to
"ordered"/"pending" for an unknown status; deleting keeps all of them right with no change.

The record is kept in **`giniflow_test_cancellations`**:

| column                                            | meaning                                                                                    |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `id`, `seq BIGSERIAL`                             | `seq` feeds the realtime tailer (D1a)                                                      |
| `visit_id` (nullable), `patient_id`, `visit_date` | a lab-only HealthRay case can be cancelled for a patient with no visit                     |
| `kind`                                            | `lab`, `machine`, `healthray_case`, `charge`                                               |
| `order_id`, `case_no`, `charge_id`                | what was cancelled (no FK: the order row is gone)                                          |
| `test_name`, `machine_id`, `price`                | the test, its machine (machine kind) and price at the time                                 |
| `payment_status`, `amount_paid`, `amount_claimed` | money state before the cancel                                                              |
| `refund_amount`                                   | desk-entered, or the refunded share from HealthRay                                         |
| `bill_line` JSONB                                 | the bill line (`itemId`, `invoice`, `desc`, `amount`) the test came from, when known (D7a) |
| `reason`, `note`, `source`                        | D3 code, free text; `station`, `reception`, `healthray`                                    |
| `actor_id`, `actor_role`, `cancelled_at`          |                                                                                            |
| `snapshot` JSONB                                  | the order, its test rows **and its `giniflow_lab_order_events`** (the payment trail)       |

The timeline gets a dated marker **`test_cancelled`** ("Test cancelled — VPT · Refunded"), added
to `MARKER_STATUSES` and `STATUS_LABEL` (`shared/giniflowStatus.js`); `giniflow_visit_events.status`
has no CHECK, and every status query already excludes markers. The one place that takes
`max(occurred_at)` over all events for the next HealthRay status stamp
(`appointmentSync.js` ~l.356) is changed to ignore markers.

**D1a — realtime.** The order's events are cascade-deleted, so the event tailer would not fire, and
`publish()` only reaches clients of the process that calls it (the bill sync runs in the worker).
So `giniflow_test_cancellations` is added as a tailer stream (`eventTailer.js`, keyed on `seq`)
emitting `kind: "lab_order"`, which the client already maps to reception, lab, machine, x-ray, echo,
MO, doctor and board refreshes. No direct `publish` call.

**No undo in this version.** A mistaken cancel is fixed by ordering the test again (desk or MO);
explicit orders are not blocked by the suppression (D7a). The cancellation row stays as the record.

### D2 — One service, used by every entry point

`server/services/giniflow/testCancel.js`:

```
cancelTest({ target, reason, note, refundAmount, source, actorId, actorRole }, db)
  target = { orderId, testId? }   a Scribe lab or machine order (testId: one lab test)
         | { caseNos: [...] }      HealthRay lab cases (patient-day), chosen explicitly
         | { chargeId }            a HealthRay charge
```

One transaction; the visit row is locked when there is a visit. Steps:

1. **Refuse when the test has started or produced anything.**
   - Machine order: `sample_status` in `in_progress`, `done`, `reported`; or a report
     (`report_file_url`, a `documents.giniflow_lab_order_id` row) or values (`lab_results.lab_order_id`).
   - Lab order / one test: any drawn status (`UNDRAWN_SAMPLE_STATUSES` from `shared/labStages.js`
     is the allow-list; `drawing` is refused), or a report / values as above.
   - HealthRay case: any action from `drawing_started` on; `phlebotomy_status = 'Completed'`;
     `collected_on`, `received_on`, `reported_on`; `results_synced`; `lab_results.lab_case_no`
     rows (mirrors `BUSY_SQL` / `HR_LAB_EVIDENCE_SQL`).
   - Charge: `paid` (the money was taken; the refund is HealthRay's).
   - A lab order with an insurance claim (`claim_state <> 'none'`): refused for a single test
     ("settle or reject the claim first"); a whole-order cancel is allowed.

   Messages say what to do ("VPT is on the machine — cancel the start first", "the sample is
   already taken").

2. **Record** the cancellation row(s) with the snapshot, and the `test_cancelled` marker.
3. **Remove.**
   - Machine order: delete it.
   - Lab order, one test: delete the test row; `amount_total` = remaining sum; clamp
     `amount_paid` to the new total; `payment_status` from `derivePaymentStatus`
     (`shared/labPayment.js`) with the matching payment/sample events, as `clearPayment` does;
     `version + 1`. `refund_amount` defaults to the drop in `amount_paid`. The last test deletes
     the order.
   - HealthRay cases: insert `giniflow_lab_case_actions (case_no, 'cancelled', note)` per case.
   - Charge: delete the pending row.
4. **Scribe order ↔ HealthRay case.** A Scribe lab order hides **all** of that patient's HealthRay
   cases for the day (labStation.js ~l.660; there is no test-name mapping). When a cancel leaves
   the visit with **no** Scribe lab order, those cases reappear on the station and in the tests
   hold. So the lab cancel form lists the patient's live HealthRay cases and cancels the ones the
   user ticks (all ticked by default when the last order goes). Nothing is matched by name.
5. **Journey.** Delete the pending step for the test: the machine's step when no live order for
   that machine is left; `lab_billing` + `blood_sample` when no Scribe lab order and no live
   HealthRay case is left. Then `syncLabStepsFromLab` and `placeTestsBeforeDoctors`.
6. Realtime happens through D1a.

### D3 — Reasons

`shared/testCancelReasons.js`:

| code                | label                     | note required |
| ------------------- | ------------------------- | ------------- |
| `refunded`          | Refunded                  | no            |
| `patient_declined`  | Patient declined          | no            |
| `doctor_cancelled`  | Doctor cancelled it       | no            |
| `billed_by_mistake` | Billed / added by mistake | no            |
| `duplicate`         | Duplicate                 | no            |
| `other`             | Other                     | **yes**       |

Refund amount: shown for `refunded` only, optional, defaults as in D2. Zod schema in
`server/schemas/index.js` (reason enum, note ≤ 160, amount ≥ 0, `testId` uuid, `caseNos` array).
Sync-only reasons (not offered on screens): `refunded_in_healthray`, `cancelled_in_healthray`,
`removed_from_bill`.

### D4 — Who may cancel

New capability **`GINIFLOW_TEST_CANCEL`** (`shared/permissions.js`): admin (all), coordinator,
reception, reception_admin, lab, lab_admin, tech, machine_tech, echo_tech, xray_tech. Every route
also keeps its station gate, and the service checks the order belongs to that station
(`assertOrderInStation`; lab room rules), so an echo tech cannot cancel a lab test.
`server/scripts/verify-rbac.mjs` and the e2e capability specs are updated.

### D5 — Where the control goes (by hand)

One component, `src/components/giniflow/CancelTestControl.jsx`: a **"✕ Cancel test"** button
that opens an inline reason form (reception's `ar-reason` pattern: reason select, note, refund
amount for "Refunded", and for the last lab order the list of HealthRay cases to cancel with it;
Confirm / Back). No new page, no redesign.

| Screen                                                       | Where                                                                      |
| ------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Machine / Echo / X-Ray (`MachineStationPage.jsx` `TestPane`) | "Update status", under Start / Cancel start                                |
| Lab — Scribe order (`LabRoom.jsx` `LabDetailPane`)           | per test in "Tests ordered" (lab queue payload gains the test row `id`)    |
| Lab — HealthRay case (`LabRoom.jsx` `HealthrayCasePane`)     | per case block, beside its status buttons                                  |
| Reception Payments (`ReceptionStationPage.jsx`)              | per test on an order card (`ORDER_SELECT` gains the test `id`); per charge |

Shown only when the server's `canCancel` on the row is true (so the screen and the rule agree) and
the role has `GINIFLOW_TEST_CANCEL`.

Routes (`server/routes/giniflowStations.js`), body per D3:

- `POST /giniflow/stations/{machine|echo|xray}/:orderId/cancel-test` (in `mountMachineStationRoutes`)
- `POST /giniflow/stations/lab/:orderId/cancel-test` (`testId` optional; `caseNos` optional)
- `POST /giniflow/stations/lab/case/cancel-test` (`caseNos`, `patientId`, `date`)
- `POST /giniflow/stations/reception/:orderId/cancel-test`, `POST …/reception/charges/:chargeId/cancel`

### D6 — HealthRay lab cases

Migration: the `giniflow_lab_case_actions.action` CHECK is rebuilt from the **latest** list
(`2026-10-06_lab_collection_started.sql`) plus `'cancelled'`. `UNIQUE (case_no, action)` means one
cancel per case; `case_no` is globally unique (`lab/db.js`).

`LIVE_LAB_CASE_SQL("lc")` = not cancelled in Scribe **and** `case_status` not `Cancelled`. Added to
every reader that decides whether a case is open, shown or pending:

- `server/services/giniflow/`: board, testsHold, journey (`HR_LAB_EVIDENCE_SQL`,
  `SAMPLE_TAKEN_BEFORE_VISIT_SQL`), labStation (queue, list, case pane, summary), stationLock,
  stationRelease, stationSummary, machineStation, labOnlyVisits;
- `server/routes/opd.js` and `server/routes/visit.js` (`pending_labs` tags), `server/routes/flow.js`
  (lab panel);
- `server/services/cron/labSync.js` results/PDF retry loop and `lab/db.js` retry queries (stop
  polling a cancelled case).

**Not** added to:

- identity lookups (`machineSync.LAB_CASE_PATIENT_ID`, `healthrayBillSteps`): they find the
  HealthRay patient id, and a lab-only patient's bill would never be re-read;
- `benchAlreadyStarted` (`journey.js`): today a `cancelled` action counts as "started" there,
  which is harmless, and the re-raise is stopped explicitly by D7a instead;
- `labResults.js`: a result that still arrives is kept on the patient's record.

The lab-only auto-exit sweep (`appointmentSync.js` ~l.285) needs `lab.cases > 0`; a patient whose
only case is cancelled is exited by that sweep too (cancelled counts as finished there).

`markLabCaseAction` refuses any action on a cancelled case. `CASE_ACTION_VERBS` and its Zod enum
do **not** get `cancelled`.

**HealthRay-side case cancellation**: `labSync` writes a `cancelled` case action
(`note: 'cancelled in HealthRay'`, no actor) when the list shows `Cancelled` for a case already
stored, and a cancellation row with `source: healthray`.

### D7 — The bill sync understands refunds and deletions

**Reading** (`billingExtractor.js transactionsToBilling`): each item also carries `itemId`
(`billing_items[].id`), `invoice` (`invoice_no`), `refunded` (`refunded_amount`) and `cancelled`
(`is_cancelled` on the item or its transaction).

**Storing** (`patientBill.js`: `mergeBillItems` replaces `keepEverySeenItem`). Items are keyed by
`itemId` (falls back to `category|desc` for stored lines without one):

- lines of an invoice **in this read** are replaced by this read's lines; a stored line of that
  invoice missing from it is kept with **`removed: true`**;
- lines of an invoice **not in this read** are kept as they were (a patchy or 25-row-capped read
  proves nothing: 51 §6);
- **deploy day**: stored lines with no `invoice` are adopted by the first read that returns a line
  with the same `category|desc`; one that no read matches keeps its old behaviour (never removed).

A line is **live** when `!cancelled && !removed && !(amount > 0 && refunded >= amount)`; the
transaction's own `refunded_amount >= net` makes all its lines dead. The live filter runs **before**
the name dedupe in `billedLabLines`. `billedLabLines`, `billedMachineLines`, `billedChargeLines`,
`billedStepIds` use live lines only, so a dead line raises nothing and the check-in filter treats
it as unbilled.

#### D7a — Never re-raise a cancelled test from the same bill line

Every bill-driven raise path skips a test that has a cancellation row for this visit whose
`bill_line` is the same live line (same `itemId`, or same `invoice|desc|amount` for keyless lines):
`alreadyRaised` / the machine loop, `notYetOrdered`, `insertMachineStepsForOrders` and
`insertLabStepsForOrder` in the sync, `syncBillCharges`, and `healthrayBillSteps` (the check-in
panel). A cancel records the line it came from when one maps to the test (manual cancels look it up
from the stored bill). A **new** line for the same test (billed again later) still raises. Explicit
orders (desk picks, MO/doctor orders) are never suppressed.

#### D7b — Acting on dead lines

`cancelDeadBillTests(client, visit, bill, machines)` runs in the sync **before**
`reconcileTestSteps`, for visits still on the floor. It needs positive evidence **and** no live
cover:

- the line is present and dead (refunded, cancelled or removed), **and**
- no live line maps to the same machine id / lab test name.

| Dead line matches                                                                                             | Not started                                                                            | Started / done / paid charge |
| ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------- |
| a machine order (single-machine line; every machine of a multi-machine line only when the whole line is dead) | `cancelTest(source: healthray)`                                                        | flagged (D8), kept           |
| a lab order test (by name)                                                                                    | `cancelTest` for that test                                                             | flagged                      |
| HealthRay cases                                                                                               | only when the visit has **no live pathology line at all**: cancel the not-started ones | flagged                      |
| a pending HealthRay charge                                                                                    | cancelled                                                                              | paid: flagged                |

Paid Scribe orders **are** auto-cancelled when their line is fully dead (the refund is proven);
`refund_amount` = the line's refunded share (split by price across tests on a multi-test line).
Reasons: `refunded_in_healthray`, `cancelled_in_healthray`, `removed_from_bill`.

A **part refund** (`0 < refunded < amount`, Renu's ₹300 on `ABI,VPT`) is never acted on: it cannot
say which test. It is flagged (D8).

`reconcileTestSteps` keeps its 51 rule, but treats a **dead** line as billed (only an **absent**
test is "unbilled"), so dead-line orders always go through `cancelDeadBillTests` and get a record.

### D8 — "Refunds to check" on the Payments tab

Computed when the Payments queue is read, from the stored bill and the visit's live tests (no
table). One card per visit on the floor:

- "₹300 refunded on ABI,VPT in HealthRay — which test?" listing that line's open tests with the D5
  control;
- "VPT refunded in HealthRay but already done" (information);
- "TECH 99 SCAN refunded, but ₹4,000 was collected in Scribe".

A flag goes when no open test is left on that line or the visit exits.

### D9 — Re-read the bill sooner while a refundable test is open

A visit that is billed **and** has a not-started, bill-derived test (a live order still
`ordered/payment_pending/paid`, or a pending charge) is re-read every **15 min**
(`SCRIBE_BILL_OPEN_TESTS_RESCAN_MIN`); everything else keeps the 51 cadence. `readPatientBill` takes
the same override for its freshness gate, or the rescan would return the stored copy.

Capacity: the sync scans 12 visits per run about every 90 s (≈ 6–8 reads/min). The narrower rule
keeps the eligible set to the handful of patients between billing and their test, so the 20-min
no-bill scans for new walk-ins are not starved. HealthRay's request rate is unchanged (same limiter
and batch).

## 4. Work items

| #   | Change                                                                                                           | Files                                                                               |
| --- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| C1  | Migration: `giniflow_test_cancellations` (with `seq`); case-action CHECK = latest list + `cancelled`             | `server/migrations/2026-10-08_test_cancellations.sql`                               |
| C2  | Reasons; `test_cancelled` marker + label; markers ignored in the HealthRay status stamp                          | `shared/testCancelReasons.js`, `shared/giniflowStatus.js`, `appointmentSync.js`     |
| C3  | `GINIFLOW_TEST_CANCEL` + grants; RBAC script and e2e specs                                                       | `shared/permissions.js`, `server/scripts/verify-rbac.mjs`, `e2e/`                   |
| C4  | `cancelTest` + `canCancel*` helpers (D2)                                                                         | `server/services/giniflow/testCancel.js`                                            |
| C5  | Tailer stream for cancellations (D1a)                                                                            | `server/services/giniflow/eventTailer.js`                                           |
| C6  | `LIVE_LAB_CASE_SQL` in the D6 readers; refuse actions on cancelled cases; labSync writes HealthRay cancellations | D6 files                                                                            |
| C7  | Queue payloads: `canCancel`, lab/reception test `id`, live cases for the lab form                                | `machineStation.js`, `labStation.js`, `receptionStation.js`                         |
| C8  | Routes + Zod                                                                                                     | `server/routes/giniflowStations.js`, `server/schemas/index.js`                      |
| C9  | `CancelTestControl` + hooks, wired into the four screens                                                         | `src/components/giniflow/CancelTestControl.jsx`, the D5 pages, `src/queries/hooks/` |
| C10 | Bill read fields; `mergeBillItems`; live-line filters                                                            | `billingExtractor.js`, `patientBill.js`                                             |
| C11 | D7a suppression in every bill-driven raise path                                                                  | `machineSync.js`, `journey.js`, `patientBill.js`                                    |
| C12 | `cancelDeadBillTests` before reconcile; reconcile treats dead as billed                                          | `patientBill.js`, `machineSync.js`                                                  |
| C13 | "Refunds to check" (D8)                                                                                          | `receptionStation.js`, `ReceptionStationPage.jsx`                                   |
| C14 | 15-min re-read for refundable open tests (D9)                                                                    | `machineSync.js`, `patientBill.js`                                                  |

Build order: C1–C5 (foundation) → C11 first among the sync items (it alone stops Renu's VPT from
coming back) → C7–C9 (by hand) → C6 → C10, C12–C14 (automatic).

**C1 is a production migration.** It only adds a table and widens a CHECK, so the live code keeps
working; apply it before deploying the code.

## 5. Tests

On the **e2e harness** (`e2e/`, Docker Postgres on :5435, network blocked, production never
touched), not on production:

1. `cancelTest` on a machine order, one test of a two-test lab order (amounts, status, claim
   refusal), a whole lab order with its HealthRay cases, a HealthRay case, a pending charge: live
   rows gone, cancellation row + marker written, steps gone, tests hold / exit check no longer
   count it.
2. Refusals: machine test started, report uploaded, lab sample drawn, case collected, paid charge,
   action on a cancelled case.
3. `mergeBillItems`: same invoice without a line → `removed`; missing invoice → untouched; legacy
   line adoption; duplicate names kept apart by `itemId`; refund flags.
4. D7a: cancel VPT by hand on an `ABI,VPT` line that is still live → the sync does not raise it
   again; a new VPT line on a new invoice → raised.
5. D7b: a fully refunded single-test line → cancelled with `source: healthray`; a part refund →
   flag only; a dead line with a live twin → nothing.
6. RBAC: each role sees / is refused the control as D4 says.
7. `vite build`, Prettier, and a click-through of the four screens on local.

## 6. Limits

- A started or finished test is never cancelled here; undo the start first. A finished test that
  was refunded stays and is flagged.
- A part refund on a combined line (`ABI,VPT`) always needs a person. Billing tests as separate
  lines in HealthRay lets the sync handle them alone.
- A line deleted from an invoice that HealthRay no longer returns at all is not seen as removed.
- Cancelled and deleted lines are built from HealthRay's field names but have not been seen in real
  data yet (§2).
- Scribe records refund amounts; it does not move money or print refund receipts (52 Q14).
- No undo; re-order the test instead.

## 7. Before and after go-live

- The first time reception deletes or cancels a line in HealthRay, capture that patient's
  `get_transactions` payload and check D7's reading of it.
- Watch the sync log for `cancel` lines for a day before trusting D7b.

## 8. Review (18 Sep 2026)

An independent read of the code against the first draft. All points are folded into §3–§5.

| #   | Finding                                                                                                                                                          | Where it went    |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| B1  | **Blocker**: the bill sync re-raises a cancelled test while its line is live (`alreadyRaised`, `notYetOrdered`, `syncBillCharges`). Confirmed on Renu at 12:23.  | D7a, C11         |
| B2  | **Blocker**: a dead line proves nothing if another live line covers the same test (split or re-billed lines) → churn and false markers.                          | D7b              |
| B3  | **Blocker**: `publish()` from the worker never reaches the screens; the order's events are cascade-deleted.                                                      | D1a, C5          |
| S1  | `reconcileTestSteps` would silently delete dead-line orders before any record.                                                                                   | D7b              |
| S2  | One-test lab cancel: `amount_paid + amount_claimed ≤ amount_total` CHECK, stale `payment_status`.                                                                | D2 step 3        |
| S3  | Paid orders: auto-cancel vs flag was inconsistent; the payment trail is cascade-deleted.                                                                         | D1 snapshot, D7b |
| S4  | "Started" must include reports and values, not just status (orphaned documents / values).                                                                        | D2 step 1        |
| S5  | HealthRay case "started" signals incomplete; `DRAWN_STATUSES` is private to `board.js`.                                                                          | D2 step 1        |
| S6  | No test-name mapping between Scribe orders and HealthRay cases; cases reappear when the last order goes.                                                         | D2 step 4, D7b   |
| S7  | HealthRay's own case cancellation is ignored after first store.                                                                                                  | D6               |
| S8  | Reader list: identity lookups and `benchAlreadyStarted` must not be filtered; lab-only auto-exit; `opd.js`, `visit.js`, `flow.js`, labSync retries were missing. | D6               |
| S9  | Merge gaps: legacy lines without invoice, duplicate names, transaction-level refunds, unverified payloads.                                                       | D7, §2, §7       |
| S10 | 10-min cadence not achievable at peak and would starve new-walk-in scans; freshness gate needs the override.                                                     | D9               |
| S11 | Test on the e2e harness, not production; update RBAC checks.                                                                                                     | §5, C3           |
| S12 | Rebuild the case-action CHECK from the latest list; state the undo path.                                                                                         | D6, D1           |
| M   | Route-order note unneeded; nullable `visit_id` for lab-only cases; markers bump the HealthRay stamp; legacy `flow.js` bill steps; reception test `id`.           | D1, D5, C2, C7   |

## 9. Build notes (18 Sep 2026)

**Checked** against `gini_scribe_cancel_test`, a separate database built on the e2e container from
`schema-baseline.sql` + every migration (the shared `gini_scribe_test` was in use by the billing
e2e run at the time). The real API and Vite ran against it with every production key blanked and
`e2e/setup/blockNetwork.mjs` loaded; **no outbound call was made**. Production was not touched.

| Area                                                                                                                                             | Result  |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| `cancelTest` (machine, one lab test, whole lab order + cases, HealthRay case, charge, refusals, amounts, claim rule, markers, steps, tests hold) | 29 / 29 |
| D7a suppression (Renu's case: cancel VPT on a live `ABI,VPT`; two more syncs; check-in panel; VPT billed on a new line)                          | 6 / 6   |
| API routes, roles, validation, live stream                                                                                                       | 14 / 14 |
| Queue payloads (`canCancel`, test ids, cancellable cases)                                                                                        | 8 / 8   |
| D6 live-case filter, HealthRay-side cancellation                                                                                                 | 7 / 7   |
| D7b dead lines (full / part refund, started test, live twin, removed line, charge, cases)                                                        | 11 / 11 |
| D9 re-read cadence                                                                                                                               | 2 / 2   |
| `smoke-bill-test-steps` (51)                                                                                                                     | passes  |
| Click-through: Machine Room, Lab (order + HealthRay case), Reception (order, refund check, charge)                                               | works   |

**Differences from the design**

- D9 counts **any** not-started test (and pending charges), not only bill-derived ones — telling
  them apart needs a marker the order does not carry. Same small set of patients in practice.
- The lab-only auto-exit sweep (`appointmentSync.sweepLabOnlyExits`) is unchanged: a samples-only
  patient whose only case was cancelled leaves by the end-of-day sweep, not the lab-only one.
- `verify-rbac.mjs` needs no new case: the cancel routes sit under existing station prefixes and
  check `GINIFLOW_TEST_CANCEL` on the route itself.
- `smoke-bill-test-steps.mjs`: two checks encoded the old "a duplicate keeps its first copy" rule on
  lines without an invoice. They now use invoice + item id, as real reads do.
- The case route is `POST /giniflow/stations/lab/case/cancel-test` (three segments, so it is
  registered before `/lab/:orderId/...`).

**Second review (built code, 18 Sep) — all fixed and re-tested (8 more checks)**

| Finding                                                                                | Fix                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| One refused auto-cancel rolled back the visit's whole bill sync, every run             | each auto-cancel runs in its own `SAVEPOINT`; failures are logged and skipped; claimed multi-test lab orders are kept                                                                                                                                                                                                                                              |
| A dead line auto-cancelled a test re-ordered after the refund                          | lines carry `deadSince` (stamped by `mergeBillItems`); only orders/charges created before it are touched                                                                                                                                                                                                                                                           |
| A lab test billed again on a new line was never raised (name dedupe kept the old line) | `billedLabLines(bill, { skip })` applies the suppression before the dedupe                                                                                                                                                                                                                                                                                         |
| Keyless `bill_line` matched any invoice                                                | `sameBillLine`: item id on either side needs item id on both; otherwise desc + same invoice, or desc + amount when neither has one; charge cancels record their real line                                                                                                                                                                                          |
| Deploy-day risk                                                                        | `SCRIBE_BILL_AUTO_CANCEL` = `1` (default) / `0` / `dry` (logs `cancel-dry` lines only)                                                                                                                                                                                                                                                                             |
| Minor                                                                                  | check-in charges use the suppression; HealthRay-confirmed case already cancelled in Scribe is not recorded twice; visit lookups prefer the unmerged visit; bad ids → 404; partial cancel logs the sample event; reception cancel disables the card; case checkboxes only when it is the visit's only lab order; `BUSY_SQL` and lab-only marks skip cancelled cases |

Accepted as is: the visit-then-order lock order in the cancel (the sync already had it; a deadlock
would abort one request, never corrupt data).

**To go live**

1. Apply C1: `node migrations/_runOne.mjs migrations/2026-10-08_test_cancellations.sql`
   (from `server/`). It only adds a table and widens a CHECK.
2. Deploy the API and the worker together.
