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

| Finding                                                                                           | Consequence                                                                |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| HealthRay exposes **two** states only: a case exists, and its results synced                      | delivery and processing have no event to listen for — staff mark them      |
| `lab_cases.appointment_id` set on **1 of 5,327** rows                                             | lab cases cannot be tied to a visit; results match on **patient + date**   |
| X-Ray / ABI / VPT are **not** `lab_cases` at all — they arrive as `documents` keyed on `doc_type` | stages are attached per **visit**, not per test, so imaging is covered too |
| **333 of 5,327 cases (6.3%)** never sync; 304 are >7 days old                                     | every stage needs a manual completion and a skip                           |
| `case_status` is null on 4,296 of 5,327 rows                                                      | cannot drive a lifecycle from it                                           |

So: **the tests a patient has are read live from HealthRay; the four stages are what staff
physically do, and each is timed.**

---

## 2. Roles

| Role                                                 | Sees                           | Can                                                                                      |
| ---------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------- |
| `lab`, `tech`                                        | `/flow/station/lab`            | call in, record notes, complete, skip, add/remove tests at this station, work the stages |
| floor managers (`admin`, `reception`, `coordinator`) | everything                     | the above, plus reassign, reorder, edit durations, override anywhere                     |
| consultants                                          | the lab panel on their patient | read only                                                                                |

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

| id               | name                    | background | budget | attaches when                   |
| ---------------- | ----------------------- | ---------- | ------ | ------------------------------- |
| `blood_sample`   | Blood Sample            | no         | 10 min | template or added by hand       |
| `abi`            | ABI Test                | no         | 10 min | added by hand                   |
| `x_ray`          | X-RAY                   | no         | 15 min | added by hand                   |
| `lab_delivered`  | Lab — delivered to lab  | yes        | 10 min | any of blood_sample, abi, x_ray |
| `lab_processing` | Lab — processing        | yes        | 45 min | any of blood_sample, abi, x_ray |
| `lab_reports`    | Lab — reports available | yes        | 80 min | any of blood_sample, abi, x_ray |

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

|                                      | Why                                                                                                              |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Per-test delivery and processing     | the courier and lab work in batches; per-test stages would be three times the clicking for one physical handover |
| Which case a given result belongs to | `lab_results` has no case link                                                                                   |
| Imaging "awaiting"                   | no order record — only the report                                                                                |

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

---

## 8. Two confirmations at call-in

Added 2026-08-26. Before a sample is taken the lab confirms **destination** and, when the
test stays in-house, **money** — the two things that are expensive to discover afterwards.
Asked in one dialog on **Call in**, per test, and stored on that collection step.

**Destination is asked first, and it decides whether payment is asked at all.** An outside
test is paid to that lab directly, so our bill is not the question; asking would only invite
a wrong answer. Outside tests therefore store `outside` and no `payment` at all.

### Payment — in-house tests only

HealthRay already answers this: `transactionsToBilling()` returns `due` and
`payment_status`, served by `GET /flow/patient-billing`. The check-in page has shown a
Paid/Due badge from it for a while; the value is never stored, so the dialog fetches it live
for the one patient being called in — one API call, not one per queue row.

| HealthRay says | Dialog                                                            |
| -------------- | ----------------------------------------------------------------- |
| Paid           | green line, confirm and go                                        |
| Due ₹x         | red line; the tech must tick **proceed unpaid** and give a reason |
| No bill found  | amber "not billed yet"; treated as unpaid, same tick              |

**Warn, allow, record — never block.** HealthRay's bill is often generated after the visit,
so a hard block would strand patients whose money is fine. Refusing a sample the patient
came for costs more than collecting it and telling the floor manager.

### Sent outside

No data source exists — `lab_cases.case_source` is `inhouse` on 4,952 of 5,351 rows and every
row is `lab_branch_id = 226`, so HealthRay cannot tell us. Staff answer it: **in-house** or
**sent outside** plus the lab's name and, optionally, the date the report is expected.

Per test, not per visit: bloods routinely go out while the X-Ray is done here.

**Consequence that matters:** an outsourced test never produces `lab_results`, so the
auto-complete in `syncLabReportsFromResults()` will never fire for it. Its stages must be
closed by hand, and the "In the lab" line badges the patient `outside · <lab>` so the tech
knows not to wait for a sync that isn't coming.

### Where it is stored

On the collection step's `data`, alongside `claim` and `skip`:

```
data.payment = { status: 'paid'|'due'|'unbilled', due_amount, note, by, at, source }
data.outside = { sent: bool, lab_name, expected_on, by, at }
```

Both are also written to `flow_events` so the floor manager can see who confirmed what.

---

## 9. The Assistant Station

Added 2026-08-26. Answers "who closes the stages for an outside test?" — and, more
generally, who gets the paper report to the doctor.

The chain is now six stages across two desks:

