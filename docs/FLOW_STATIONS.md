# Patient Flow — every station, who works it, and when

**Status:** current as of 2026-08-26 · generated from the live catalog, templates and
capability map, not from memory.
**Related:** `docs/LAB_FLOW_PLAN.md` (lab + assistant detail), `docs/PRESCRIPTION_FLOW_PLAN.md`
(the prescription stage), `docs/FLOW_MANAGEMENT_PLAN.md`

---

## 1. The map

Seven desks. Each is one page — `/flow/station/<slug>` — with a switcher across the top that
only lists the desks your role may open.

| Desk                     | URL slug    | `assigned_role`    | Capability             | Roles that may open it               |
| ------------------------ | ----------- | ------------------ | ---------------------- | ------------------------------------ |
| ⚖️ Vitals Station        | `vitals`    | `vitals_associate` | `FLOW_STATION_VITALS`  | admin, reception, coordinator, nurse |
| 🩺 Doctor                | `mo`        | `mo`               | `FLOW_STATION_MO`      | admin, mo                            |
| 🔬 Lab & Tests           | `lab`       | `lab_tech`         | `FLOW_STATION_LAB`     | admin, lab, tech                     |
| 🥗 Dietitian             | `dietitian` | `dietitian`        | `FLOW_STATION_DIET`    | admin, coordinator, nurse            |
| 💬 Prescription Explain  | `rx`        | `nurse`            | `FLOW_STATION_RX`      | admin, nurse                         |
| 💊 Pharmacy — Final Step | `pharmacy`  | `pharmacist`       | `FLOW_STATION_PHARM`   | admin, pharmacy                      |
| 🧑‍⚕️ Assistant Station     | `assistant` | `report_desk`      | `FLOW_STATION_REPORTS` | admin, coordinator (GDA)             |

Not desks, but part of the journey:

|                    | Who                | Where they work                                       |
| ------------------ | ------------------ | ----------------------------------------------------- |
| SD Consultation    | `sd`               | the consultant's own worklist, `/flow/my-patients`    |
| Chief Consultation | `chief`            | same                                                  |
| Billing            | `billing`          | no desk — advanced from the floor or OPD              |
| Wait for SD/Chief  | `flow_coordinator` | a waiting area, auto-closed when the next step starts |

**Floor managers** — admin, reception, coordinator — hold `FLOW_COORDINATOR` and may work or
override any step from `/flow/floor` and `/flow/coordinator`.

---

## 2. The five journeys

Built from `flow_step_templates`. `(bg)` marks a background stage — work that happens while
the patient is somewhere else.

```
FU_APPT / FU_WALK            follow-up, no tests
  1 Vitals              2 Doctor Assessment    3 Wait for SD      4 SD Consultation
  5 Prescription (bg)   6 Prescription Explain 7 Billing          8 Pharmacy / Exit

FU_APPT_TESTS                follow-up with tests
  1 Vitals              2 Doctor Assessment    3 Blood Sample
  4 delivered to lab (bg)  5 processing (bg)   6 reports available (bg)
  7 Reports printed (bg)   8 delivered to Consultant (bg)
  9 Wait for SD        10 SD Consultation     11 Prescription (bg)
 12 Prescription Explain 13 Billing           14 Pharmacy / Exit

NEW_APPT                     new patient, adds the chief
  … 10 SD Consultation  11 Wait for Chief     12 Chief Consultation
 13 Prescription (bg)   14 Prescription Explain 15 Billing        16 Pharmacy / Exit

NEW_WALK                     new walk-in, adds the dietitian
  … 12 Chief Consultation 13 Dietitian        14 Prescription (bg)
 15 Prescription Explain 16 Billing           17 Pharmacy / Exit
```

ABI, X-Ray, ECG, TMT and VPT are **not** in any template. They are added at check-in from the
bill, or from **+ test** at the station. The lab and assistant stages attach themselves
around whatever tests exist.

