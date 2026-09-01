# Triage board — the day before the day

**Date:** 2 Sep 2026
**Status:** planned — not built
**Brief:** `Gini-Flow-Developer-Brief.docx` §1.2, §4.7, §5 (Phase 2)
**Prototype:** `gini-triage-v3-final.html` — **including its `#devNotes` div**, which the brief
explicitly says to read and which carries the API spec, the categorisation rules and the chip formats
**Route:** `/giniflow/triage`

Every other Gini Flow screen works the patient who is in the building. This one works the day
_before_ they arrive: are their reports in, what do the numbers say, who should see them, and who is
going to be a problem at 9am.

---

## 1. The finding that justifies building it

**`giniflow_visits.category` is NULL on every row — all 217 of them. Nothing has ever written it.**

That column is read by:

- the **board's** card dot and the `CATEGORY_DOT` legend (`FlowManagerPage`),
- the **consultant's** queue chip and consult header (`CATEGORY_BADGE`),
- the **MO station's** `canClose` rule — `CLOSEABLE_CATEGORY = "in_control"` is the server-enforced
  condition for closing a patient without the doctor seeing them,
- the SLA plan's per-category budgets (`06` Phase 4).

So today every card on every screen says "Uncategorised", and **the MO can never close a green
patient**, because nothing can ever be green. The triage board is the missing writer. That makes this
less a new screen than the thing that switches on behaviour already built into three others.

## 2. Which prototype, and what is authoritative

| File                            | Use                                                                                                  |
| ------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **`gini-triage-v3-final.html`** | **Build.** The visible board (§4) and, more importantly, `#devNotes` (§5–7) which is the actual spec |
| `gini-flow-manager.html`        | Reference — the kanban idiom this borrows                                                            |
| `gini-stations.html`            | Reference — the upload flow's shape                                                                  |

`#devNotes` is a `display:none` div holding an HTML comment. It is not decoration: it carries the
categorisation thresholds, the bio-chip colour rules, the report-status definitions and the endpoint
list. Where the drawn screen and the notes disagree, **the notes win** — they are the later thinking.

## 3. Five deviations from the notes, decided up front

The notes were written against the brief's proposed Supabase schema, not this repo. Three of their
instructions must not be followed literally.

**3.1 The category vocabulary already exists — use it.** The notes name
`getting_worse_out · getting_worse_in · getting_better_yet · in_control · no_reports`.
`shared/giniflowStatus.js` already defines, and three screens already render:

```
worse_out_of_range · worse_in_range · getting_better · in_control · no_reports
```

Same five buckets, different spellings. **Keep the repo's.** Renaming would touch the board, the
consultant, the MO close rule and every row already written.

⚠️ Note the collision: `shared/patientCategories.js` is a _different_ thing entirely — CGHS, senior
citizen, discount categories for the GHM sheet. The triage category is clinical. Do not merge them,
and do not name the new module `patientCategories`.

**3.2 Do not add `triage_category` / `assigned_sd_id` to `appointments`.** The notes ask for that
because they predate `giniflow_visits`, which already has `category`, `assigned_sd_id`,
`assigned_doctor_id` and `lifestyle_flagged`. Writing the same facts onto `appointments` would give
the hospital two answers. **The triage board writes `giniflow_visits`** — which also means a triaged
patient is already on the board before they walk in.

**3.2b ⚠️ …but the visit rows do not exist yet for the day being triaged.** This is the hole in
3.2, found while reviewing this plan against the database, and it has to be solved before anything
else here works.

`giniflow_visits` holds **today and yesterday only** — 103 rows for 1 Sep, 114 for 31 Aug. Meanwhile
there are 61 appointments for tomorrow, 53 the day after. `appointmentSync` creates a visit row per
appointment, but `cron/index.js` calls `syncAppointmentsToFlow()` with **no date**, so it only ever
builds today. A triage board opened on tomorrow's list would therefore have nothing to write
`category` to.

The fix is already in the code: `syncAppointmentsToFlow({ date })` is date-parameterised — nothing
calls it that way. So:

