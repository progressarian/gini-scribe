# Lab & Tests — role, steps, and what the system actually knows

**Status:** built and live (2026-08-25)
**Applies to:** `lab` and `tech` roles · `/flow/station/lab`
**Related:** `docs/FLOW_MANAGEMENT_PLAN.md`

---

## 1. Why this shape

The first design modelled lab work as four hand-clicked stages — _sample collection →
delivered to lab → lab processing → reports available_. Checking it against the data killed it:

| Finding                                                                                           | Consequence                                                                                   |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| HealthRay exposes **two** states only: a case exists, and its results synced                      | "delivered" and "processing" have no signal — they could only ever be a button nobody presses |
| `lab_cases.appointment_id` set on **1 of 5,327** rows                                             | lab cases cannot be tied to a visit; match on **patient + date** instead                      |
| X-Ray / ABI / VPT are **not** `lab_cases` at all — they arrive as `documents` keyed on `doc_type` | per-test lab stages would never close for imaging                                             |
| **333 of 5,327 cases (6.3%)** never sync; 304 are >7 days old                                     | anything that waits on results needs a human override                                         |
| `case_status` is null on 4,296 of 5,327 rows                                                      | cannot drive a lifecycle from it                                                              |

So: **the tests a patient has are read live from HealthRay; only the work staff physically
do is modelled as steps.**

---

## 2. Roles

| Role                                                 | Sees                           | Can                                                                                            |
| ---------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------- |
| `lab`, `tech`                                        | `/flow/station/lab`            | call in, record notes, complete, skip, add/remove tests at this station, mark results received |
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
4  Lab — reports                   lab_tech      ← background, runs in parallel
5  Wait for SD                     flow_coordinator   ← gated on step 4
6  SD Consultation                 sd
7  Prescription Explain            nurse
8  Billing                         billing
9  Pharmacy / Exit                 pharmacist
```

ABI and X-Ray are **not** in any template — they are added by hand at check-in or from
"+ test" at the station. `attachBackgroundStages()` hangs `Lab — reports` off whichever
tests exist (`attach_when_any = blood_sample | abi | x_ray`), so it appears once, never
three times.

---

## 4. Step by step

### 3 · Blood Sample / ABI Test / X-RAY — _patient present_

- **Who:** lab or tech, from the station queue
- **Call in** → claims the patient (`data.claim`), starts the timer, puts them in the form box
- **Result notes** free text, saved into `step.data`
- **✓ Done** → step completes, patient auto-advances
- **⏭ Skip** → step marked `skipped` with a reason, who and when; patient still advances
- Guards: one patient at a time **per person** (two techs can collect in parallel); a patient
  mid-step at another station cannot be called in

### 4 · Lab — reports — _background, nobody stands at it_

- Excluded from: `stationBusy`, one-patient-one-place, `recalcEstimate`, `total_steps`,
  the public tracker, `deriveStage`, both auto-advances, both bypass sweeps, and the
  station queue itself
- **Completes automatically** when `lab_results` rows appear for that patient on the visit date
- **✓ Results received** — manual completion, for the 6.3% that never sync or a report that
  arrived on paper. Records `data.results_in = { by, at, manual: true }`. Only offered once
  at least one test at this station is actually complete
- **✕ Skip** — the release valve when results are never coming; recorded with a reason

### 5 · Wait for SD — _the gate_

`Wait for SD` will not release and `SD Consultation` will not start while any background
stage is open. Both the manual call-in (409) and the auto-advance (lands `ready`) respect it.

---

## 5. What the panel shows

Read live, never clicked:

| Row          | Source                 | States                                           |
| ------------ | ---------------------- | ------------------------------------------------ |
| 🩸 pathology | `lab_cases.test_names` | awaiting results → results in                    |
| 🦶🩻 imaging | `documents.doc_type`   | report on file                                   |
| Results      | `lab_results`          | value + unit, `flag`, `is_critical`, worst first |

**View report** opens `PdfViewerModal` — the same viewer the visit tab uses — and only
appears when the document actually has a file (`file_url` or `storage_path`).

Pathology has two states because HealthRay creates the case at order time. Imaging has one,
because we only learn of it when the report lands — **an ordered-but-unreported X-ray is
invisible**; the flow step is its only trace.

---

## 6. Not tracked, deliberately

|                                      | Why                               |
| ------------------------------------ | --------------------------------- |
| Sample delivered to lab              | no signal in HealthRay            |
| On the machine / processing          | no signal in HealthRay            |
| Which case a given result belongs to | `lab_results` has no case link    |
| Imaging "awaiting"                   | no order record — only the report |

Adding any of these needs a new signal (HealthRay exposing the event, or a scan/press at
each handover), not a display change.

---

## 7. Open items

- **No undo for skip.** A mis-tap needs database access. Worth a small `un-skip` endpoint.
- **Tests added mid-visit append to the end**, so a lab step can sit after Billing and
  Pharmacy in the journey. Harmless to the queue, misleading in reports.
- **Turnaround is only measurable between collection and results** — there are no
  intermediate stages to measure any more, by design.
