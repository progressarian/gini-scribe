# Lab & Tests — role, steps, and what the system actually knows

**Status:** built and live (2026-08-25)
**Applies to:** `lab` and `tech` roles · `/flow/station/lab`
**Related:** `docs/FLOW_MANAGEMENT_PLAN.md`

---

## 1. The flow

Lab work is modelled as **one collection step per test, then three shared stages**:

```
sample collection  →  delivered to lab  →  lab processing  →  reports available
   (per test)                      (once per visit, whatever tests exist)
```

Only the first is done with the patient in front of you. The other three are **background
stages**: the patient has already walked on to their consultation, and the lab works the
stages from the "In the lab" list at its own pace.

### What HealthRay can and cannot tell us

The stages are hand-worked because HealthRay has no signal for them. This is the constraint
the design lives with, not a gap to be closed later:

| Finding                                                                                           | Consequence                                                                     |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| HealthRay exposes **two** states only: a case exists, and its results synced                      | delivery and processing have no event to listen for — staff mark them            |
| `lab_cases.appointment_id` set on **1 of 5,327** rows                                             | lab cases cannot be tied to a visit; results match on **patient + date**         |
| X-Ray / ABI / VPT are **not** `lab_cases` at all — they arrive as `documents` keyed on `doc_type` | stages are attached per **visit**, not per test, so imaging is covered too       |
| **333 of 5,327 cases (6.3%)** never sync; 304 are >7 days old                                     | every stage needs a manual completion and a skip                                 |
| `case_status` is null on 4,296 of 5,327 rows                                                      | cannot drive a lifecycle from it                                                 |

So: **the tests a patient has are read live from HealthRay; the four stages are what staff
physically do, and each is timed.**

---

## 2. Roles

| Role                                                 | Sees                           | Can                                                                                            |
| ---------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------- |
| `lab`, `tech`                                        | `/flow/station/lab`            | call in, record notes, complete, skip, add/remove tests at this station, work the stages       |
| floor managers (`admin`, `reception`, `coordinator`) | everything                     | the above, plus reassign, reorder, edit durations, override anywhere                           |
| consultants                                          | the lab panel on their patient | read only                                                                                      |

Lab steps carry **no named staff** (0 of all lab steps do) — the desk is shared. Ownership
is by _claim_: whoever calls a patient in holds them until they finish or release.

---

## 3. The journey

A visit with tests (`FU_APPT_TESTS`, `NEW_APPT`, `NEW_WALK` where `needs_tests`):

```
1  Vitals (Weight/BP/Pulse)        vitals_associate
2  Doctor Assessment               mo
3  Blood Sample                    lab_tech      ← patient present
4  Lab — delivered to lab          lab_tech      ← background
5  Lab — processing                lab_tech      ← background
6  Lab — reports available         lab_tech      ← background
7  Wait for SD                     flow_coordinator   ← gated on 4–6
8  SD Consultation                 sd
9  Prescription Explain            nurse
10 Billing                         billing
11 Pharmacy / Exit                 pharmacist
```

### Catalog

| id               | name                    | background | budget | attaches when                        |
| ---------------- | ----------------------- | ---------- | ------ | ------------------------------------ |
| `blood_sample`   | Blood Sample            | no         | 10 min | template or added by hand            |
| `abi`            | ABI Test                | no         | 10 min | added by hand                        |
| `x_ray`          | X-RAY                   | no         | 15 min | added by hand                        |
| `lab_delivered`  | Lab — delivered to lab  | yes        | 10 min | any of blood_sample, abi, x_ray      |
| `lab_processing` | Lab — processing        | yes        | 45 min | any of blood_sample, abi, x_ray      |
| `lab_reports`    | Lab — reports available | yes        | 80 min | any of blood_sample, abi, x_ray      |

ABI and X-Ray are **not** in any template — they are added at check-in or from "+ test" at
the station. `attachBackgroundStages()` hangs the three stages off whichever tests exist, so
they appear **once per visit**, not once per test: a patient having bloods, ABI and X-Ray
has one delivery, one processing, one reports — the courier and the lab handle the batch.

---

## 4. Step by step

### Sample collection — _patient present_