---

## 3. Desk by desk

### ⚖️ Vitals Station — `vitals_associate`, 5 min

**Who:** admin, reception, coordinator (GDA), nurse.
**When:** first step of every journey, as soon as the patient is checked in.
**Does:** records weight, BP, pulse. This is a **free-move** desk — the user picks any waiting
patient into the box rather than being handed the next in line.

### 🩺 Doctor — `mo`, 10 min

**Who:** admin, MO.
**When:** step 2, straight after vitals and before any test.
**Does:** the assessment. The station form is a notes box; the real clinical work happens in
`/mo` and `/assess` — dictation, `MO_PROMPT` structuring, diagnoses, ordering labs.

**Right-hand column: "Prescriptions to prepare".** Patients whose consultation has finished
and whose prescription is not yet on file, each with the full lab panel, and one button —
**✓ Prescription prepared** — which releases the nurse. See §5.

### 🔬 Lab & Tests — `lab_tech`, 5–15 min per test

**Who:** admin, lab, tech.
**When:** after the doctor's assessment, for whatever tests the patient has.
**Does:**

- **Call in** opens a dialog asking **where the test is done**, and — only for in-house tests
  — **whether it is paid**. Outside tests are paid to that lab directly, so the question is
  not asked.
- The queue groups **per patient**, one row per test. A patient already in the box can be
  called in for their _other_ tests at the same desk; only another **station** blocks them.
- **In the lab** lists patients whose sample is taken and who have moved on, with the stage
  line and the next stage's button.

Full detail, including the two outside-lab paths, in `LAB_FLOW_PLAN.md`.

### 🧑‍⚕️ Assistant Station — `report_desk`, 10 + 10 min

**Who:** admin, coordinator (GDA).
**When:** once the lab says reports are available.
**Does:** two lists, because they are different jobs:

| List                           | Rows                                    | Action                                  |
| ------------------------------ | --------------------------------------- | --------------------------------------- |
| **Ready to print & hand over** | the report is in                        | 🖨️ Printed → ✓ Handed to the consultant |
| **Waiting on outside labs**    | the patient is having it done elsewhere | ✓ Report received                       |

The delivery goes to the **consultant** — the doctor about to see the patient — not the MO,
whose own step finished eight steps earlier.

### 💬 Prescription Explain — `nurse`, 5 min

**Who:** admin, nurse.
**When:** after the MO has prepared the prescription.
**Does:** explains the medicines. Each queue row shows **Rx ready** (green) or **no Rx yet**
(amber), and **Call in is disabled** until the prescription exists — hovering says _"No
prescription yet — the doctor has not submitted it."_ In the box, **View prescription** opens
the PDF.

Two ways to finish:

- **✓ Prescription explained — move to next step** → on to Billing and Pharmacy
- **⏹ Prescription explained — end visit** → the step is **completed** with her notes and
  their real duration, and only Billing and Pharmacy are skipped

### 💊 Pharmacy — Final Step — `pharmacist`, 5 min

**Who:** admin, pharmacy.
**When:** last step.
**Does:** **💊 Dispensed — Confirm Exit (stops clock)**. Being the last step, completing _or_
skipping it runs the journey out of steps, which closes the visit and mirrors the appointment
to OPD as completed. **⏹ End visit** is there too, for a patient who leaves without
collecting.

### 🥗 Dietitian — `dietitian`, 10 min

**Who:** admin, coordinator, nurse. Only in `NEW_WALK`.

---

## 4. Background stages — work with no patient standing at it

Six of them. They never appear in a call-in queue, never count toward "Step X of Y", and are
excluded from the public tracker and from both auto-advances.

