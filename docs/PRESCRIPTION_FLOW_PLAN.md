# Prescription — who makes it ready, and how the nurse finds out

**Status:** built and live, 2026-08-26
**Applies to:** `sd_consult` → *(new)* `rx_ready` → `rx_explain`
**Related:** `docs/LAB_FLOW_PLAN.md` §11, `docs/FLOW_MANAGEMENT_PLAN.md`

---

## 1. What happens today

The nurse's station has no idea whether a prescription exists. `Prescription Explain`
becomes ready purely by position in the journey, so she can be handed a patient with nothing
to explain.

### Where prescriptions come from

| Source | All-time | Today | Who |
| ---------------- | -------- | ----- | ------------------------------------- |
| `healthray`      | 31,366   | 62    | written in HealthRay, pulled by sync   |
| `visit`          | 5,684    | 56    | rendered by **our** PDF service        |
| scribe / upload / external | ~90 | 0 | scanned or uploaded one-offs      |

### The part that matters: nobody in the building presses anything

`source='visit'` looks like a human ending a visit in our app. It is not. Five code paths
call `savePrescriptionForVisit()` and **all five pass `source: "visit"`** — including
`autoSavePrescriptionAfterSeen()` in `services/healthray/db.js`, which fires when the
HealthRay sync sees the appointment marked *seen*, rebuilds the payload with
`buildVisitPayloadFromDb()`, and renders the PDF with `titlePrefix: "Prescription — Visit"`.

Today's titles are exactly that shape — *"Prescription — Dr. Beant Sidhu — Visit — 2026-08-26
01:56 PM"*. And the name in the title is **not** the person who clicked: `VisitPage.jsx:1167`
sets `rxDoctor` from `apptDoctorName`, the appointment's consultant, whoever is logged in.

Two facts close the argument:

- **0 MO sessions today**, while 56 app-generated prescriptions were written. Only `admin`
  (Admin, Gurjot) and `obt` (Nancy, Ritu, Jaspreet) accounts logged in at all.
- MOs have **7 logins ever**, last on 24 Aug, and **0 flow actions in 30 days**.

**So the prescription is currently produced by a background sync, not by a person in this
system.** The doctor writes it in HealthRay; we notice and render a copy.

---

## 2. "The MO will make it ready and submit it"

That is a normal division of labour — senior consultant dictates the plan, junior doctor
writes it up — and it is a reasonable thing to *want*. Two facts have to be designed around
rather than ignored:

**The MO's step is in the wrong place.** `mo_assessment` is step **#2** in all five
templates: after Vitals, before the lab, six steps before `sd_consult` (#10). A prescription
cannot be prepared there — the consultant has not decided the plan yet. If the MO is to
prepare it, that is **a new step after the consultation**, not the existing one.

**The MOs are not in the system.** Building a step that only an MO can clear, when no MO has
logged in today and the nurse's own step is auto-completed 133 times out of 135, would stall
every tested patient behind an empty desk. The Assistant Station already carries that risk
with one coordinator account; a second such chokepoint is worse.

### The resolution

Make the stage **auto-complete, with the MO as its named human owner.** It closes itself the
moment a prescription document lands — which is what already happens — and an MO (or a floor
manager) can submit it by hand when it does not. The user's model is expressed in who owns
the step; the floor never stalls waiting for someone who is not logged in.

---

## 3. Design

### The step

| | |
| ---------------- | ---------------------------------------------- |
| id               | `rx_ready`                                     |
| name             | Prescription — MO to prepare                   |
| background       | yes (nobody stands at it)                      |
| budget           | 5 min                                          |
| `assigned_role`  | `mo`                                           |
| station          | Doctor Room                                    |
| position         | after `sd_consult`, before `rx_explain`        |
| attaches         | every template that has `rx_explain`           |

### How it completes

1. **Automatically** — a sweep mirroring `syncLabReportsFromResults()`: if a `documents` row
   with `doc_type='prescription'` exists for that patient on the visit date, close the stage
   and flag `data.auto_completed = 'prescription'`.
2. **By hand** — `POST /flow/steps/:id/results-in`, already built and already gated by
   `canWorkStationRole`, so an MO or floor manager can submit a paper prescription.
3. **Skipped** — with a reason, when there is genuinely no prescription for this visit.

### The nurse gate

`Prescription Explain` will not start while `rx_ready` is open, mirroring the reports gate on
the consultation. The nurse gets a clear reason instead of a patient with nothing to explain,
and the override is one click away on the stage itself.

### The deadlock this would otherwise cause

`labStagesPending()` blocks a consultation while **any** background step on the visit is
open, with no bound on position:

```sql
WHERE visit_id=$1 AND is_background AND status NOT IN ('completed','skipped')
```

`rx_ready` sits *after* `sd_consult`. Under the current rule it would block the consultation
— and the consultation is what produces the prescription. Every tested patient would wedge:
the consult waiting on the prescription, the prescription waiting on the consult.

**Fix:** bound the gate by position — `AND step_order < <the step being started>`. A stage
that comes later was never meant to gate an earlier step. This is the general rule, not an
exception for `rx_ready`, so the next stage added after a consultation does not spring the
same trap.

---

## 4. Build order

1. Bound `labStagesPending()` by `step_order`; prove `sd_consult` still waits on the lab and
   report stages, which sit before it.
2. Migration: `rx_ready` into `flow_step_catalog`, then into every template holding
   `rx_explain`, renumbering around the not-deferrable `UNIQUE (visit_type_id, step_order)`.
3. `syncPrescriptionReady(visits, stepMap)` alongside the lab sweep; must **not** touch
   `report_desk` stages (see `LAB_FLOW_PLAN.md` §10 for why that sweep was over-reaching).
4. Gate `rx_explain` in `/start` with the same shape as the consultation gate.
5. Nurse station: a "Waiting on prescription" list beside her queue, reusing the two-section
   pattern from the Assistant Station.

Each step tested against live data before the next. **All five done.**

### Verified

```
REGRESSION  SD consult, lab stages open   → Reports not ready — waiting on Lab — delivered to lab
1  nurse calls in, no Rx written          → No prescription yet — the doctor has not submitted it
2  lab tries to submit the prescription   → This stage belongs to another station
3  MO submits it by hand (paper Rx)       → {"ok":true}
4  nurse calls in again                   → {"status":"started"}
5  AUTO: seed a prescription document     → rx_ready: pending → completed · auto = prescription
```

Templates after the migration, with `rx_ready` before `rx_explain` and — critically — **after**
`chief_consult`, so it cannot gate the chief:

```
FU_APPT        … 4.sd_consult  5.rx_ready  6.rx_explain  7.billing  8.pharmacy
NEW_WALK       … 12.chief_consult 13.dietitian 14.rx_ready 15.rx_explain …
```

0 duplicate `step_order` rows after renumbering.

### Frontend

The nurse's **Call in** is disabled while `rx_ready` is open, titled *"No prescription yet —
the doctor has not submitted it"*, so she sees the gate before clicking rather than as an
error after. It sits first in the title chain, ahead of the busy/claim reasons.

---

## 5. Open question

The prescription is rendered from HealthRay's clinical data by a sync. If MOs are to
genuinely author prescriptions here, the work is not this step — it is getting MOs to use
`/mo` and `/plan` at all, and having **End Visit** be the thing that produces the PDF. This
plan makes the step honest about who owns it; it does not by itself move authorship into the
building.

---

## 6. Naming, settled 2026-08-26

Both stages now name the person who does the work, after the reports step was found to name
the wrong one:

| id | name | owner |
| ------------------ | ----------------------------------- | ------------- |
| `report_delivered` | Reports — delivered to Consultant   | `report_desk` |
| `rx_ready`         | Prescription — MO to prepare        | `mo`          |

The sequence the names describe: **the consultant decides at `sd_consult` (#10), the MO
prepares the prescription at `rx_ready` (#11), the nurse explains it at `rx_explain` (#12).**
`rx_ready` still auto-completes the moment a prescription document lands, so the MO's name on
it marks ownership of the fallback, not a click that must happen.