- **Who:** lab or tech, from the station queue
- **Call in** → claims the patient (`data.claim`), starts the timer, puts them in the form box
- **Result notes** free text, saved into `step.data`
- **✓ Sample collected / ✓ Test done** → step completes, patient auto-advances
- **⏭ Skip** → `skipped` with a reason, who and when; patient still advances
- Guards: one patient at a time **per person**, and a patient mid-step at **another station**
  cannot be called in

**Same station is not "elsewhere".** A patient at the lab for bloods, ABI and X-Ray is here
once. All three guards — `stationBusy`, one-patient-one-place, and the UI's `active` check —
ignore steps on the same visit at the same role, so the desk can call the patient in for
their next test without discharging them first. The form box then shows an **"At your desk
now:"** switcher, one tab per running test, each with its own notes and ✓ button.

### The three stages — _background, patient already gone_

Worked from the **In the lab** list, in order — only the earliest open stage is offered.

- `runNextLabStage()` starts the following stage the moment one completes, so each stage
  records its own `started_at` and `actual_duration_min`. Without it every stage read
  `started: NEVER, duration: null`
- **✓ Delivered to lab / ✓ Processing done / ✓ Reports available** → `POST /flow/steps/:id/results-in`,
  recording `data.results_in = { by, at, manual: true }`
- **✕ Skip** → the release valve when results are never coming; recorded with a reason
- **Auto-complete:** when `lab_results` rows appear for that patient on the visit date,
  every open stage closes at once, flagged `data.auto_completed = "lab_results"`. Results
  landing is proof the earlier stages happened, so they are not left hanging
- Excluded from: `stationBusy`, one-patient-one-place, `recalcEstimate`, `total_steps`, the
  public tracker, `deriveStage`, both auto-advances, both bypass sweeps, and the queue itself

### Wait for SD — _the gate_

`labStagesPending()` blocks `Wait for SD` from releasing and `SD Consultation` from starting
while **any** background stage is open. Both the manual call-in (409) and the auto-advance
(lands `ready`) respect it. The consultation opens when reports are available — the point of
the four stages is that the doctor sees the patient with results in hand.

---

## 5. What the station shows

**In the lab** renders the whole line, collection included:

```
✓ Blood Sample (1m) → ✓ delivered to lab (0m) → ● processing (4m) → ○ reports available
```

`✓` done · `–` skipped · `●` running, with a live minute badge · `○` not started.
Completed stages carry `auto` (HealthRay synced) or `by hand` (staff marked it).

The **lab panel** on the patient card is read live, never clicked:

| Row          | Source                 | States                                           |
| ------------ | ---------------------- | ------------------------------------------------ |
| 🩸 pathology | `lab_cases.test_names` | awaiting results → results in                    |
| 🦶🩻 imaging | `documents.doc_type`   | report on file                                   |
| Results      | `lab_results`          | value + unit, `flag`, `is_critical`, worst first |

**View report** opens `PdfViewerModal` — the same viewer the visit tab uses — and only
appears when the document actually has a file (`file_url` or `storage_path`).

Pathology has two states because HealthRay creates the case at order time. Imaging has one,
because we only learn of it when the report lands — **an ordered-but-unreported X-ray is
invisible to HealthRay**; the flow steps are its only trace.

---

## 6. Not tracked, deliberately

|                                      | Why                               |
| ------------------------------------ | --------------------------------- |
| Per-test delivery and processing     | the courier and lab work in batches; per-test stages would be three times the clicking for one physical handover |
| Which case a given result belongs to | `lab_results` has no case link    |
| Imaging "awaiting"                   | no order record — only the report |

---

## 7. Open items

- **No undo for skip.** A mis-tap needs database access. Worth a small `un-skip` endpoint.
- **Tests added mid-visit append to the end**, so a lab step can sit after Billing and
  Pharmacy in the journey. Harmless to the queue, misleading in reports.
- **Auto-complete closes all open stages at once**, so a visit whose results sync before the
  lab has clicked anything records the full turnaround on one stage and 0m on the rest.
- **Concurrent tests at one desk overlap their timers** — a patient with bloods and X-Ray
  both running has two clocks, so per-step durations can sum to more than the wall-clock
  time they were at the station.
