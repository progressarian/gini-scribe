# 96 — Stations show checked-in patients only

## Problem

Lab Station 1 listed Baijnath Sharma (20 Nov, case 22214) and then blocked the sample with
"lab payment is not cleared", although bill GH26-001569 was final and paid.

- The lab list is built from HealthRay lab cases and never looked at Gini Flow check-in.
- The payment gate reads the visit's `lab_billing` journey step. Journey steps are created at
  reception check-in. The patient was never checked in, so the step did not exist and the gate
  read it as unpaid.

## Rule

Outside Reception, a station shows a patient only when that visit has a `checked_in` event in
`giniflow_visit_events`. Every check-in path writes one through `advanceStatus`
(reception check-in, appointment arrival, walk-in, appointment sync). A patient with no Gini
Flow visit that day counts as not checked in.

## Audit (read-only, 14/17/19/20 Nov)

| Station | Unchecked-in patients before |
|---|---|
| Lab 1 / 2 | Live queue: HealthRay case list, awaiting-registration list, lab orders |
| Machine | Test orders on unchecked-in visits |
| Vitals / Doctor / Rx / Pharmacy | Done lists: visits closed `exited` by the system without check-in; Pharmacy pending handover |
| MO, Referrals | None |
| Station summary | Derived from the queues above |

## Changes

1. `stepSql.js`: `CHECKED_IN_SQL(v)` and `assertCheckedIn(db, visitId)`.
2. `labStation.js`: filter on `getHealthrayCases`, `awaitingRegistration`, the lab-order query in
   `getLabQueue`.
3. `machineStation.js`: filter on `loadDayMachineOrders`.
4. `vitalsStation.js`, `moStation.js`, `doctorStation.js` (queue and second-consult list),
   `rxStation.js` (queue and echo handovers), `pharmacyStation.js` (queue and pending handover).
5. Backend guard: lab Start collection on an order, every non-undo HealthRay case action, and
   machine start refuse with "&lt;name&gt; is not checked in — check them in at Reception first".

## Not changed

Reception station, coordinator day board, outside-lab pending tracker, home-collection report,
patient chart history.

## Operational impact (last 30 days)

- Patients returning only for a sample (about 157 cases) must be registered at Reception.
- Home-collection visits (34 of 126 were never checked in) must be checked in at Reception.
- Visits completed in HealthRay without a floor check-in (about 220) leave the done lists and
  Pharmacy pending handover.

## Testing

- Probe every station queue for 14/17/19/20 Nov: 0 unchecked-in patients after the change.
- Guard: case 22214 refused with 409; a checked-in visit passes.
- Playwright: `e2e/giniflow`, `e2e/pharmacy`, `e2e/healthray`, `e2e/care`.