- **Opening triage for a date ensures that day's visits first.** `getTriageDay(date)` runs the sync
  for that date before reading. It is idempotent (`ON CONFLICT (patient_id, visit_date)`) and skips
  visits already at or past their target, so re-running is free.
- **And the worker should pre-build tomorrow** alongside today's loop, so the board is ready before
  the coordinator opens it rather than paying for it on first load.

A visit row created ahead of time sits at `booked`, which is exactly what the chain's first status
means and what the board's off-board `OFF_BOARD_STATUSES` already hides from the floor. Nothing
downstream sees a patient early.

**3.3 No `system_config` table for the rules, yet.** The notes want the thresholds editable without a
deploy. Reasonable eventually; premature now, because the thresholds already live in
`server/services/analytics/biomarkerTargets.js` — `BIO_TARGET`, `BIO_TIER`, `STABILITY` — which the
outcomes report and the consultant's brief both classify against. A second, editable copy would let
the triage board and the consult screen disagree about whether a patient is at target. **Read
`biomarkerTargets.js`**; revisit configurability when someone actually asks to change a number.

**3.4 The notes' appointment status chain is superseded.** `#devNotes` lists
`booked → confirmed_call → confirmed_day_before → checked_in → vitals_in_progress → … → billing →
pharmacy → completed`. That predates `shared/giniflowStatus.js`, whose `CHAIN` is the one definition
of the journey and contains no `billing`, no `awaiting_lab`, no `confirmed_day_before`. **Use `CHAIN`.**
The notes' chain survives only as evidence of what the confirmation pills were meant to say (§4.3).

## 4. The screen

### 4.1 Pipeline bar — eight steps, each a filter