| Stage                             | Owner         | Budget | Closes when                                               |
| --------------------------------- | ------------- | ------ | --------------------------------------------------------- |
| Lab — delivered to lab            | `lab_tech`    | 10 min | the lab marks it, or results arrive                       |
| Lab — processing                  | `lab_tech`    | 45 min | as above                                                  |
| Lab — reports available           | `lab_tech`    | 80 min | `lab_results` land for that patient, **or** by hand       |
| Reports — printed                 | `report_desk` | 10 min | the GDA presses it — **never** a sync                     |
| Reports — delivered to Consultant | `report_desk` | 10 min | as above                                                  |
| Prescription — MO to prepare      | `mo`          | 5 min  | a `prescription` document lands, **or** the MO presses it |

`runNextLabStage()` starts the following stage the moment one closes, so each records its own
`started_at` and duration instead of every stage reading zero.

**Printing and handing over are never auto-completed.** They are physical acts a sync cannot
observe; closing them automatically would claim a handover that never happened.

---

## 5. The three gates

They chain, and each is bounded so it cannot deadlock:

1. **Lab and report stages gate the consultation.** `SD Consultation` will not start while any
   background stage **before it** is open — so the consultant sees the patient with the
   printed report in hand.
2. **The prescription stage gates the nurse.** `Prescription Explain` will not start while
   `rx_ready` is open. Overridable by the MO or a floor manager.
3. **One patient, one place.** A patient mid-step at another **station** cannot be called in
   elsewhere. Two tests at the _same_ desk are the same place, so they do not block each other.

`labStagesPending()` is bounded by `step_order`: a stage that comes _after_ the step being
started never gates it. Without that bound, `rx_ready` — which sits after `sd_consult` —
would block the very consultation that produces the prescription.

---

## 6. Rules that apply at every desk

- **Claims.** Calling a patient in takes them (`data.claim`). Another user sees _"X is working
  this patient"_ rather than discovering it at Done. Stale after 15 min. **↩ Release** hands
  them back.
- **One desk, one patient.** `stationBusy()` stops a second patient being pulled in — per
  named staff member where the step has one, otherwise per claim. Same visit is exempt.
- **⏭ Skip** marks the step `skipped` with a reason, who and when; the patient still advances.
- **✕ Remove** takes a not-yet-started step out of the journey entirely.
- **+ test / + Add step** adds work at this station for this patient.
- **⏹ End visit** (Rx and Pharmacy) closes the visit early — every open step is skipped with a
  reason and the appointment is mirrored to OPD as completed. Allowed for a floor manager, or
  whoever can work the desk the patient is at **now**.

---

## 7. What actually completes itself

Worth knowing before reading any duration as a measure of staff time:

- **89.5% of Doctor Assessment steps** are closed by the OPD sync, not by a person — 2,349 of
  2,675, plus 44 backfilled. Only 282 were worked at the desk, and **no MO has performed a
  flow action in 30 days**.
- **133 of 135 Prescription Explain steps** in a week were auto-completed; the nurse's desk is
  effectively unstaffed today.
- A step auto-closed this way carries `data.auto_completed` and, where the start time is
  unknown, a null duration — reports average only steps with a real duration.

So a median of 35 minutes on Doctor Assessment is measuring **the gap until a sync fired**,
not how long the doctor spent.

---

## 8. Endpoints

|                                         |                                                        |
| --------------------------------------- | ------------------------------------------------------ |
| `GET /flow/queue/:role`                 | one desk's queue, plus `awaiting` for background desks |
| `GET /flow/visits`                      | today's visits with steps, lab panel and `rx` state    |
| `GET /flow/my-patients`                 | a consultant's own worklist                            |
| `POST /flow/steps/:id/start`            | call in (lab: carries the payment/outside answers)     |
| `POST /flow/visits/:id/advance`         | complete or skip the current step                      |
| `POST /flow/steps/:id/results-in`       | close a background stage by hand                       |
| `POST /flow/steps/:id/reviewed`         | consultant marks a delivered report read               |
| `POST /flow/visits/:id/end`             | end a visit early, with a reason                       |
| `POST /flow/steps/:id/claim` `/release` | take or hand back a patient                            |
| `POST /flow/demo/seed?set=lab\|rx`      | walkthrough data · `/flow/demo/clean` removes it       |

