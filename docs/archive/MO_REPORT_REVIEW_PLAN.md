# Reports to the MO — review, draft the prescription, then the consultant

**Status:** built and live, 2026-08-27
**Changes:** `docs/LAB_FLOW_PLAN.md` §9–10, `docs/PRESCRIPTION_FLOW_PLAN.md`, `docs/FLOW_STATIONS.md`
**Supersedes:** the 2026-08-26 decision to deliver reports to the consultant

---

## 1. What changes

Today, once the lab is done the report goes straight to the consultant and the prescription
is drafted _after_ the consultation:

```
… 7 Reports printed (GDA)   8 Reports delivered to CONSULTANT (GDA)
  9 Wait for SD            10 SD Consultation        11 Prescription — MO to prepare
 12 Prescription Explain   13 Billing                14 Pharmacy / Exit
```

The new order puts the MO between the lab and the consultant:

```
… 7 Reports printed (GDA)        8 Reports delivered to MO (GDA)
  9 MO Reviews Reports (MO)     10 Prescription Ready (MO)
 11 Wait for Consultant         12 SD Consultation
 13 Prescription Explain (nurse) 14 Billing   15 Pharmacy / Exit
```

So: the GDA hands the printed report to the **MO**, the MO reads it and drafts the
prescription, and only then does the patient wait for the consultant. Everything from the
consultation onward is unchanged.

### Step-by-step change list

|                     | Now                               | After                                  |
| ------------------- | --------------------------------- | -------------------------------------- |
| `report_delivered`  | Reports — delivered to Consultant | **Reports — delivered to Doctor (MO)** |
| _(new)_ `mo_review` | —                                 | **MO Reviews Reports**, owner `mo`     |
| `rx_ready`          | after `sd_consult`                | **before** `wait_sd`                   |
| `wait_sd`           | Wait for SD                       | **Wait for Consultant**                |
| everything else     | unchanged                         | unchanged                              |

This reverses yesterday's rename. That decision was made because the MO's step was #2 and
the report landed at #8 — six steps after their part ended. **This plan removes that
objection by giving the MO a real step at #9**, so the report now arrives for work they are
about to do rather than work they finished.

---

## 2. The risk that decides whether this is safe

Two of the three new/moved steps belong to the MO, and both sit **in front of the
consultation**. So the consultant cannot start until an MO has acted, twice.

```
MO accounts: 5        MO logins ever: 7, last 24 Aug
MO flow actions in 30 days: 0
Doctor Assessment steps closed by a person: 282 of 2,675 (10.5%)
```

**As things stand, this would stall every tested patient.** The reports gate already blocks
`SD Consultation` while any background stage before it is open, so adding two MO-owned stages
in front of it hands the floor's throughput to five accounts that have logged in seven times
in total.

That is not an argument against the change — it is an argument that the change has to ship
with a way through. Three mitigations, all recommended together:

1. **Anyone senior can clear an MO stage.** `results-in` already accepts the owning station
   plus floor managers; extend it so the patient's own consultant can also complete
   `mo_review` and `rx_ready` — the same narrow rule already used for `rx_ready`
   (own `assigned_sd`/`assigned_chief` only).
2. **Both stages keep ✕ Skip**, with a reason, exactly like the lab stages.
3. **Ship it behind the existing MO station panel** so the work is visible the moment an MO
   logs in — see §4.

If MOs are not going to use the system, the honest options are to make these two steps
**non-gating** (informational, the consultation proceeds regardless) or not to ship the
change.

**Decision: ship gating, with all three mitigations.** The flow is the point of the change —
a non-gating "MO reviews reports" step would be a label nobody has to honour. The mitigations
mean no patient can be stuck: the consultant covering the patient, or any floor manager, can
clear either stage, and both carry ✕ Skip. Watch the first day; if consultations start
queueing behind unworked MO stages, flipping them to non-gating is a one-line change to
`labStagesPending`.

---

## 3. Design

### `mo_review` — MO Reviews Reports