From the prototype, in order: **Total → Lab reports in → Reports uploaded → Data complete →
Categorised → Assigned → Checked in → No-show/Cancel.** Every step is clickable and filters the
board (the notes are explicit). This is the day's readiness in one line: `82 categorised · 26 still
pending` is the coordinator's actual worklist.

### 4.2 Five columns

| Column                          | Category             | Who leads                        |
| ------------------------------- | -------------------- | -------------------------------- |
| 🔴 Getting worse — out of range | `worse_out_of_range` | Dr. Bhansali leads               |
| 🟡 Getting worse — in range     | `worse_in_range`     | SD leads, Bhansali validates     |
| ✅ Getting better               | `getting_better`     | SD closes, Bhansali async        |
| 🟢 In control                   | `in_control`         | SD closes independently          |
| 🔵 No reports                   | `no_reports`         | Chase reports, send phlebotomist |

The right-hand column is the one that pays for the screen: **`no_reports` is the list of patients who
will otherwise arrive and waste a consultation.** It is a call list, not a status.

### 4.3 The card

Per the prototype: time · name · `age/sex · file no` · visit number · appointment-confirmation pill ·
report status · **bio chips** · compliance · MHG questions/symptoms · assignment.

**Bio chips** are the heart of it — `6.9 → 7.4 HbA1c`, previous → current, coloured by the notes'
rule: red if risen past threshold, amber if risen but still in range, green if improving, neutral if
there is no previous value. That is the same "moved, and is it at goal" pair `consultBrief.js`
already computes; extend that module rather than writing a second rule.

**Appointment-confirmation pill.** The notes define statuses (`confirmed_call`,
`confirmed_day_before`) that this repo keeps elsewhere: `shared/callStatuses.js`, worked by the OBT
team on `/ghm`. Read from there rather than inventing a parallel vocabulary — but map it carefully,
because only one of its eleven values actually means "confirmed for today":

| `callStatuses` value                                                                | Pill                                                                                             |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `called`                                                                            | ✓ Confirmed                                                                                      |
| `no_call_needed`                                                                    | ✓ No call needed                                                                                 |
| `rescheduled` · `cancelled`                                                         | ⚠ **Not coming today** — the appointment moved or was dropped; this is the opposite of confirmed |
| `pending` · `not_picked` · `busy` · `switched_off` · `not_reachable` · `call_later` | Not confirmed                                                                                    |
| `wrong_number`                                                                      | ⚠ Cannot reach — needs a number                                                                  |

Mapping `rescheduled` to "confirmed" — as an earlier draft of this plan did — would put a patient who
is coming next week on tomorrow's board with a green tick.

**Never show a confirmation pill and a checked-in pill together** (the notes are explicit), because
once they are in the building the call no longer matters.

## 5. Auto-categorisation

The notes' engine, verbatim:

```
if HbA1c > 9.0 OR rising > 1.5 points        → worse_out_of_range
elif HbA1c 7.0–9.0 AND rising                → worse_in_range
elif HbA1c improving AND > 7.0               → getting_better
elif HbA1c ≤ 7.0 AND stable/improving        → in_control
elif no HbA1c                                → no_reports
```

Three things to hold onto while implementing it:

1. **It is HbA1c-only, deliberately.** This is a diabetes practice and HbA1c is the tier-1 marker in
   `BIO_TIER`. Do not quietly widen it to a composite score — that is a clinical change, not a
   refactor, and the consultant's own multi-marker summary already exists separately for the visit
   itself.
2. **"Rising" needs a previous value**, which means the same previous-appointment lookup
   `doctorStation.getConsult` already does. Reuse it.
3. **The coordinator can override anything**, and an override must survive the next auto-run. Store
   who set it: `category_source ('auto' | 'coordinator')` + `category_set_by` + `category_set_at`.
   Auto-categorisation may only write rows where `category_source` is null or `'auto'`.

**Special routing** (`diabetic_foot_ulcer → suggest Dr. Beant Sidhu`, `retinopathy → ophthalmology
referral flag`) is a _suggestion_ on the card, never an automatic assignment. Ship the two rules in
code with a comment saying more are expected; the `system_config` table can come when the list grows
past what a code change comfortably handles (§3.3).

## 6. Data the screen needs that does not exist

| Needed                       | State                                                                                     |
| ---------------------------- | ----------------------------------------------------------------------------------------- |
| Biomarkers, prev + current   | ✅ `appointments.biomarkers` — 4,009 rows in the last 30 days                             |
| Compliance %                 | ✅ `appointments.pre_visit_compliance.pct`                                                |
| Report status + source       | 🟡 Derivable from `documents` + `lab_results`; the notes' three states need defining once |
| Lifestyle flag               | ✅ `giniflow_visits.lifestyle_flagged`                                                    |
| **MHG questions / symptoms** | ❌ **No table.** The notes assume `mhg_previsit`; nothing equivalent exists               |
| Assignment                   | ✅ `assigned_sd_id` / `assigned_doctor_id`                                                |

**The MHG pre-visit gap is the one to decide before building.** The card devotes two coloured boxes
to the patient's own questions and symptoms, and they are the most human thing on the screen — _"kya
insulin lena padega?"_. Options: (a) build the pre-visit capture in the patient app first, (b) ship
the card without those boxes and add them later, (c) source them from Genie chat. **Recommend (b)** —
the board is valuable without them, and inventing a table nothing fills would be worse than an
honest gap. The card should simply omit the box rather than render an empty one.

## 7. Server

New `server/services/giniflow/triage.js`:

| Function                                       | Does                                                           |
| ---------------------------------------------- | -------------------------------------------------------------- |
| `getTriageDay(date, { doctorId, filter })`     | the five columns + the eight pipeline counts, one query set    |
| `categorise(visitId, category, actorId)`       | coordinator override, stamps `category_source = 'coordinator'` |
| `assign(visitId, { sdId, doctorId }, actorId)` | assignment, logged                                             |
| `autoCategoriseDay(date)`                      | the §5 engine over the day, skipping coordinator-set rows      |

`autoCategoriseDay` runs **on the worker**, not in a request: it is a whole-day sweep and belongs
beside the other cron loops in `server/services/cron/`. Trigger it after the appointment sync and
after a lab result lands, so a report arriving at 6pm re-colours tomorrow's board without anyone
pressing anything.

`category` is a property of the visit, not a journey step — so, like priority, it is written to
`giniflow_visits` directly and **not** as a `giniflow_visit_events` row. An event that is not a
journey step would restart the patient's station timer (the rule from `10-QUEUE-CONTROL-PLAN.md`).

## 8. Migration

```sql
ALTER TABLE giniflow_visits
  ADD COLUMN IF NOT EXISTS category_source TEXT,          -- auto | coordinator
  ADD COLUMN IF NOT EXISTS category_set_by INT REFERENCES doctors(id),
  ADD COLUMN IF NOT EXISTS category_set_at TIMESTAMPTZ;
