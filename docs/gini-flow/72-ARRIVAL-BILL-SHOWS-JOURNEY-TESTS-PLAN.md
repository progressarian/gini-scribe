# 72 — Bill at arrival shows the journey's tests before check-in

Status: plan (2026-10-17). Not built.

## Why

P*180700 (Inderpal Kaur, Dr. Iqbal Singh, 17 Oct). The check-in panel said
"✓ Added from the HealthRay bill: 1 lab test(s)" and the journey had Blood Sample with
\_General Health Check-up*, but **Bill at arrival** said "Nothing to bill yet — the consultant may
still order tests". Reception could not see or collect the test money at the desk, which is the
whole point of plan 66.

## What happens today (read from code)

| Step             | Code                                                                                                                            | What it sees                                                                                                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Panel opens      | `useArrivalBill` → `GET …/reception/:visitId/arrival-bill` → `arrivalBillPreview` (`server/services/billing/arrivalBill.js:94`) | Runs `buildIn` in a transaction that is always rolled back: carried tests, consultation (`arrivalConsultationIn`), floor orders (`testsForDesk` → `testsToPrefill`, which reads `giniflow_lab_orders`). |
| Check in pressed | `checkInWithJourney` (`server/services/giniflow/journey.js:590`)                                                                | Only now are the journey's orders written: `raiseOrdersFromSteps` (lab + machine orders and their bill lines), `priceOrdersFromBill`, `syncBillCharges`.                                                |
| Then             | `collectAtArrival` → `commitArrivalBill`                                                                                        | Runs only when the preview had something to collect (`billsAtArrival = preview.outstanding > 0`).                                                                                                       |

So before check-in a booked visit has **no orders**, and the preview can't show the tests the
journey is about to raise. After check-in the panel stays open on the Bill step and the tests
appear, but by then the patient has been "checked in only" and reception has to collect in a
second step.

A second, separate cause for the same patient: **Dr. Iqbal Singh (doctor #30) has no consultation
item** in Settings → Services, so `consultationItem` (`visitLines.js:99`) returns nothing and no
consultation line is ever added for his patients. That is billing-master data, not code; an admin
adds his New and Follow Up consultation items with the fee. This plan doesn't touch it.

## Proposed change

Make the preview do exactly what check-in will do, inside its rolled-back transaction, so the
amount reception sees is the amount the commit finds.

1. **Split check-in's transactional body** out of `checkInWithJourney` into
   `planArrivalIn(client, visitId, { visitTypeId, steps, actorId, actorRole })`: the steps from
   `stepsAllowedByBill` / `withoutChief` / `echoFirst`, `advanceStatus` to checked_in,
   `insertSteps`, `raiseOrdersFromSteps`, `priceOrdersFromBill`, `syncBillCharges`,
   `insertLabStepsIfHealthrayCase`, `placeTestsBeforeDoctors`. `checkInWithJourney` keeps its
   BEGIN/COMMIT, token, doctor assignment and `draftAtCheckIn` and calls the new function, so
   check-in behaviour is unchanged.
2. **Preview takes the planned journey.** New
   `POST …/reception/:visitId/arrival-bill/preview` with `{ visitTypeId, steps, skip, add, remove }`
   (steps are too big for a GET query string; validated with the same Zod shape as check-in).
   For a visit that isn't checked in yet, `arrivalBillPreview` calls `planArrivalIn` first, then
   `buildIn`, then rolls back as today. For a visit already checked in it skips `planArrivalIn`,
   same as the current GET. The GET stays for the Bill step after check-in.
3. **Panel sends the journey.** `useArrivalBill` gets the current `visitTypeId` and step list from
   `CheckInPanel` (debounced ~300 ms, as the steps are edited) and keeps `placeholderData` so
   the table doesn't flash. Lines raised by the journey show their source, e.g.
   "General Health Check-up — from the HealthRay bill", reusing the existing line text.
4. **Commit is unchanged.** Check-in raises the same orders, `commitArrivalBill` totals the draft
   and compares with `expectedTotal`; because the preview ran the same code the totals match. If
   they don't (journey edited after the last preview, price changed), the existing
   `amount_changed` path shows the new total and nothing is collected.

Nothing is written by the preview: every write happens on the preview's client and is rolled back,
the same guarantee the current preview relies on. No WhatsApp, HealthRay or other outside call
happens inside `planArrivalIn` (WhatsApp is sent after the commit; `storedBill` reads
`giniflow_patient_bills`).

## Not changed

- Payment before tests, the lab gate, `settleTestOrders`: as in plan 66.
- Walk-ins with no visit row yet (no `arrival.visitId`): no preview, as today.
- Consultation rules (`arrivalConsultationIn`, plan 63).

## Question for you

HealthRay-billed tests (`billedIn: "healthray"`) are priced from the HealthRay bill. Should the
panel pre-select **Paid in HealthRay** for them, or keep **Collect now** as the default as it does
for every other line? I suggest keeping **Collect now**, because the HealthRay bill means "billed",
not "paid", and the existing hint already tells reception to mark the payment.

## Tests (e2e, test DB only)

New `e2e/billing/phase4/P4C-xx-arrival-bill-journey-tests.spec.js`:

1. A booked visit with a HealthRay-billed lab test in the journey: the preview lists the test with
   its HealthRay price; the visit is still `booked` and has no `giniflow_lab_orders` row afterwards.
2. A journey with a machine step (ECG): preview lists it; nothing written.
3. Check in + collect with the previewed total: one order, one bill line per test, payment taken,
   lab gate open.
4. Remove the Blood Sample step after the preview, then commit with the old total: refused with
   `amount_changed`, patient checked in, nothing collected.
5. A visit already checked in: preview behaves as the current GET (no second set of orders).

Re-run: P4C-43 (check in and bill), G75, G60, G59 (check-in/journey).

## Files

- `server/services/giniflow/journey.js`: extract `planArrivalIn`.
- `server/services/billing/arrivalBill.js`: preview calls it for not-yet-arrived visits.
- `server/routes/giniflowStations.js`, `server/schemas/index.js`: POST preview route + schema.
- `src/queries/hooks/useGiniflowReception.js`, `src/pages/giniflow/ReceptionStationPage.jsx`:
  send visit type + steps.
