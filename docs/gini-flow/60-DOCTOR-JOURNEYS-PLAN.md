# 60 — Dr Katyal's floor journeys

Status: plan (2026-10-05). Not built.

Two routes for Dr Rahul Katyal's patients that today's journey model cannot follow on its own:
nothing in routing depends on the booked doctor (only the samples-only `LAB_ONLY_DOCTOR`).

## Decisions (hospital, 2026-10-05)

| #   | Decision                                                                                                                                                          |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| K1  | Only Dr Rahul Katyal. Named once in `shared/` (like `LAB_ONLY_DOCTOR`), matched on the appointment's doctor name.                                                 |
| K2  | Dr Katyal orders tests in Scribe (Consultant station).                                                                                                            |
| K3  | An echo referral has **two** same-day HealthRay appointments: one under Dr Katyal (the echo) and one with the referring doctor (Dr Beant, Dr Simran, Dr Bansal…). |
| K4  | Staff work these patients on the Scribe stations (vitals, echo, Rx, pharmacy).                                                                                    |
| K5  | Every same-day pair (a Dr Katyal appointment + another consultant's appointment) is an echo referral — no booking-type check.                                     |
| K6  | In an echo referral, vitals come **after** the echo report and before the referring doctor.                                                                       |

## Flow A — Dr Katyal's own patients

Reception (appointment + billing) → Vitals → **Dr Katyal** (no Chief Endocrinologist step) →
if tests: **Reception (test payment)** → Lab / machine → reports uploaded → **back to Dr Katyal**
→ Rx explain → Pharmacy → exit.

| Gap today                                                                                                             | Change                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The route has the Chief step unless reception picks "Consultant Only" by hand                                         | A visit whose only consult appointment is Dr Katyal's gets a plan without `mo_assessment`; vitals then goes straight to `ready_for_doctor` (existing `planSkips` path).                                                                  |
| When a consultant orders tests the patient stays `with_doctor`, so the lab refuses the draw; only lab steps are added | The consultant's `orderTests` releases the patient the way the MO path does (back to waiting for the doctor, tests pending) and inserts machine steps as well as lab steps. Reception's Payments tab and the payment gate are unchanged. |
| "Back to Dr Katyal after reports" is implicit                                                                         | The board card and the patient tracker say "Back to Dr Katyal — reports in" once the ordered tests are reported; the existing "doctors wait for tests" hold keeps him from being called earlier.                                         |

## Flow B — echo referral

Appointment under Dr Katyal (echo) + same-day appointment with the referring doctor →
**Echo** → report uploaded → **report collected at Rx** → **Vitals** → **referring doctor** →
Rx explain → Pharmacy → exit.

| Gap today                                                                          | Change                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Two same-day appointments collapse into one visit; the sync keeps the first doctor | Detect the pair: a Dr Katyal appointment plus another consultant's appointment the same day. The visit's doctor is the **referring** doctor; Dr Katyal's echo becomes a test step.                                                                 |
| Echo demands vitals first                                                          | An "Echo referral" visit type whose vitals step comes after the echo; echo's vitals check is skipped on this route.                                                                                                                                |
| Rx only does prescription → pharmacy                                               | A "Hand over echo report" action at Rx for a reported echo before the doctor: the patient goes to the vitals queue, then on to the referring doctor (Chief step as that doctor's patients normally have it). After that doctor, Rx works as today. |
| The echo test is billed under Dr Katyal                                            | Unchanged — billing follows the HealthRay bill; only routing changes.                                                                                                                                                                              |

Other tests ordered on either route follow the same rule as everywhere: reception payment first,
then the station, then the report.

## Not changing

- No other doctor's routing changes.
- The status chain keeps its order; no new statuses.
- HealthRay stays authoritative for appointments and completion.

## Build order

1. Flow A: Dr Katyal plan without the Chief step; consultant test orders release the patient and
   add machine steps; "back to doctor" shown on the board and tracker. Tests: e2e under
   `e2e/giniflow/`.
2. Flow B: pair detection in the appointment sync, "Echo referral" visit type, echo vitals rule,
   Rx hand-over action. Tests: e2e for the full echo-referral path.