```
sample collection → delivered to lab → lab processing → reports available   [Lab]
                  → printed → delivered to Consultant                    [Assistant Station]
```

|                 |                                                          |
| --------------- | -------------------------------------------------------- |
| URL             | `/flow/station/assistant`                                  |
| `assigned_role` | `report_desk`                                            |
| Capability      | `FLOW_STATION_REPORTS` — **coordinator (GDA)** and admin |
| Steps           | `report_printed` (10 min), `report_delivered` (10 min)   |

Both are background stages: the patient is at their consultation, not standing at the desk.
They were added to `flow_step_catalog` at `display_order` 31–32 and to all three test
templates (`FU_APPT_TESTS`, `NEW_APPT`, `NEW_WALK`) between `lab_reports` and `wait_sd`.

### The SD gate now waits for delivery

`labStagesPending()` already blocked the consultation on any open background stage, so
extending the chain extended the gate for free: **SD Consultation will not start until the
report has been handed to the doctor.** That is the point of the desk — the doctor sees the
patient with the paper in hand. Verified: starting the consult after printing but before
delivery returns `Reports not ready — waiting on Reports — delivered to Consultant`.

### Outside tests

Both happen, so the dialog asks which:

| | Patient goes there | We draw and courier |
| ------------- | ----------------------------------------- | ---------------------------------- |
| Called in?    | **No** — button reads "Send outside"      | Yes, normal call-in                |
| Collection    | `skipped`, stamped `outside.mode=patient_goes` | worked at the desk as usual   |
| Lab stages    | **dropped** (see below)                   | worked as usual                    |
| Results stage | Assistant Station                              | Assistant Station                       |

`lab_reports` moves from `lab_tech` to `report_desk` in **both** cases, because an outside
test never produces `lab_results` — the HealthRay auto-complete can never fire — and the
paper arrives at the desk, not the bench. It carries `data.awaiting_outside` so the desk
sees which lab and the expected date.

**Dropping the lab stages is conditional.** `delivered to lab` and `processing` describe our
courier and our machine; when the patient goes elsewhere they are fiction. But they are only
skipped once **no test on the visit is still ours** — a patient with bloods outside and an
X-Ray here still needs both stages for the X-Ray. `applyOutsideTest()` checks for any
collection step that is still open, or completed by anything other than a patient_goes
outside test, and leaves the stages alone if it finds one.

The send-outside path reuses `POST /flow/visits/:id/advance` with `skip: true` and the
`outside` object in `step_data`, so advancing, events and gating all behave exactly as a
normal skip. There is no separate endpoint.

One consequence worth naming: an all-outside visit has **no completed collection step**, so
the desk lists had to start counting an outside-stamped skip as closed work. Without that
the patient appears in neither desk's list — invisible to everyone.

### Two lists, not one

The Assistant Station's two jobs are different work, so they are separate sections:

| Section | Rows | Action |
| ------------------------------ | ---------------------------------------- | ------------------------- |
| **Ready to print & hand over** | report is in                             | 🖨️ Printed → ✓ To doctor |
| **Waiting on outside labs**    | earliest open stage carries `awaiting_outside` | ✓ Report received   |

One combined list headed "results are ready" was false for every row still waiting on an
outside lab, and buried the rows that could actually be worked.

### How an outside patient reads

Showing the dropped stages struck through was worse than not showing them: three crossed-out
lines describing work that never existed. When **every** test on the visit went elsewhere the
line collapses to what actually happened:

```
○ sent outside · SRL · due 28 Aug     ○ printed     ○ delivered to Consultant
        [✓ Report received from SRL]
```

The dropped stages carry `data.outside_dropped` so the UI can hide them by fact rather than
by guessing from a reason string, and the collection step folds into the "sent outside" line
rather than repeating it.

A **mixed** visit shows everything, because everything still applies — the outside test is
listed with a `→` and an amber `outside · SRL` chip rather than a strike-through, since the
patient took a different route, they did not have the test cancelled.

### What each desk sees

Both stations render the **same** line — every collection step and every background stage,
whoever owns it — so each desk can see what the other has done. Only the actionable stage
differs: a desk is offered its own earliest open stage, and only once everything before it
is closed. The lab cannot print; the Assistant Station cannot mark a sample collected.

### Watch out

- **One coordinator account exists.** If the desk is unstaffed, every tested patient's
  consultation waits behind `report_delivered`. Admins can work any station, and each stage
  still has **✕ Skip**, so it cannot deadlock — but it will slow the floor.
- The station header's "In my queue" now includes stages waiting on that desk
  (`awaiting` on `/flow/queue/:role`), since a background desk has no queue rows at all.
  The lab's number therefore also counts its in-the-lab patients now.

---

## 10. The doctor's side

Added 2026-08-26. Handing the report over is only half a handover if nothing on the
doctor's screen says it arrived.