---

## 9. Known soft spots

- **`canWorkStationRole()` is permissive for desk-less roles.** Every role — guest included —
  returns true for `sd`, `chief`, `billing` and `flow_coordinator`, because those steps have
  no station capability to check against. Fine while those steps are advanced from the floor;
  it would need tightening before any of them gets its own desk.
- **One coordinator account** staffs the Assistant Station. If it is unstaffed, every tested
  patient's consultation waits behind it. Nothing deadlocks — admins can work any station and
  every stage has ✕ Skip — but the floor slows.
- **The MO owns two steps and works neither.** `mo_assessment` and `rx_ready` both name the
  MO; both are closed by syncs today.
- **No undo for skip.** A mis-tap needs database access.
- **Tests added mid-visit append to the end**, so a lab step can sit after Billing in the
  journey. Harmless to the queue, misleading in reports.

---

## 10. Every step in the catalog

The complete active catalog. Anything not in a template is added at check-in from the bill,
or from **+ test / + Add step** at a station.

| id                 | name                              | owner            | budget | station           | kind        |
| ------------------ | --------------------------------- | ---------------- | ------ | ----------------- | ----------- |
| `vitals`           | Vitals (Weight/BP/Pulse)          | vitals_associate | 5 min  | Vitals Station    | at the desk |
| `mo_assessment`    | Doctor Assessment                 | mo               | 10 min | Doctor Room       | at the desk |
| `blood_sample`     | Blood Sample                      | lab_tech         | 5 min  | Lab               | at the desk |
| `abi`              | ABI Test                          | lab_tech         | 10 min | Lab               | at the desk |
| `wait_sd`          | Wait for SD                       | flow_coordinator | 10 min | Waiting Area      | at the desk |
| `sd_consult`       | SD Consultation                   | sd               | 20 min | SD Room           | at the desk |
| `wait_chief`       | Wait for Chief                    | flow_coordinator | 10 min | Waiting Area      | at the desk |
| `chief_consult`    | Chief Consultation                | chief            | 20 min | Chief Room        | at the desk |
| `dietitian`        | Dietitian                         | dietitian        | 10 min | Dietitian Room    | at the desk |
| `rx_explain`       | Prescription Explain              | nurse            | 5 min  | Nursing Station   | at the desk |
| `billing`          | Billing                           | billing          | 5 min  | Billing Counter   | at the desk |
| `pharmacy`         | Pharmacy / Exit                   | pharmacist       | 5 min  | Pharmacy          | at the desk |
| `ecg`              | ECG                               | nurse            | 10 min | Nursing Station   | at the desk |
| `tmt`              | TMT                               | nurse            | 10 min | Nursing Station   | at the desk |
| `vpt`              | VPT                               | nurse            | 5 min  | Nursing Station   | at the desk |
| `x_ray`            | X-RAY                             | lab_tech         | 15 min | Lab               | at the desk |
| `lab_delivered`    | Lab — delivered to lab            | lab_tech         | 10 min | Lab               | background  |
| `lab_processing`   | Lab — processing                  | lab_tech         | 45 min | Lab               | background  |
| `lab_reports`      | Lab — reports available           | lab_tech         | 80 min | Lab               | background  |
| `report_printed`   | Reports — printed                 | report_desk      | 10 min | Assistant Station | background  |
| `report_delivered` | Reports — delivered to Consultant | report_desk      | 10 min | Assistant Station | background  |
| `rx_ready`         | Prescription — MO to prepare      | mo               | 5 min  | Doctor Room       | background  |

One inactive row remains: `blood_report` ("Blood — reports available"), superseded by the
three shared lab stages and deactivated rather than deleted so old visits still render.