```

Nothing else. `category`, `assigned_sd_id`, `lifestyle_flagged` all already exist.

## 9. API

Behind a new `GINIFLOW_TRIAGE` capability. The brief calls this "**the coordinator's** pre-OPD
board", so: **coordinator and admin**. Not reception — their job is the desk and the payment queue,
and the categorisation here is a clinical judgement. Whether **OBT** should have read access is an
open question (§12): they work the confirmation calls this board displays, but on `/ghm`, and two
screens writing the same call outcome is how the vocabularies drifted the first time.

| Method | Path                            | Body / query                                      |
| ------ | ------------------------------- | ------------------------------------------------- |
| GET    | `/api/giniflow/triage`          | `?date&filter=<pipeline step>&doctorId=`          |
| PATCH  | `/api/giniflow/triage/:visitId` | `{ category?, assignedSdId?, assignedDoctorId? }` |
| POST   | `/api/giniflow/triage/auto`     | re-run the engine for a date (admin/coordinator)  |

Uploads reuse the existing document pipeline and the lab station's upload — **not a third path**.
The prototype's per-card Upload pre-locks the patient (no matching needed); the global one searches
first and must confirm the auto-match before saving. Both are the notes' words and both are right:
an auto-matched report saved to the wrong patient is the worst outcome this screen can produce.

## 10. Client

`src/pages/giniflow/TriageBoardPage.jsx` + `src/pages/giniflow/triage/` (PipelineBar, TriageColumn,
TriageCard, AssignMenu, UploadDialog). Live updates come free from the existing SSE hub
(`eventHub.js`) — the notes ask for realtime and the repo now has it.

Column layout borrows the board's `.col` / `.col-body` scroll pattern, and — the trap three screens
have now hit — **the page must declare its own scroll container**, because `.gf` is
`height:100vh / overflow:hidden`.

## 11. Smoke coverage

`smoke:giniflow-triage` — **a future date having no visit rows until the board builds them, then
having exactly one per appointment (§3.2b)**; the engine's five branches against fixed biomarker pairs, including "rising
by more than 1.5" and "no HbA1c at all"; a coordinator override surviving a re-run; auto never
overwriting a coordinator row; the pipeline counts summing to the day's total; `no_reports` holding
exactly the patients with no HbA1c; and a categorised patient turning green on the board and becoming
closeable at the MO station — which is the whole point.

## 12. Open questions

1. **MHG pre-visit questions/symptoms** — §6. Blocks two boxes on the card, nothing else.
2. **Report status thresholds** — the notes define "all required tests" as HbA1c · FBS · Lipid ·
   eGFR · UACR. Confirm that list is still right before it becomes a red/amber/green rule.
3. **Should OBT see this board read-only?** They own the confirmation calls it displays, but on
   `/ghm`. Two screens writing the same call outcome is how three copies of the call vocabulary
   appeared before `shared/callStatuses.js` unified them — so read-only, or not at all.
4. **How far ahead does the worker pre-build?** Tomorrow is clearly right; a week would create visit
   rows for appointments that will still move. Recommend tomorrow only, on the existing loop.
5. **Who runs triage?** The prototype sits under an "OPD Manager" nav beside Schedule and Live
   Dashboard, which in this repo is `/opd`. Decide whether the board lives at `/giniflow/triage` or
   as a tab there — recommend the former, since it writes `giniflow_visits` and shares the module's
   vocabulary.