|                 |                                                                           |
| --------------- | ------------------------------------------------------------------------- |
| id              | `mo_review`                                                               |
| name            | MO Reviews Reports                                                        |
| owner           | `mo`                                                                      |
| station         | Doctor Room                                                               |
| budget          | 10 min                                                                    |
| background      | **yes** — the patient is not standing there                               |
| `display_order` | 34 (after `rx_ready` at 33; template position is what orders the journey) |
| completes       | by hand from the MO station · ✕ Skip with a reason                        |

**No auto-complete.** Reading a report is not observable from any data we hold; a sweep that
closed it would assert a review nobody did. This is the same rule that stopped the
`lab_results` sync closing the GDA's print-and-carry stages (`LAB_FLOW_PLAN.md` §10).

**It replaces the "✓ Reviewed" stamp.** The doctor panel currently writes
`data.reviewed = { by, at }` on `report_delivered` via `POST /flow/steps/:id/reviewed`. That
stamp exists precisely because there was no step for it. With a real step, the endpoint and
the stamp both go — one mechanism, not two.

### `rx_ready` moves before the consultation

The step keeps its id, owner and name (**Prescription — MO to prepare**); only its template
position changes. **One consequence has to be accepted deliberately:**

> `rx_ready` auto-completes when a `documents` row with `doc_type='prescription'` exists for
> that patient today. Those documents are produced when the **visit ends** — by the consultant
> ending it, or by the HealthRay sync seeing the appointment marked _seen_. **3 landed today,
> all after the consultation.** Sitting before the consultation, the auto-complete will
> essentially never fire.

So `rx_ready` stops being "a fallback that rarely needs pressing" and becomes **a step an MO
must press every time**. That is the intent — the MO drafts the prescription for the
consultant to approve — but it is a real change in workload, and the §2 risk applies to it
twice over.

The sweep should stay wired up regardless: if a prescription does exist early (a paper Rx
scanned in, a regenerated PDF), closing the stage automatically is still correct.

### The nurse's gate needs re-basing

Today `Prescription Explain` is blocked while `rx_ready` is open, with a fallback to "does a
prescription document exist" for visits that have no stage. Once `rx_ready` is satisfied
_before_ the consultation, that gate would pass while the **final** prescription — the one the
nurse actually explains — does not yet exist.

**Fix:** make the nurse's gate require **both** — `rx_ready` closed **and** a prescription
document on file. The MO's draft releases the consultant; the real document releases the
nurse. Without this, moving `rx_ready` silently disarms a guard built two days ago.

### `wait_sd` → Wait for Consultant

Display-name only. The id, the `flow_coordinator` owner and the auto-close behaviour when the
consultation starts all stay. `Wait for Chief` is untouched.

### `report_delivered` → delivered to the MO

Display-name only, and `assigned_role` stays `report_desk` — the GDA still does the
delivering; only the recipient named on the label changes.

---

## 4. Screens

**MO station (`/flow/station/mo`)** — the right-hand column becomes two lists, the same
two-section pattern the Assistant Station uses:

```
┌ Reports to review ───────────── 2 ─┐   ← mo_review open, everything before it closed
│  lab panel · values · View report  │
│                      [✓ Reviewed]  │
├ Prescriptions to prepare ────── 1 ─┤   ← rx_ready open, mo_review done
│                 [✓ Prescription    │
│                     prepared]      │
└────────────────────────────────────┘
```

Both lists gate on "nothing before it still open", the rule already used by
`prescriptionRows()` and the Assistant Station.

**Assistant Station** — button text only: _"✓ Handed to the doctor"_.

**Consultant (`/flow/my-patients`)** — the "Lab reports handed to you" panel is **removed**;
reports now go to the MO. The consultation box keeps its lab panel, so the consultant still
sees results without a separate list. `deliveredReportRows()` and the `reviewed` endpoint are
deleted with it.

**Floor / journey strips** — no change; background stages are already filtered out.

---

## 5. Migration

1. **Catalog:** insert `mo_review`. Rename `report_delivered` and `wait_sd`. `rx_ready`
   unchanged.
