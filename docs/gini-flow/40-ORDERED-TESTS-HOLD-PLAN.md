# 40 — Scribe journey first: Chief and Consultant wait for tests done in Scribe

Status: **BUILT 14 Sep 2026** as amended in §7 (`npm run smoke:doctor-steps`). §3.3–§3.4 were replaced by the floor's decision to treat Chief + Consultant as one step.
`main` @ `8571eae` plus uncommitted changes.

---

## 1. The flow the floor wants

Scribe follows the **journey steps reception added at check-in**. Where the patient is in HealthRay
never moves them in Scribe. HealthRay is used for only two things:

1. **Finding the tests the Chief ordered.** They are raised at the Lab / Machine station.
2. **Knowing when the Chief and the Consultant have finished.** This only counts once the patient
   has reached that step in Scribe **and** every test is done in Scribe.

```
Check-in (reception, manual) → journey steps set
  → Vitals (manual)
  → [tests on the journey at check-in → Lab / Machine (manual), before the Chief]
  → Chief (step mo_assessment)
       Chief orders a test in HealthRay → synced → shown at Lab / Machine, not blocked
       Chief step ON HOLD in Scribe until every test is done in Scribe
       tests done in Scribe + HealthRay says Chief finished → Chief done in Scribe
  → Consultant (step sd_consult / chief_consult)
       HealthRay says Consultant finished → Consultant done in Scribe
  → Rx Explain → Pharmacy (manual, as today)
```

---

## 2. What already works (no change)

| Part of the flow                                                     | Where                                                                                            |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Journey steps set at check-in                                        | `journey.checkInWithJourney`, `giniflow_visit_steps`                                             |
| Arrival and vitals are manual, never written by the sync             | `shared/manualFloor.js` `HEALTHRAY_MAY_WRITE`                                                    |
| Patient does not reach the Chief until earlier Scribe steps are done | `appointmentSync.js` hold → `observation.firstUnrecordedStation`                                 |
| Tests on the journey go before the doctor                            | `shared/journeyOrder.testsBeforeDoctors`, `statusEngine.assertReportsAreIn`                      |
| Chief-ordered tests synced into Scribe                               | `machineSync.js` (bill read → lab / machine orders + journey steps); lab case list → `lab_cases` |
| Lab / Machine stations record every step manually                    | `labStation.js`, `machineStation.js`                                                             |
| "Tests pending" shown on the board and MO station                    | `testsHold.js`                                                                                   |
| Rx Explain and Pharmacy manual                                       | `rxStation.js`, `pharmacyStation.js`                                                             |

---

## 3. The four changes

### 3.1 "Test done" = done in Scribe

In `testsHold.js`, `TESTS_HOLD_SQL` counts a test as done **only** when it is done in Scribe:

| Record             | Done when                                               |
| ------------------ | ------------------------------------------------------- |
| Lab order          | `sample_status = 'uploaded'`                            |
| Machine order      | `sample_status = 'reported'`                            |
| HealthRay lab case | `report_uploaded` action in `giniflow_lab_case_actions` |

HealthRay's `reported_on` and PDFs synced from HealthRay no longer count. The board, the MO station
and the timeline use the same definition. Add `testsOpenInScribe(db, visitId)` for the sync.

### 3.2 Lab / Machine stations are not blocked by the Chief — _in progress_

`labStation.js` and `machineStation.js` refused a patient whose status is `with_sd` / `with_doctor`
(`IN_A_ROOM`). The sync puts the patient there and nobody in Scribe moves them out, so a test the
Chief ordered could never start.

**Change:** the room check ignores a `with_sd` / `with_doctor` status that the sync wrote. The
working tree already does this in `labStation.js` (`inStationRoom`, reading the latest event's
`meta.source = 'healthray'`). Two parts are still to do:

- the same check in `machineStation.js` (`assertPatientIsFree`, the card's `free`);
- the same check in `labStation.assertPatientIsFree`.

A patient that a person put in a room stays protected.

### 3.3 Chief done — only after tests are done in Scribe

In `appointmentSync.js`, for a visit whose Scribe status is `sd_pending` or `with_sd`:

- **Any test open in Scribe:** hold. Nothing is written, and the patient stays at the Chief step.
- **No test open, and HealthRay says the Chief has finished (§4):** write `ready_for_doctor` (or
  `with_doctor` when `consultRoomFree()`). `syncFromStatus()` marks `mo_assessment` done and opens
  the Consultant step.

### 3.4 Consultant done — only after the Chief is done in Scribe

For a visit whose Scribe status is `ready_for_doctor` or `with_doctor`:

- **Any test open in Scribe:** hold.
- **No test open, and HealthRay says `completed`:** write `rx_pending`, as today.

**One step per tick.** A patient still at the Chief step in Scribe never jumps straight to
`rx_pending`. If HealthRay already says `completed`, one tick writes Chief done and the next tick
writes Consultant done. Both show on the journey as separate done steps.

The sync reads the patient's Scribe position first, then checks HealthRay only for that step. It no
longer maps HealthRay's status straight onto the doctor leg (`healthrayTarget()` in
`shared/manualFloor.js`). The switch is `SCRIBE_DOCTOR_STEPS_FOLLOW_SCRIBE`: on by default, and
`"0"` restores today's behaviour.

---

## 4. The HealthRay "Chief finished" signal — confirm on real data

HealthRay gives one appointment per patient. It has a status (`Waiting` → `Engaged` → `Checkout`)
and `engaged_start` / `engaged_end`, which are stored in `appointments.biomarkers` as
`engagedStart` / `engagedEnd`. There is no separate Chief status and Consultant status.

**Assumption used by this plan:**

