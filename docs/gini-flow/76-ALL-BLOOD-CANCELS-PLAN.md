# 76 — Every blood sample cancellation on the Test cancellations tab

Status: deferred (19 Oct 2026). Kept for later at the user's request; not built.

## Ask

"Need to add all blood sample cancels, including cancelling a single blood test in the lab collection station."

## Today

The 📥 Desk requests → **Test cancellations** tab (plans 74, 75) lists only **urgent cancellation requests**: a test whose sample was already collected, which needs an admin's answer.

Most blood test cancellations never become a request. They are done straight away and never reach this tab:

| Where                            | How                                                    | Recorded in                                     |
| -------------------------------- | ------------------------------------------------------ | ----------------------------------------------- |
| Lab collection station           | Cancel one test, or the whole order, before collection | `giniflow_test_cancellations`, source `station` |
| Lab station, HealthRay case      | Cancel a HealthRay lab case                            | same, kind `healthray_case`                     |
| Reception, Payments tab          | Cancel a test order before payment or collection       | same, source `reception`                        |
| HealthRay sync                   | Test refunded / cancelled / removed in HealthRay       | same, source `healthray`                        |
| Admin approves an urgent request | Cancels the collected test                             | same, reason `urgent_after_collection`          |

Every one of these already writes a row to `giniflow_test_cancellations`: test name, patient, visit, price, paid, refund, reason, note, who, role, when, and restored-by/at if it was put back. Nothing new needs recording.

## Change

The Test cancellations tab lists **both**:

1. **Requests** (as now): Waiting, Approved, Rejected, Withdrawn, with Answer/Reject on waiting rows.
2. **Direct cancellations of blood tests:** every `giniflow_test_cancellations` row with kind `lab` or `healthray_case`, read-only.

**Left out:**

- **Machine, ECG, X-ray and echo cancellations** (kind `machine`) and **charge** cancellations (kind `charge`). The ask is blood samples; they can be added later the same way.
- **Rows written by an approved urgent request** (reason `urgent_after_collection`). That cancellation already shows as the Approved request, so it isn't listed twice.
- **"Not on the HealthRay bill"** sync rows (`not_on_bill`). These are a bookkeeping clean-up, not a cancellation anyone made, and the lab's own Cancelled list hides them too.

### One list, one set of filters

The plan 75 filters stay. The list is still grouped by day (the day it was asked or cancelled, India time), 20 per page.

| Filter | Options                                                                        | Default |
| ------ | ------------------------------------------------------------------------------ | ------- |
| Status | All · Waiting · Approved · Rejected · Withdrawn · **Cancelled** · **Restored** | All     |
| Where  | **new:** All · Lab station · Reception · HealthRay · Admin request             | All     |
| Dates  | From / To                                                                      | today   |
| Search | patient name, UHID, test name                                                  | empty   |

- **Cancelled:** a direct cancellation still in force.
- **Restored:** a direct cancellation the lab later put back (plan 58 restore).
- **Where** says who did it. "Admin request" means the request rows.

### Row for a direct cancellation

| Column  | Shows                                                                                       |
| ------- | ------------------------------------------------------------------------------------------- |
| Asked   | **Cancelled by** name and role ("E2E Lab · lab"), time                                      |
| Patient | name, UHID, age/sex                                                                         |
| Test    | test name; "HealthRay case 1234" for a case; "Lab station" / "Reception" / "HealthRay sync" |
| Paid    | amount paid, and the refund raised if any                                                   |
| Reason  | the reason label (e.g. "Patient declined", "Refunded in HealthRay") and the note            |
| Status  | **Cancelled**, or **Restored** with who and when                                            |
| Action  | none: it is already done, and restoring stays on the lab station                            |

Request rows look as they do now. Each status is a word plus a colour, never colour alone.

### Day header and counts

- The day header counts both kinds: "Mon, 19 Oct 2026 · 7 cancellations · 1 waiting".
- The tab count and the menu number stay **waiting requests only**: they are a to-do list. Direct cancellations need no answer.
- The plan 75 earlier-days notice is unchanged (waiting requests only).

## Server

`listCancelRequests` (`server/services/giniflow/cancelRequests.js`) becomes a `UNION ALL` of the two sources, with the same shape:

- **Requests:** `billing_requests` where `kind = 'test_cancel'`, as now, with `source = 'request'`.
- **Direct:** `giniflow_test_cancellations` with kind `lab` / `healthray_case`, `reason NOT IN ('urgent_after_collection', 'not_on_bill')`, mapped to `{ id, status: restored_at ? 'restored' : 'cancelled', source, test name, patient, paid, refund, reason, note, cancelled_by, cancelled_at, restored_by, restored_at }`.

Filtering, sorting, paging and the day counts run over the union in SQL. New query params:

- `where`: `station` / `reception` / `healthray` / `request`.
- `status`: also takes `cancelled` and `restored`.

The route stays guarded by `GINIFLOW_TEST_CANCEL_DECIDE` (admin), and nobody new gains access. `idx_giniflow_test_cancellations_day` (visit_date, kind) already exists. A new index on `cancelled_at` is not needed at clinic volumes (tens a day).

`waiting` and `olderWaiting` keep counting requests only.

## Screen

`src/pages/billing/TestCancellationsPage.jsx`:

- the Status options gain Cancelled and Restored, and a Where select is added (`RequestFilters` gets an optional `extra` select);
- the row renders the direct-cancellation layout when `row.source !== 'request'`;
- the card's sub-line becomes: "Every blood test cancelled today, and the urgent requests waiting for you. Cancellations at the lab station, reception and from HealthRay are already done; urgent requests need your answer."

## Not changed

- How tests are cancelled or restored; the lab station's own Cancelled list.
- Who can see the tab.
- Billing requests.

## Tests (e2e, test DB only)

New `e2e/giniflow/G102-all-blood-cancels-listed.spec.js`:

1. A single blood test cancelled at the lab collection station (the real UI) shows on Test cancellations as Cancelled, with the test, patient, reason, note, "E2E Lab · lab" and the time.
2. A reception cancel and a HealthRay-sync cancel show with Where = Reception / HealthRay.
3. An approved urgent request shows once (the Approved request), not twice.
4. `not_on_bill` rows and machine cancels don't show.
5. A restored cancellation shows as Restored with who and when.
6. Status Cancelled / Restored / Waiting and Where narrow the list; the day header counts match the database.
7. The tab count and menu number still count waiting requests only.
8. API: totals match the database; lab and reception get 403; a bad `where` gets 400.
9. 390 px: no sideways scroll.

Rerun G91, G92, P4B-22, P4B-23.