2. **Templates:** for every template containing `report_delivered`, lay the tail back down as
   `report_delivered → mo_review → rx_ready → wait_sd → …`, removing `rx_ready` from its old
   position. Must use the scale-then-renumber technique — `UNIQUE (visit_type_id, step_order)`
   is **not deferrable**, so a straight UPDATE collides.
3. **Live steps:** rename `step_name` on existing `flow_visit_steps` rows so today's patients
   read consistently. **Do not reorder or insert steps into visits already in flight** — a
   patient mid-journey should not gain a step behind them or in front of them.
4. **Gates:** `labStagesPending()` is already bounded by `step_order`, so `mo_review` and
   `rx_ready` gate the consultation automatically once they sit before it. No change needed —
   but this is exactly why the bound was added, and it should be re-verified after the
   migration.
5. **Nurse gate:** implement the "both conditions" rule from §3.
6. **Permissions:** allow the patient's own consultant on `mo_review`, matching the existing
   `rx_ready` rule.

### Also in scope (found on review, 2026-08-27)

7. **The MO panel becomes two lists.** `DoctorReportsPanel` renders its own `<aside>`, so
   stacking two would produce two sticky rails. Change it to render a `<section>` and let the
   MO station wrap both in one `<aside className="station-side">`. Its `deliveredReportRows()`
   is replaced by a generic `stageRows(visits, catalogId)`, since both lists want the same
   rule — the stage is open and nothing before it is.
8. **Delete the review stamp end to end**, not just its button: `POST /flow/steps/:id/reviewed`,
   `useFlowMarkReviewed`, `deliveredReportRows`, and the `data.reviewed` filter inside the
   panel. Leaving a dead endpoint that writes a field nothing reads is how the next person
   gets confused. (`PATCH /api/documents/:id/reviewed` is unrelated — that is the PDF viewer
   marking a document read, and it stays.)
9. **The demo sets reference step ids, not positions.** `RX_WALKTHROUGH` parks patients with
   `readyAt: "rx_ready"` and `stopAt: "sd_consult"`, both looked up by `step_catalog_id`, so
   they survive the reorder. But DEMO_R2/R3 are seeded "consultation done, prescription
   outstanding" — after the change that state is impossible, because `rx_ready` now precedes
   the consultation. The set needs re-cutting around the new order, plus a patient parked at
   `mo_review`.
10. **`NEW_APPT` / `NEW_WALK` have a chief consultation.** `rx_ready` currently sits _after_
    `chief_consult`; moving it before `wait_sd` puts it before **both** consultations. That
    follows from "MO drafts, then the consultant sees them", but it means the chief is gated
    on the MO too — worth being explicit about rather than discovering later.
11. **Docs to update after the change:** `FLOW_STATIONS.md` §2, §3, §4, §5, §10;
    `LAB_FLOW_PLAN.md` §9–10; `PRESCRIPTION_FLOW_PLAN.md` §3, §6.

### Verification checklist

- `SD Consultation` refuses while `mo_review` is open → _"Reports not ready — waiting on MO
  Reviews Reports"_
- …and while `rx_ready` is open
- `Prescription Explain` refuses when `rx_ready` is closed but no prescription document exists
- A different consultant cannot clear another's `mo_review`
- 0 duplicate `step_order` rows in every template after renumbering
- Today's in-flight visits keep their original step count

---

## 6. What this plan does not do

- **It does not make MOs use the system.** It gives them a queue; §2 is the honest risk.
- **It does not move prescription authorship into this app.** The PDF is still rendered from
  HealthRay's clinical data by a sync (`PRESCRIPTION_FLOW_PLAN.md` §5). `rx_ready` records
  that an MO says a prescription is ready — it does not itself create one.
- **It does not touch visits already in flight**, so the floor will run two shapes side by
  side until today's patients clear.

---

## 7. Built — what shipped and what it cost