| Step       | HealthRay says finished when                                     |
| ---------- | ---------------------------------------------------------------- |
| Chief      | `biomarkers->>'engagedEnd'` is set, **or** status is `completed` |
| Consultant | status is `completed` (`Checkout`)                               |

Before building §3.3, check this with a read-only query on a day when patients saw both the Chief
and a Consultant:

```sql
SELECT a.patient_name, a.status, a.doctor_name,
       a.biomarkers->>'engagedStart' AS engaged_start,
       a.biomarkers->>'engagedEnd'   AS engaged_end,
       a.biomarkers->>'rmo'          AS rmo_doctor,
       a.updated_at
  FROM appointments a
 WHERE a.appointment_date = CURRENT_DATE
   AND a.status IN ('in_visit', 'completed')
 ORDER BY a.patient_id, a.updated_at;
```

If `engaged_end` is not stamped when the Chief finishes, replace the Chief row above with whichever
field is. Only `appointmentSync.js` changes.

---

## 5. Files

| File                                          | Change                                                              |
| --------------------------------------------- | ------------------------------------------------------------------- |
| `server/services/giniflow/testsHold.js`       | Scribe-only "done"; `testsOpenInScribe()` (§3.1)                    |
| `server/services/giniflow/labStation.js`      | room check ignores a doctor room the sync wrote (§3.2, in progress) |
| `server/services/giniflow/machineStation.js`  | same (§3.2)                                                         |
| `server/services/giniflow/appointmentSync.js` | Chief / Consultant steps follow Scribe (§3.3, §3.4)                 |
| `shared/manualFloor.js`                       | switch; doctor-leg mapping (§3.4)                                   |
| `server/services/cron/index.js`               | `heldForTests` in the sync log line                                 |
| `server/scripts/smoke-doctor-steps.mjs`       | §6; add `smoke:doctor-steps` to `server/package.json`               |

No migration.

---

## 6. Tests

The script uses a synthetic date, creates its own fixtures, and makes a real
`syncAppointmentsToFlow({ date })` call. Never run it against today's date, because `DATABASE_URL`
is production.

| #   | Scribe at              | Tests in Scribe                    | HealthRay                   | Expect                                         |
| --- | ---------------------- | ---------------------------------- | --------------------------- | ---------------------------------------------- |
| T1  | vitals not done        | —                                  | `completed`                 | nothing written                                |
| T2  | `with_sd`              | ABI open                           | `engagedEnd` set            | held at Chief                                  |
| T3  | `with_sd` (sync)       | ABI open                           | —                           | Machine Room can start the ABI                 |
| T4  | `with_sd`              | ABI `reported`                     | `engagedEnd` set            | `ready_for_doctor` / `with_doctor`; Chief done |
| T5  | `with_sd`              | none                               | `in_visit`, no `engagedEnd` | held at Chief                                  |
| T6  | `with_doctor`          | none                               | `completed`                 | `rx_pending`; Consultant done                  |
| T7  | `with_doctor`          | blood open                         | `completed`                 | held                                           |
| T8  | `with_sd`              | none                               | `completed`                 | tick 1 Chief done; tick 2 `rx_pending`         |
| T9  | `with_sd`              | HR case with HealthRay report only | `completed`                 | held (HealthRay's report does not count)       |
| T10 | `with_sd` (MO station) | ABI open                           | —                           | Machine Room refused, as today                 |
| T11 | any                    | open                               | `no_show`                   | `no_show` written                              |
| T12 | switch `"0"`           | —                                  | —                           | today's behaviour                              |

Also re-run `smoke:hybrid-floor`, `smoke-floor-journey.mjs`, `smoke-observation.mjs` and the
machine smoke scripts.

---

## 7. As built — the floor's decisions (14 Sep 2026)

Two answers from the floor changed §3.3–§3.4 and §4:

1. **Chief + Consultant are one step.** HealthRay has no separate "Chief finished" signal —
   `engaged_end` is only stamped at Checkout (387 Checkouts and 13 Engaged in 7 days, nothing in
   between). So HealthRay `in_visit` takes the patient to the Chief column, and HealthRay
   `completed` completes the whole doctors step (`rx_pending`; `syncFromStatus` ticks every doctor
   step on the journey). No `engagedEnd` rule, no per-tick Chief → Consultant split.
2. **After the Chief's tests, back to the Chief.** The patient stays on the Chief step while the tests
   run; Checkout is honoured only once they are done in Scribe.

What shipped:

| Rule                                                                                                                                                                                                                                                | Where                                |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| "Done in Scribe" only: lab order `uploaded`, machine order `reported`, HealthRay case with a `report_uploaded` action. HealthRay's `reported_on` never counts. A HealthRay case hidden behind a same-day Scribe lab order is not counted separately | `testsHold.js`                       |
| The sync does not move a patient to or past the doctors step (`sd_pending` and later) while any test is open in Scribe. `no_show` / `cancelled` still apply                                                                                         | `appointmentSync.js`                 |
| A patient away for tests does not occupy the Chief's (or consultant's) room, so the next patient can be seen                                                                                                                                        | `appointmentSync.js` `roomFree`      |
| Lab 1 / Machine Room ignore a doctor room the HealthRay sync wrote; a room a Scribe desk set still blocks                                                                                                                                           | `labStation.js`, `machineStation.js` |
| Board and MO queue pause the wait clock with "Waiting for lab / machine reports" for any doctor-leg status                                                                                                                                          | `testsHold.js` `chiefWaitClock`      |
| Switch: `SCRIBE_DOCTORS_WAIT_FOR_TESTS="0"`                                                                                                                                                                                                         | `shared/manualFloor.js`              |

Known limit: an untouched HealthRay lab case (the bench never tapped "report uploaded") holds the
doctors step until someone records it in Scribe — that is the manual floor's rule, and the switch
above releases it.