`/flow/station/mo` is now two columns. The left is the station as before; the right is
**"Lab reports handed to you"** — every live visit whose `report_delivered` stage is
completed, newest first, each with the test names and the full `LabPanel` (values, flags,
critical first, and **View report** through the shared `PdfViewerModal`).

It is a reference list, not a queue: the doctor's own step finished long before the lab did,
so there is nothing here to complete. The column collapses under the main content below
1100px.

### What happens after the doctor looks

Nothing in the journey — the consultation was already unlocked by the handover, and
`report_delivered` is the last lab-related step before `wait_sd`. So viewing is closed off
with a **✓ Reviewed** stamp rather than a step: `POST /flow/steps/:id/reviewed` writes
`data.reviewed = { by, at }` onto the delivered step, logs a `report_reviewed` event, and the
row leaves the panel. The step's status is untouched — it was already completed by the
handover, and nothing is gated on the stamp.

Only the treating doctor can set it: `FLOW_STATION_MO`, a consultant with their own queue, or
a floor manager. The lab cannot.

**Both doctors see it.** The same panel and the same `deliveredReportRows()` rule are used by
`/flow/station/mo` (all live visits) and by the consultant's `/flow/my-patients` (their own
patients only) — the report is in front of whoever is with the patient. The right-hand column
on My Patients is other consultants' patients, so the panel sits at the top of the left.

**Resolved 2026-08-26.** The step was originally called *delivered to Consultant*, which named
the wrong person: the MO's own step is #2 and the report lands at #8, six steps after their
part ends. Checked against a day's data — all 8 delivered patients had a named consultant
waiting (Dr. Beant Kaur, Dr. Simranpreet Kaur), and every one of their MO steps had already
been auto-closed by the OPD sync before the report existed.

It is now **Reports — delivered to Consultant**. The GDA still does the delivering
(`assigned_role` stays `report_desk`); only the recipient in the label was wrong. The panel
is still shown to both the MO and the consultant, since it costs nothing while the MOs are
barely in the system.

### A bug this uncovered

`syncLabReportsFromResults()` closed **every** open background stage when results landed —
including `report_printed` and `report_delivered`. Printing a report and walking it to the
doctor are physical acts by a person; HealthRay cannot observe them, and closing them on a
sync claims a handover that never happened. The doctor's new panel made it obvious: it
listed patients nobody had handed anything to.

The sync now skips `report_desk` stages. **34 stages across 17 of today's patients were
auto-closed before the fix** — left as they are rather than reopened, since two of those
visits were still live and reopening would have put real patients behind a desk with one
account. They carry `auto_completed` so they are identifiable.

The other sweep, which closes everything when a visit completes via OPD, is left alone: the
visit is genuinely over by then.

---

## 11. Prescription Explain and ending a visit

Added 2026-08-26.

### Is the prescription actually ready?

It was never shown. The nurse's station rendered a notes box and nothing else, so she had no
way to know whether the doctor had written the prescription yet — on a normal day 115 arrive.

They arrive as `documents` with `doc_type='prescription'`, so `attachPrescriptions()` hangs
`v.rx = { ready, doc_id, at }` off each visit the same way `attachLabPanel()` does. The Rx
station now shows a green **Rx ready** or amber **no Rx yet** chip per queue row, and in the
box either **View prescription** (the shared `PdfViewerModal`) or a warning that explaining
now means working from memory.

`doc_id` is only set when the document has a file, so the viewer is never offered for
something that cannot open.

### Ending a visit early

Pharmacy could always end a visit — `Pharmacy / Exit` is the last step, so completing **or
skipping** it runs out of steps, which closes the visit and mirrors to OPD as completed. 29 of
today's 38 visits ended that way.

The nurse could not. Billing and Pharmacy belong to other desks, so a patient with no
medicines to collect had to be closed by someone else. `POST /flow/visits/:id/end` fills that
gap: every still-open step is **skipped** carrying `Visit ended early — <reason>`, the visit
is completed, and the appointment is mirrored to OPD. A reason is required.

**Who may end it:** a floor manager, or whoever can work the desk the patient is at *right
now*. The first cut checked whether the caller could work *any* open step, which let the
pharmacist close a visit still sitting at Vitals — every journey ends at their desk. It now
looks only at the in-progress step, or the earliest open one.

The button appears at Prescription Explain and Pharmacy, behind a reason dialog that says
plainly what will be skipped and that the OPD appointment is marked completed.

At the Rx desk both endings name the same act, so the nurse picks an outcome rather than a
mechanism:

- **✓ Prescription explained — move to next step** → on to billing and pharmacy
- **⏹ Prescription explained — end visit** → the step is **completed** with her notes and its
  real duration, and only billing and pharmacy are skipped

That second one passes `complete_current: true`. Without it the label would lie: the step the
nurse just did would be recorded as skipped alongside the two that genuinely did not happen.
