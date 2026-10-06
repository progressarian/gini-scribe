# 60 — Dr Katyal's floor journeys

Status: Flow A and Flow B built (2026-10-06). Tests: `e2e/giniflow/G60-katyal-flow-a.spec.js`, `G61-echo-referral.spec.js`.

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

## As built

- `shared/directConsult.js`: Dr Katyal's name rule (`consultsDirect`, SQL `directConsultSql`) and
  the consult-side helpers reception and the server share (`withoutChief`).
- Flow A: `journey.ensurePlan` / `checkInWithJourney` drop the Chief steps for his visits;
  reception defaults to "Consultant Only" and greys out the other choices; `moStation.orderTests`
  releases his patient from `with_doctor` to `ready_for_doctor` and adds machine steps (and no
  blood-sample step for a machine-only order); the board card reads "Waiting for reports · then
  back to …" / "Back to … · reports in".
- HealthRay guard (2026-10-06): Dr Katyal consults in Scribe, not HealthRay, so the appointment
  sync may only write `no_show` / `cancelled` for his visits (`appointmentSync.js`,
  `DIRECT_CONSULT_HEALTHRAY_WRITES`). A HealthRay "completed" can no longer move his patient past the
  Scribe consult to the Rx desk. Tests: G60 #7–8.
- Flow B: migration `2026-11-07_echo_referral_visits.sql` (`echo_referral`,
  `echo_handed_over_at`, `echo_handed_over_by`). The appointment sync flags the pair and points the
  visit at the referring doctor's appointment and doctor, and ignores Dr Katyal's appointment for
  status. Echo steps go first (`echoFirst`, also after `placeTestsBeforeDoctors`); the echo starts
  without vitals; the vitals queue holds the patient until the Rx desk's "Hand over report"
  (`rxStation.handOverEchoReport`, refused until every echo order is reported).
