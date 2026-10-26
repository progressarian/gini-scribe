# 88 — "Arrived for appointment" after a lab-only check-in

## Problem

A patient comes in for tests only (Dr. Hospital Admin booking). Reception checks them in and
they get the lab-only plan (Lab Billing → Lab Collection → Check-in → Lab Processing → Report
Upload). Later the same day they are sent to a consultant. HealthRay either:

- **edits the same booking** to the consultant (P_154080 Anoop Singh Brar, 26 Oct: booking
  114429 became Dr. Anil Bhansali · Follow-Up after the 10:57 lab check-in), or
- adds a **second booking** for the consultant.

Today only the second case where the patient was **never checked in** and the lab-only rule
already **closed** the visit is handled (`reopenAfterLabOnlyExit` → back to booked → reception
presses ✓ Arrived). In every other case the patient is stuck:

- check-in refuses to add a plan because the visit already has steps (`alreadyPlanned`);
- the visit is no longer lab-only, so the lab-only rule never closes it;
- there are no Vitals / Chief / Consultant stops, so no station picks them up.

## What reception sees

On the Arrivals tab, in the patient's on-floor row (or Left row if the visit was closed by the
lab-only rule), a new button:

```
Anoop Singh Brar · P_154080 · Tests done · Dr. Bhansali 09:05 Follow-Up
                                         [✓ Arrived for appointment]
```

It shows only when **all** of these are true:

1. The visit's plan has no consult stops (no step with a doctor/vitals/Rx/pharmacy chain status).
2. The patient now has a non-Hospital-Admin, non-cancelled booking today.
3. The visit is not cancelled / no-show / merged.

Pressing it opens the **same check-in journey picker** as ✓ Arrived, preselected from the
consultant booking (visit type, consultant). On confirm:

- the chosen plan's stops are **added after** the existing lab stops;
- lab stops the patient already did (Lab Billing, Blood Sample, Lab Processing, Report Upload)
  are **not added again**, and **no new lab orders** are raised for tests already ordered today;
- machine tests (ABI/VPT/fundus…) in the plan raise orders as usual, after reception payment;
- the visit's consultant becomes the booking's consultant (or the one chosen in the picker);
- a closed visit is reopened; the patient goes into the Vitals queue (normal 10-min rest applies
  from this second arrival);
- the floor event is recorded as `checked_in` with `meta.reason = "arrived_for_appointment"`
  and the actor, so the timeline shows "Arrived for appointment" at that time.

## Server

- `journey.js`: `arriveForAppointmentIn(client, visitId, { visitTypeId, steps, actorId })`
  — reuses `checkInIn`'s plan building (bill filter, Chief routing, echo), drops lab-leg steps
  already present, appends with `insertSteps` at the end, raises orders only for new stops.
- `receptionStation.js`: arrival rows get `canArriveForAppointment` + the consultant booking
  (doctor, time, visit type).
- Route: `POST /giniflow/stations/reception/:visitId/arrive-for-appointment`, `receptionGate`,
  same Zod schema as check-in.
- No migration.

## Not changed

- The Komal case (consultant booking turned into a Hospital Admin one) is the separate sync fix
  already built (`followRebookingToLabOnly`).
- Tests-before-doctor still applies: if a lab report is still pending the patient waits for
  reports before the Chief / consultant.

## Tests (e2e, giniflow)

1. Lab-only check-in, booking edited to a consultant → row shows the button; pressing it adds
   Vitals → Chief → Rx → Pharmacy after the done lab stops; status goes to the Vitals queue.
2. Lab-only visit closed by the lab-only rule, second consultant booking → button on the Left
   row; visit reopens.
3. No duplicate lab orders or lab steps; machine step in the plan raises one machine order.
4. Button hidden for a lab-only patient with no consultant booking, and for a patient whose plan
   already has consult stops.
5. Pressing twice adds the stops once.

## Existing patient today

Anoop (P_154080) gets the button as soon as this ships; reception presses it.
