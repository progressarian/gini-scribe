# 77 — Lab collection station: cancel all tests or one test

Status: built (19 Oct 2026). Approved the same day ("yes build it"). Migration `2026-12-01_lab_case_test_cancels.sql` must run on production before deploy.

## Ask

"Need to add all blood sample cancels, including cancelling a single blood test in the lab collection station": the lab must be able to cancel **every test on a sample in one step**, or **just one test**, for both kinds of blood sample.

## Today

| Lab collection station                | One test                   | All tests on the sample              |
| ------------------------------------- | -------------------------- | ------------------------------------ |
| Scribe blood order, before collection | ✅ Cancel on each test row | ❌ one test at a time                |
| Scribe blood order, after collection  | ✅ urgent request per test | ❌                                   |
| HealthRay lab case, before collection | ❌                         | ✅ Cancel case                       |
| HealthRay lab case, after collection  | ❌                         | ✅ urgent request for the whole case |

Facts this plan rests on:

- `cancelTestIn` (`server/services/giniflow/testCancel.js`) already cancels a whole order when no `testId` is sent (`cancelOrderIn`). It writes one cancellation row per test, releases draft lines, and raises the refund for lines on a final bill.
- An urgent request for `{ orderId }` with no `testId` is already accepted and means the whole order (key `order:<id>:all`).
- HealthRay case tests live only as `lab_cases.test_names`. Nothing records one test of a case as cancelled, so about 20 readers (lab station, billing, reception, journey, board, results) would all still show it.

## Part A: cancel all tests on a Scribe blood order

### Screen (lab order pane, `LabRoom.jsx`)

Under "Tests ordered", when the order has **two or more tests**:

- **Before collection:** a **Cancel all tests (3)** button, using the existing `CancelTestControl` with `full`. The confirmation lists every test, the order total, and the refund (`refundOnTestCancel(order, amountTotal)`). It keeps the same reasons and note rule, and the "also cancel the HealthRay case" boxes.
- **After collection:** **Request to cancel all tests**, using the existing `UrgentCancelControl` with `target = { orderId }` and `full`. The admin gets one request covering every test.
- The per-test controls stay. While a request for the whole order is waiting, the per-test request buttons hide and the order shows "on hold", as it does now for any request.
- After a cancel-all the pane closes (`wholeOrder`) and the toast says "✕ All 3 tests cancelled for Ravi Kumar".

### Server

1. **Refund per test.** With no `testId`, the single `refundAmount` from the screen is split across the tests by price, so the per-test rows add up to the amount shown. Today the same figure would be copied onto every row.
2. **No clashing requests** (`raiseIn` in `cancelRequests.js`):
   - "all" is refused while a request for one of its tests is waiting: "A request for HbA1c is already waiting — withdraw it first or wait for the admin";
   - a one-test request is refused while an "all" request is waiting.
     Today both could be waiting at once, and approving one would break the other.
3. **Held means held:** `cancelTestIn` refuses a direct cancel while any request for that order is waiting (`assertNotHeld`). Today only the screen hides the button.

## Part B: cancel one test of a HealthRay lab case

### New record

Migration `2026-12-01_lab_case_test_cancels.sql`:

```sql
CREATE TABLE giniflow_lab_case_test_cancels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_no TEXT NOT NULL,
  test_name TEXT NOT NULL,
  reason TEXT NOT NULL,
  note TEXT,
  request_id UUID REFERENCES billing_requests(id),
  actor_id INTEGER REFERENCES doctors(id),
  actor_role TEXT,
  cancelled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (case_no, test_name)
);
```

Plus one `giniflow_test_cancellations` row per cancel (kind `healthray_case`, `test_name` = that test), so the audit trail and plan 76 see it.

**The migration must be run on production before this is deployed.** I don't run it; you do.

### One rule, used everywhere

**As built:** cancelling a test removes its name from `lab_cases.test_names` (`array_remove`) and keeps it in `giniflow_lab_case_test_cancels`. The HealthRay sync never rewrites `test_names` once a case is stored (`ON CONFLICT (case_no) DO NOTHING` in `server/services/lab/db.js`), so every reader leaves the test out without being changed. This replaced the planned shared helper (`LIVE_CASE_TESTS_SQL`), which would have meant editing every one of these readers:

- Lab station queue, case pane and counts (`labStation.js`);
- billing: `VISIT_LAB_CASE_TESTS_SQL` (which covers the bill auto-fill, counter "tests to bill" and after-consult), `counterPatients.js`, `serviceItemAliases.js`;
- reception Payments (`receptionStation.js`);
- journey steps (`journey.js`), floor board (`board.js`), lab results suggestions (`labResults.js`), outside-pending (`outsidePending.js`), home collection report, case reconcile, and the old flow routes.

Cancelling the **last** live test of a case cancels the whole case through the existing path, so a case is never left with zero tests.

### Before collection (direct)

- Each test row in the case pane gets a **Cancel** button (`CancelTestControl`), shown only when the case has two or more live tests; with one left, the existing **Cancel case** is the action.
- **Bill:** a draft `lab_case` line for that test is removed and the bill repriced. A line already on a final bill is refunded through the existing refund request (`refundCancelledTest`), as Scribe orders do.
- Cancelled tests stay visible in the pane, struck through, labelled "Cancelled · Patient declined · E2E Lab 10:42", so the lab knows not to run them.

### After collection (urgent request)

- Each test row gets **Request cancellation**, via `UrgentCancelControl` with `target = { caseNo, patientId, date, testName }`.
- Request key `case:<no>:<test>`. "On hold" checks change from exact `case:<no>` to `case:<no>` **or** `case:<no>:<anything>`, without matching a different case number such as 1234 vs 12345.
- The same no-clash rule as Part A applies: whole case vs one test.
- On approval, only that test is cancelled. Its bill lines (matched by that test name) are refunded with the collection charge kept, exactly as a whole-case approval does now.

### HealthRay itself

Scribe can't cancel inside HealthRay. As with whole cases today, the lab must also remove the test in HealthRay, and the toast says so: "Also remove TSH from case 1234 in HealthRay". If HealthRay still sends a result for a cancelled test, it is stored but the test stays cancelled on the floor and on the bill.

### Not in this plan

- **Restoring** a single cancelled case test. Restore (plan 58) covers Scribe orders only. A mistaken cancel before collection can be re-ordered.
- Reception's Payments tab keeps its current per-order and per-case cancels. Cancel-all is lab station only, as asked.
- Plan 76 (admin list of all cancellations) stays deferred.

## Tests (e2e, test DB only)

New `e2e/giniflow/G103-lab-cancel-all-tests.spec.js` (Part A):

1. A 3-test paid order: **Cancel all tests** cancels all three, the order disappears, 3 cancellation rows are written, refunds add up to the amount shown, and draft lines are gone.
2. A 1-test order shows no Cancel all button.
3. After collection, **Request to cancel all tests** raises one request (`order:<id>:all`). The order is on hold, and per-test request buttons are hidden.
4. With a one-test request waiting, an "all" request is refused with the message, and the reverse too.
5. The admin approves the "all" request: every test is cancelled, the charge is kept once, and the credit note equals paid minus the charge.
6. A direct cancel of a held order is refused by the server.

New `e2e/giniflow/G104-lab-cancel-one-case-test.spec.js` (Part B):

1. A 3-test HealthRay case: cancel one test before collection. The pane shows it struck through with the reason; the other two continue.
2. The cancelled test disappears from the bill auto-fill, the counter "tests to bill", reception Payments and the journey; a draft `lab_case` line for it is removed.
3. On a final bill, cancelling it raises a refund request for that line only.
4. Cancelling the remaining tests one by one: the last one cancels the whole case.
5. After collection, a one-test request holds the case. Approval cancels only that test, keeps the charge and refunds the rest. The other tests are untouched.
6. Case 1234's request does not hold case 12345.
7. 390 px: the case pane buttons fit and nothing scrolls sideways.

Rerun G91, G92, G58, P4B-15, P4B-21, P4C-07, P4C-44, P4B-22, P4B-23 and the lab station specs.

## Order of work

Part A first (small, no migration). Then Part B: migration, shared helper and readers, then server cancel paths, then the screen, then tests.
