# 58 — See cancelled tests at the station and restore a mistaken cancel

Status: **built on local, 3 Oct 2026** — migration not yet applied to production.
Follows `53-TEST-CANCEL-REFUND-PLAN.md`, which deliberately shipped with no undo (§6).

## 1. What was asked

> On machine test, X-ray, echo (and not only echo) we have to show cancelled patients too.
> Yesterday Dr Katyal's echo was cancelled by mistake; the doctor asked how to edit the
> cancelled patient so the report can be uploaded.

Today a cancel **deletes** the order (doc 53 D1). The patient disappears from the station, there
is nothing to upload against, and re-ordering creates a new unpaid order — reception would collect
money the patient already paid.

## 2. Decisions

1. **Cancelled list on the station.** Machine, Echo, X-ray and Lab screens get a "Cancelled"
   section: the station's cancelled tests of the last 3 days (today first), each with patient name,
   Health ID, test, day, reason and note, who cancelled and when, what had been paid, and whether
   it was restored (who, when). Tests the HealthRay sync took off because they were never on
   the bill (`not_on_bill`) are not listed: they were never really ordered.
2. **Restore brings back the same order, not a new one.** The cancel snapshot (doc 53: the order
   row, its tests and its events) is put back under the **same order id**, so its payment status
   and amount paid come back with it — the patient is never asked to pay twice. A `restored` event
   is added to the order's own log.
3. **Billing.** If the restored order is not settled, its line is added back to the visit's draft
   bill (`linesForOrder`). A settled order needs no line (the counter shows it as cleared at
   reception, as before). The "removed by the desk" rule ignores removals made by a cancel that
   was later restored, so the counter can prefill it again.
4. **Restore is refused when undoing would be wrong**, with the reason on screen:
   - only one test of a lab order was cancelled (the order still exists) — order it again;
   - the cancel came from HealthRay (refunded/removed there) — re-bill it in HealthRay;
   - the test was on a **final** Scribe bill when cancelled — its money is in the refund
     workflow; order it again;
   - already restored, or older than 3 days.
5. **Afterwards** the cancellation rows are marked restored (`restored_at`, `restored_by`,
   `restored_role`) — never deleted, so the history stays. Restored rows no longer stop the
   HealthRay sync from raising the test (`billSuppressor`). The patient's timeline gets a
   `test_restored` marker. The machine step goes back on the journey.
6. **A past day's test** (e.g. yesterday's echo) is not on today's queue, so a restored row of a
   past day offers **Upload report** in the Cancelled list itself, through the existing report
   route.
7. **Who:** the roles that may cancel (`GINIFLOW_TEST_CANCEL`) may restore, from their own station.

## 3. Changes

| Where                                             | What                                                                                      |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `server/migrations/2026-11-04_test_restore.sql`   | `restored_at`, `restored_by`, `restored_role` on `giniflow_test_cancellations`.           |
| `server/services/giniflow/testRestore.js`         | `listCancelled` and `restoreTest`.                                                        |
| `server/services/giniflow/testCancel.js`          | `billSuppressor` skips restored rows.                                                     |
| `server/services/billing/visitLines.js`           | `REMOVED_BY_DESK_SQL` ignores lines removed by a cancel that was restored.                |
| `server/routes/giniflowStations.js`               | `GET …/{machine,echo,xray,lab}/cancelled`, `POST …/{station}/cancelled/:orderId/restore`. |
| `shared/giniflowStatus.js`                        | `test_restored` marker.                                                                   |
| `src/components/giniflow/CancelledTestsPanel.jsx` | The list, the confirm dialog, and Upload report for a past day's restored machine test.   |
| Machine/Echo/X-ray and Lab pages                  | Show the panel.                                                                           |

## 4. Tests

`e2e/giniflow/test-restore.spec.js`: a paid echo cancelled and restored comes back with the same
id and payment; an unpaid one goes back on the draft bill; the HealthRay, partial and final-bill
cases are refused; restored rows no longer suppress the bill sync; the list shows both states.