```
1 consultant starts before MO review   → Reports not ready — waiting on MO Reviews Reports
2 lab tries to clear MO review         → This stage belongs to another station
3 a DIFFERENT consultant clears it     → This stage belongs to another station
4 the MO reviews the reports           → {"ok":true}
5 consultant starts, prescription open → Reports not ready — waiting on Prescription — MO to prepare
6 MO drafts the prescription           → {"ok":true}
7 consultant starts                    → {"status":"started"}
A nurse, rx_ready done, NO document    → No prescription yet — waiting on the prescription
B nurse, prescription on file          → {"status":"started"}
```

Templates after the migration, 0 duplicate `step_order` rows:

```
FU_APPT_TESTS  … 8.report_delivered 9.mo_review 10.rx_ready 11.wait_sd 12.sd_consult 13.rx_explain …
NEW_APPT       … 9.mo_review 10.rx_ready 11.wait_sd 12.sd_consult 13.wait_chief 14.chief_consult …
```

### Two bugs the build exposed

**The ordering guard blocked every consultation behind its own waiting room.** The guard
added on 2026-08-26 ("not their turn yet") counted `Wait for Consultant` as an unfinished
earlier step — but that step is what `/start` auto-completes a few lines later. It now skips
`WAITING_ROLE`, matching the one-place guard.

**The nurse gate lived in only one of two paths.** `/start` had the "stage AND document" rule;
the auto-advance in `POST /visits/:id/advance` still checked the stage alone, so completing
the consultation pulled the nurse's step straight to `in_progress` regardless. Both now call
one `rxExplainBlocked()`.

### Not changed

**No-test visits** (`FU_APPT`, `FU_WALK`) keep `rx_ready` after the consultation and gain no
`mo_review` — they have no report handover, so there is nothing for the MO to review and
nothing to draft from beforehand. `rx_ready` therefore means two slightly different things
depending on whether the patient had tests. Worth revisiting if it causes confusion.

**Visits already in flight** were renamed but not restructured, as planned.

---

## 8. Post-build review, 2026-08-27

Re-reading the plan against the running system found one substantive defect and three stale
documents.

### Defect: `mo_review` did not attach to a visit that gained a test later

Tests are often added _after_ check-in — from the bill, or from **+ test** at the lab.
`attachBackgroundStages()` pulls in the stages whose `attach_when_any` names the new test, and
the lab and report stages all carry it. `mo_review` was created template-only, so those
patients had **Reports — delivered to Doctor** attached with no review step behind it: the
report reached the MO and the gate this plan exists for simply was not there.

**541 FU_APPT visits have taken that path**, so it is the common case rather than an edge.
Fixed by giving `mo_review` the same `attach_when_any`; verified by adding a Blood Sample to a
no-test visit and watching the journey rebuild:

```
1 Vitals  2 Doctor Assessment  3 Blood Sample
4-6 lab stages  7 Reports printed  8 Reports — delivered to Doctor
9 MO Reviews Reports  10 Wait for Consultant  11 SD Consultation
12 Prescription — MO to prepare  13 Prescription Explain …
```

### Three journey shapes now exist, deliberately

| Visit                        | MO review | Prescription drafted        |
| ---------------------------- | --------- | --------------------------- |
| Tested from check-in         | yes, #9   | **before** the consultation |
| No tests                     | no        | after the consultation      |
| No tests, a test added later | yes, #9   | after the consultation      |

The third is a hybrid: `rx_ready` is already in the template at its later position and
`attachBackgroundStages()` does not relocate existing steps. Making it uniform would mean
moving `rx_ready` before `wait_sd` in the no-test templates too — which would gate **every**
consultation in the hospital on an MO drafting a prescription, not just the tested ones. Given
§2, that is a deliberate no. Revisit if MOs become active users.

### Stale documentation, corrected

- `FLOW_STATIONS.md` §8 still listed `POST /flow/steps/:id/reviewed`, deleted in this build.
- `LAB_FLOW_PLAN.md` still called the waiting step **Wait for SD** in three places.
- `LAB_FLOW_PLAN.md` §10 still described the consultant's "Lab reports handed to you" panel,
  which moved to the MO station and became two lists.
