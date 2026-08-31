# Phase 2 — audit

**Date:** 31 Aug 2026
**Scope:** everything Phase 2 has shipped so far — `06-PHASE-2-PLAN.md` tasks 2.0–2.12 against
`server/migrations/2026-08-31_giniflow_vitals.sql`, `server/routes/giniflowStations.js`,
`server/services/giniflow/{vitalsStation,appointmentSync}.js`, `shared/giniflowVitalsSpeech.js`,
`shared/giniflowStatus.js` (Phase 2 changes), `src/hooks/useVoiceVitals.js`,
`src/pages/giniflow/VitalsStationPage.jsx`, `src/queries/hooks/useGiniflowVitals.js`,
`src/styles/giniflow-station.css`, the two new smoke suites, and the RBAC/router wiring.
**Method:** static review against the plan and the prototypes. Nothing executed against the
database; no files changed.

**Findings:** 3 critical · 8 high · 11 medium · 5 low.
**Phase 2 completion:** 2 of 4 stations, 0 of 1 triage board, 1 of 3 cross-station triggers.

> **Note:** the reception station (task 2.4) landed while this review was being written and is
> assessed here as shipped. Findings P2-26 and P2-27 cover it.

---

## 1. Executive summary

Two things shipped, and one of them was not on the task list.

**The appointment sync** (`appointmentSync.js`, wired into the worker on a 30-second loop) is the
more consequential. It turns HealthRay's appointment list into real `giniflow_visits`, which means
**the Flow Manager board is now running on real patients in production** — the thing Phase 1
explicitly could not do. It is careful work: one row per patient rather than per appointment (with
the oscillation bug that caused explained in a comment), never moves a patient backwards, skips the
transaction entirely for unchanged rows.

**The vitals station** (task 2.6) is the first real station: a queue, a seven-field form with
auto-BMI and last-visit comparison, deterministic voice entry, and a save that writes a reading and
advances the patient in one transaction. The voice parser is the best-judged piece of work in the
phase — a deterministic parser rather than an LLM, with the reasoning written down and 18 test
cases including the misheard-number rejections.

**The reception station** (task 2.4) landed during this review: a three-bucket payment queue, per-test
prices and totals, "Payment received" and "Insurance claim", each writing a `giniflow_lab_order_events`
row — and, in the same transaction, the sample task that is the brief's trigger 3. A double-tap at a
busy counter is idempotent. It is good work with one live hazard: **the price list is the
prototype's, seeded into production**, flagged in the migration and by a `source` column, but on
screen it renders as rupees against a patient's name.

Still unstarted: lab (2.5), MO/SD (2.7, and its missing mockup 2.0b), the triage board (2.8),
triggers 1 and 2 (2.9), the allergy strip (2.10), the station launcher (2.0), the status-chain
extension (2.2), and two of the four new tables.

**What blocks release is one decision made silently.** The plan's definition of done says the
vitals station writes to the shared `vitals` table and that "no second copy of a patient's clinical
readings exists". §0.5 argues it over two paragraphs; open question 12 asks for a ruling _before_
task 2.6. The implementation created `giniflow_vitals` — a second copy — and answered question 12
in a migration comment. The consequence is concrete and clinical: **a reading taken at the Gini Flow
vitals station never reaches `vitals`, so the doctor's consult view, the patient's record and the
MyHealth Genie sync never see it.** The `promoted_at` column exists; nothing promotes.

That is live today, for `nurse`, `mo` and `coordinator`, on production, alongside the old vitals
desk which writes somewhere else.

## 2. Overall assessment

**Needs improvement — good parts, wrong shape at the seam.**

The code quality holds the Phase 1 standard: transactions where they belong, comments that explain
why, guards written from real floor failures, smoke suites that isolate onto a test day and assert
the `flow_*` separation. The voice feature is genuinely well judged, and the sync's understanding of
HealthRay's quirks is hard-won and correctly recorded.

But Phase 2 is where the flow stops being one screen and becomes a chain of hand-offs, and the
review has to judge the hand-offs. Three of them are wrong or absent:

- **Station → patient record.** Broken by design choice (§5, P2-01).
- **HealthRay → board.** Real patients now arrive, but most of them jump straight from `checked_in`
  to `exited`, so the board's per-station timings — the entire product — are not populated by real
  data (P2-04).
- **Station → station.** Not built; the triggers are Phase 2's stated deliverable (2.9).

The plan anticipated almost all of this. Its risk 15 ("two vitals desks recording the same patient
into different tables is the most likely way this goes wrong on the floor") is now not a risk but
the current state.

---

## 3. Plan vs implementation

| #    | Requirement / task                                        | Status     | What exists                                                                                                                       | What is missing / wrong                                                                                                 | Pri |
| ---- | --------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --- |
| 2.0  | Station launcher at `/giniflow/stations`                  | ❌ Missing | Nothing                                                                                                                           | No launcher. The vitals page is reachable only from the nav; there is no per-station tile or live count                 | P2  |
| 2.0b | Design the MO/SD station (blocked on Q1)                  | ❌ Missing | Nothing                                                                                                                           | No mockup, no decision on who draws it. Still blocks 2.7 — the screen the plan calls the most important                 | P1  |
| 2.1  | Audit what Phase 1 gives each station                     | ❌ Missing | Nothing                                                                                                                           | The "what is new vs. reuse" table the task asks for was never written                                                   | P3  |
| 2.2  | Extend the chain to the triage 16; add the Phase 2 tables | 🟡 Partial | `giniflow_vitals` table only                                                                                                      | Chain still Phase 1's 14. No `giniflow_rx_proposals`, `giniflow_triage`, `system_config`. Q2 and Q9 still open          | P1  |
| 2.3  | Every station write goes through `advanceStatus`          | ✅ Full    | Both station writes and the sync call the engine; no direct `current_status` update outside it                                    | Honoured — but every caller passes `allowSkip: true`, which the engine's own comment forbids for stations (P2-06)       | P1  |
| 2.4  | Reception station (payments)                              | 🟡 Partial | Queue in three buckets, per-test prices and total, payment/insurance clear, event log, catalogue table, smoke suite, routed + nav | Prices are the prototype's placeholders, live in production (P2-26). No reversal path (P2-27). Q3 still open            | P1  |
| 2.5  | Lab station (five buckets, payment gate)                  | ❌ Missing | Phase 1's `giniflow_lab_orders` + events only                                                                                     | No screen. The server-side payment gate the DoD names is not written. `labSync` reconciliation (Q8) undecided           | P1  |
| 2.6  | Vitals station                                            | 🟡 Partial | Queue, 7 fields, auto-BMI, last-visit comparison, voice entry, Done → advances and auto-loads next                                | Writes `giniflow_vitals`, not `vitals` — against the DoD (P2-01). No allergy strip. Skips `with_vitals` (P2-06)         | P0  |
| 2.7  | MO/SD station                                             | ❌ Missing | Nothing                                                                                                                           | Blocked on 2.0b. The `ready_for_doctor` / order-tests / green-close actions do not exist                                | P1  |
| 2.8  | Triage board                                              | ❌ Missing | Nothing                                                                                                                           | No board, no rule engine, no pipeline bar, no biomarker chips (beyond two on the vitals queue), no override model       | P1  |
| 2.9  | Cross-station triggers 1–3                                | ❌ Missing | Nothing                                                                                                                           | `triggers.js` does not exist. Named in the brief's Phase 2 deliverable                                                  | P1  |
| 2.10 | Allergy strip on every screen                             | ❌ Missing | Nothing (`p.notes` is selected in the vitals query and discarded — a half-started path)                                           | Correctly blocked on Q10, but the one station that shipped has no strip, which is the retrofit the task warns about     | P1  |
| 2.11 | Per-station capabilities                                  | 🟡 Partial | `GINIFLOW_STATION_VITALS` declared, granted, route-gated, page-gated, nav entry                                                   | The other seven capabilities were not declared as the task asks. Grants drift from the plan's table (P2-16)             | P2  |
| 2.12 | Smoke coverage                                            | 🟡 Partial | `smoke:giniflow-vitals` (station), `smoke:giniflow-speech` (parser), render smoke extended to the page                            | No `smoke:giniflow-stations` chain walk, no `smoke:giniflow-triage`, no import guard, no HTTP/RBAC test for the station | P1  |
| —    | HealthRay → `giniflow_visits` sync (not a numbered task)  | ✅ Full    | 30s worker loop, one row per patient, never-backwards, blocked-patient exclusion, dedicated smoke suite                           | Status mapping collapses the chain (P2-04); single-consult-room assumption (P2-05)                                      | P1  |
| —    | Voice vitals (Q4, marked "built" in the plan)             | ✅ Full    | Deterministic parser, live captions + Deepgram fallback, bounds shared with the form and the Zod schema                           | Processor choice never decided (P2-09); no Hindi/number-word handling                                                   | P1  |

**Definition-of-done scorecard** (from the plan):

| DoD item                                                            | Met?                                                     |
| ------------------------------------------------------------------- | -------------------------------------------------------- |
| Full pre-doctor chain walkable from two browsers in different roles | ❌ — only one station exists                             |
| One event per transition with the right `actor_role`                | ✅ — asserted by the vitals smoke                        |
| Board runs on real floor activity                                   | 🟡 — real patients yes, real station timings no (P2-04)  |
| Lab cannot collect before payment, enforced server-side             | ❌ — no lab station                                      |
| Triage auto-categorises with visible override                       | ❌ — not built                                           |
| Allergy strip on every screen, with real data                       | ❌ — not built (correctly blocked)                       |
| Vitals station writes `vitals`; no second copy                      | ❌ — **inverted** (P2-01)                                |
| `smoke:giniflow-stations` + `smoke:giniflow-triage` pass            | ❌ — neither exists                                      |
| Nothing in `flow_*` changed                                         | ✅ — asserted, and extended to the shared `vitals` table |
| No Phase 2 file imports from the old module                         | ✅ in fact — ❌ as a check (no import guard was written) |

---

## 4. What is good — retain

### The voice feature is the best-judged work in the phase

- **A deterministic parser, not an LLM**, with the reason written at the top of the file: these are
  numbers a doctor may act on, and a model that silently rounds 148 to 150 or infers a pulse nobody
  said would be worse than no voice entry. That is the correct call and the correct justification.
- **Bounds are shared** between the parser, the form's inline validation and the server's Zod
  schema. One definition of "physiologically plausible", enforced three times.
- **An out-of-range value is reported as a mishearing, not stored** — and the UI says which value it
  ignored and what it heard. This is the single most important behaviour in the feature.
- **The keyword window** stops "pulse 82, spo2 98" reading 98 as the pulse, and the smoke suite
  tests exactly that case.
- **It never saves.** It fills the form; the nurse reads back and presses Done. Stated in the file
  header and true in the code.
- **The live caption** shows a wrong number while the nurse is still speaking rather than after the
  form is filled from it — and when the browser cannot caption, the interface says so instead of
  looking broken.
- **The microphone is released on unmount**, with the reason ("a station screen is left open all
  day") recorded.

### The appointment sync

- **One row per patient, not per appointment**, with the failure it fixes written down: five
  patients held multiple appointments today, and two rows fighting over one visit made the status
  oscillate forever. That comment will save someone a day.
- **Never moves a patient backwards** — a station may have advanced them past what HealthRay knows,
  and HealthRay lags by a poll.
- **Skips the transaction for unchanged rows**, with the reason (a BEGIN/COMMIT per appointment over
  the pooler made a full day take 20 seconds).
- **Reads `appointments`, never HealthRay directly** — the WAF/IP-block lesson from the README,
  correctly applied.
- **Blocked patients excluded**, consistent with the rest of the repo.

### The vitals station

- **The save is one transaction** — reading, status move and the event carrying the numbers, so the
  Flow Manager timeline shows what was recorded without a join.
- **A correction does not walk the patient back**, and is a new row rather than an overwrite. Both
  asserted.
- **BMI is computed, never asked for.**
- **Derived active patient, not an effect** — the screen opens on whoever is at the station with no
  click and no flash of the empty state.
- **Inline out-of-range marking** before the save is allowed, with a done-bar that changes its own
  copy to say which state the form is in.
- **Last-visit comparison** ("↑ 1.4 kg from last visit", "Last: 152/96") reads the real `vitals`
  history — the right table for history even though the write goes elsewhere.

### Testing

- **The station smoke runs on a day of its own** (`2019-01-03`), never today's floor — and the file
  says why the scope was narrowed: real readings taken through the live station must survive a smoke
  run, and did not before.
- **The isolation assertion was extended** from `flow_*` to the shared `vitals` table.
- **The render smoke covers the new page** server-side, including a "no raw `undefined` in the
  markup" check.
- **The parser suite tests the dangerous cases**, not just the happy ones.

---

## 5. What is bad / incorrect

### 🔴 P2-01 · Critical · P0 — a reading taken at the vitals station never reaches the patient's record

`server/migrations/2026-08-31_giniflow_vitals.sql`, `server/services/giniflow/vitalsStation.js`

**Problem.** The station writes `giniflow_vitals`. Nothing copies it into `vitals`. The
`promoted_at` column exists and is never set — the smoke suite asserts it stays null.

**Why it is a problem.** `vitals` is what the doctor's consult view, the patient chart, `/opd`, the
`/visit` tracker and the MyHealth Genie sync all read. A nurse records BP 148/94 at the Gini Flow
station; the doctor opens the patient ten minutes later and sees the last HealthRay reading, or
nothing. The screen gives the nurse every signal that the reading is saved — a toast, a done count,
the patient moving to the MO queue — and it is, into a table nobody clinically reads. The Flow
Manager timeline shows the numbers in the event meta, so the coordinator can see them and the
clinician cannot.

This is not a hypothetical: the station is granted to `nurse`, `mo` and `coordinator` today, and the
appointment sync is populating the queue with real patients.

**Recommendation.** Either promote on save (write both, inside the existing transaction, tagging
`vitals.source` as the plan's §2.6 specifies) or take the station out of the nav until promotion
exists. A half-written clinical reading is worse than none, because it looks complete.

### 🔴 P2-02 · Critical · P0 — two live vitals desks, two tables, no rollout decision

**Problem.** `/flow/station/vitals` (old module, writes `flow_visit_steps`) and
`/giniflow/station/vitals` (new, writes `giniflow_vitals`) are both in the nav, both granted to
`nurse`, both live on production.

**Why it is a problem.** The plan named this as risk 15 and as open question 15 — "which staff use
which station screens, and who tells them" — and answered neither before shipping the screen. Two
nurses on two desks will record the same patient into two systems with different numbers and no
reconciliation. Combined with P2-01, neither copy reaches the doctor reliably.

**Recommendation.** Before the screen is used on the floor: decide which desk is live, remove the
other from that role's nav, and tell the named staff. This is a rollout task, not a code task, and
it is currently nobody's.

### 🔴 P2-03 · Critical · P0 — open question 12 was answered by the implementation, not by a decision

**Problem.** The plan states three times that vitals are the patient's clinical record and must not
be forked (§0.5, §2.6, DoD). Question 12 asks explicitly: _"Is writing `vitals` a breach of the
separation rule? … If the ruling is that Gini Flow must own its vitals too, say so before 2.6."_ The
migration reverses the ruling and records the reasoning in its own header.

**Why it is a problem.** The reasoning in the migration is not unreasonable — a third writer while
two floor modules run in parallel is a real hazard. But the plan asked for a decision from a person
before the task started, and the decision was taken inside the task by the implementer, leaving the
plan's own definition of done stating the opposite of what shipped. Anyone reading
`06-PHASE-2-PLAN.md` today will be misled about how the system works.

**Recommendation.** Take the decision explicitly, then make the plan and the code agree. If the
module-owned table stays, §0.5, §2.6, the DoD and question 12 all need rewriting, and the promotion
path in P2-01 needs a scheduled owner.

### 🟠 P2-04 · High · P1 — real patients arrive on the board with no station timings

`server/services/giniflow/appointmentSync.js` — `HEALTHRAY_STATUS_TO_CHAIN`

**Problem.** The mapping is `scheduled → booked`, `checkedin → checked_in`,
`in_visit → ready_for_doctor`, `completed`/`seen` → `exited`, each applied with `allowSkip: true`.
A patient whom no station screen touches therefore produces three or four events: booked, checked
in, ready for doctor, exited.

**Why it is a problem.** Every duration on the Flow Manager is the gap between consecutive events.
With this mapping the whole consultation, pharmacy and exit period is attributed to
`ready_for_doctor` — whose SLA key is `wait_doctor`, budget 15 minutes. So on real data the
"Waiting — doctor" column will show enormous averages and the bottleneck banner will blame the
doctor wait permanently, whatever is actually happening on the floor. The vitals, SD and pharmacy
columns stay empty, which the plan's DoD lists as the thing Phase 2 exists to fix.

**Recommendation.** Either close the open interval when a jump is detected (write the intermediate
statuses the sync can infer, or mark the event as an observed jump so the engine excludes it from
station averages), or exclude jumped intervals from `getStationAverages` and the bottleneck. As it
stands the board is confidently wrong about the floor's single most important number.

### 🟠 P2-05 · High · P1 — the sync assumes the hospital has exactly one consultation room

```js
SELECT 1 FROM giniflow_visits WHERE visit_date = $1 AND current_status = 'with_doctor' LIMIT 1
```

**Problem.** `consultRoomFree` returns false if _any_ patient anywhere in the hospital is
`with_doctor`. Only one patient can be shown "With doctor" at a time, for the whole day.

**Why it is a problem.** The repo has a `consultant` role, a consultants load board and multiple
active doctors. On a two-consultant day the second patient sits in "Waiting — doctor" while they are
in fact being seen — inflating the same queue P2-04 already inflates, and hiding the second
consultation from the board entirely. The comment explains the bug it is avoiding (one doctor
appearing to see four patients at once) but the fix over-corrects from "per doctor" to "per
hospital".

**Recommendation.** Scope the check to the assigned doctor (`assigned_doctor_id`, or the
appointment's `doctor_id`), not the day.

### 🟠 P2-06 · High · P1 — the station sets `allowSkip`, which the engine forbids

`statusEngine.js` states it plainly: _"`allowSkip` exists for one caller: the HealthRay sync … A
station screen must never set it — a human skipping steps is a mis-tap."_ `saveVitals` and
`startVitals` both pass `allowSkip: true`.

**Why it is a problem.** Beyond the contradiction: the queue auto-selects the head patient without
claiming them, so the common path is a nurse who never taps the card, fills the form and presses
Done — `checked_in → vitals_done` in one jump, skipping `with_vitals`. That is the exact state
Phase 1 invented so the "At vitals" column and the 5-minute vitals budget would have something to
measure. In normal use they will measure nothing, and the board will show an empty At-vitals column
while a nurse is working.

**Recommendation.** Drop `allowSkip` from both station calls and let `saveVitals` claim the patient
(`with_vitals`) first if they are not already there — two events, both true, both timed.

### 🟠 P2-07 · High · P1 — the patient under the nurse's hands can change without them touching anything

`VitalsStationPage.jsx` — `activeVisitId = selected ?? queue[0]?.visitId`

**Problem.** Until the nurse taps a card, the active patient is whoever is first in a queue that
refetches every 15 seconds and is reordered by a sync that runs every 30. Anyone reaching
`with_vitals` — a second nurse claiming a patient, a HealthRay check-in landing — sorts to the head
and becomes the active patient.

**Why it is a problem.** The detail pane and the form reset to the new patient mid-entry: typed
readings are silently discarded. There is a narrow window during which the form still holds the
previous patient's numbers while the header has changed, and the Done button is only unmounted for
part of it. Data loss is the likely outcome; misattribution is the unlikely-but-possible one, and
these are clinical numbers.

**Recommendation.** Pin the active patient on first render (or on first keystroke) and require an
explicit tap to change it; warn before switching away from a dirty form.

### 🟠 P2-08 · High · P1 — a mis-tapped patient cannot be released

**Problem.** Tapping a card calls `startVitals`, moving the patient to `with_vitals`. Backwards
transitions are rejected by design, and the UI has no "not this patient" action.

**Why it is a problem.** On a floor, mis-taps are constant. The patient is now shown at the vitals
station on every screen, their vitals timer runs against a 5-minute budget, and the only way out is
to record a reading for someone who is not there. The board will show them as at vitals until
somebody does.

**Recommendation.** Either claim on first keystroke rather than on tap, or add an explicit release
that logs a corrective event.

### 🟠 P2-09 · High · P1 — the voice processor was never decided, and the default is a new one

`useVoiceVitals.js` names the issue in its own header: live mode uses the browser's recogniser,
which in Chrome means Google; batch mode uses Deepgram, already this app's engine. _"It is a second
processor — worth a deliberate decision before this reaches the floor."_

**Why it is a problem.** Live mode is the default whenever the browser supports it, so the default
path sends clinic-floor audio to a processor that is not in any existing agreement. The utterance is
usually numbers, but a nurse will say a patient's name aloud sooner or later, and this is
DPDP-covered territory the repo takes seriously elsewhere.

**Recommendation.** Take the decision. If Deepgram only, drop live mode or route it through the
existing endpoint. If the browser recogniser is acceptable, record why.

### 🟠 P2-10 · High · P1 — most of Phase 2 is unstarted

Not a defect — a scope statement, listed here because "Phase 2" reads as done in conversation and is
not. See §3 and §8. Nothing in lab, MO/SD, triage, triggers 1–2, the launcher, the allergy strip or
the chain extension exists. The brief's Phase 2 deliverable — "Reception · Vitals · MO/SD · Lab
stations — all writing real `visit_events` · cross-station triggers 1–3 · Triage board" — is about
half met on stations and a third on triggers.

### 🟠 P2-26 · High · P1 — reception collects money against the prototype's price list

`server/migrations/2026-08-31_giniflow_test_catalog.sql`

**Problem.** Nothing in this database has ever held a test price, so the catalogue is new and was
seeded from `gini-stations.html`: HbA1c ₹250, Lipid panel ₹350, and ten more. The migration says so
in capitals and every row carries `source = 'prototype_placeholder'`. But the table is in
production, the screen is routed and in the nav for `reception` and `coordinator`, and it renders
those figures as a rupee total beside a patient's name with a "✓ Payment received" button under it.

Two smaller data problems in the same seed: `Vit D` at ₹900 and `Vitamin D` at ₹1200 are the same
test at two prices, and nothing marks the pair.

**Why it is a problem.** The safeguards are all developer-facing — a migration comment and a column
nobody renders. A receptionist sees a price and collects it. Open question 3 ("new catalogue table
or existing billing data") was answered as "new table"; the half that matters, _whose prices_, is
still open.

**Recommendation.** Replace with the hospital's tariff before the screen is used, or surface
`source` on the screen so a placeholder price is visibly not a tariff. De-duplicate the vitamin D
rows. The design decision to also store price per order line — so a catalogue change cannot
re-price a quoted order — is correct and should stay.

---

## 6. Needs improvement

**🟡 P2-11 · Medium · P2 — "done today" counts readings, not patients.** `getVitalsQueue` counts
`giniflow_vitals` rows for the date. A correction is a new row by design, so correcting one patient
makes the counter read 2. The number is shown twice on screen and is the nurse's only sense of their
own throughput. _Count distinct visits._

**🟡 P2-12 · Medium · P2 — one field is enough to move a patient on.** `canSave` requires only that
something was entered. A patient can be advanced to the MO queue with a weight and nothing else,
and the event meta will carry six nulls. The mockup and the plan both describe seven readings.
_Decide the required set — BP and weight at minimum — and enforce it in the schema, not only the
button._

**🟡 P2-13 · Medium · P2 — the form can reset on window focus.** The global query client sets
`refetchOnWindowFocus: true` and `staleTime: 0`; `useVitalsPatient` does not override it, and the
form-reset effect depends on `patient.recorded`, a fresh object on every refetch. For any patient
who already has a reading (the correction path), clicking away and back re-runs the reset and
discards edits. _Override `staleTime` on the detail query, or depend on a stable key rather than the
object._

**🟡 P2-14 · Medium · P2 — two nurses on two devices have no conflict story.** Nothing claims a
patient exclusively, nothing detects that another device is on the same visit, and both saves
succeed with the last one winning the display. The plan's rollout risk assumed two _systems_; two
devices on the same system is the nearer problem. _At minimum, show who claimed the patient and
when._

**🟡 P2-15 · Medium · P1 — no allergy strip on the one station that shipped.** Task 2.10 is
correctly blocked on the data source, and the plan is right that a blank "None recorded" is worse
than nothing. But the task also warns that retrofitting four screens costs more than adding one
component now, and the first screen has shipped without the slot. `p.notes` is selected in the
vitals query and never used, which suggests the path was started and abandoned. _Decide question 10,
and leave a placed component even while it renders "Allergies not recorded — ask the patient"._

**🟡 P2-16 · Medium · P2 — capability grants drift from the plan, and pre-empt an open question.**
The plan's station table assigns vitals to `nurse`. Shipped: `nurse`, `mo`, `coordinator`. Granting
the coordinator a station desk answers open question 7 ("may the Flow Manager act at a station, or
only view?") without the question being closed — and the plan notes that if they may act, the event
must record _their_ identity, which it does, so the behaviour is right and the decision is
undocumented. The other seven capabilities the task asks to declare now were not declared. _Close
question 7; declare the rest so the launcher and matrix are designed once._

**🟡 P2-17 · Medium · P2 — the parser understands digits only, in a clinic that speaks Hindi and
Punjabi.** "weight seventy two" fills nothing, and the smoke suite asserts that as correct
behaviour. `vajan` is accepted as a keyword but no Hindi numerals are. A nurse speaking naturally
gets an empty form and a "no readings recognised" note. That is safe, and it may also mean the
feature goes unused. _Either add spoken-number handling for the common range, or make the prompt on
screen teach the exact phrasing that works._

**🟡 P2-18 · Medium · P2 — accessibility of the new screen.** Queue items are proper buttons (good).
Missing: `aria-invalid` on out-of-range fields, an `aria-live` region for the caption (the whole
point of which is live feedback), an announcement for the toast, and a programmatic association
between each input and its `vf-lbl` div — the labels are divs, not `<label>` elements, so a screen
reader reads seven unlabelled number boxes. _Use real labels; announce the caption._

**🟡 P2-19 · Medium · P2 — responsiveness is one breakpoint and an unanswered question.** The
station CSS has a single `@media (max-width: 820px)`. Open question 14 asks which stations must work
below 1024px and names vitals as the one with a real tablet case; it is unanswered, so nobody knows
whether 820px is the right number or whether the target device is a 10-inch tablet in landscape.
_Answer the question, then verify on the actual hardware._

**🟡 P2-27 · Medium · P2 — a cleared payment cannot be corrected.** `clearPayment` is correctly
idempotent — a double-tap returns `alreadySettled` rather than writing a second payment event, and
the comment explains why. But there is no reversal: an order cleared against the wrong patient stays
cleared, the lab has already been notified in the same transaction, and the only record of the
mistake is the event that says it was right. On a counter that handles cash this will happen.
_Add a reversal that appends a compensating event rather than editing the original._

**🟡 P2-20 · Medium · P2 — the visit number counts only `completed` appointments.** The Phase 1 fix
now counts prior appointments with `status = 'completed'`, but the repo also uses `seen` as a
terminal status (`healthraySync.js` treats both as done). A patient whose history is recorded as
`seen` reads one visit short. _Count both._

---

## 7. Needs design / UX

| Area                              | What needs designing                                                  | States and interactions to cover                                                                                                             |
| --------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **MO/SD station**                 | The whole screen (task 2.0b) — still the phase's biggest hole         | Queue filtered to the logged-in SD · patient brief · plan textarea · Ready for doctor · Order tests · Close (green only) · propose Rx change |
| **Station launcher**              | Tiles per station with live counts (task 2.0)                         | Which stations show for which role · counts · what a role with no station sees                                                               |
| **Allergy strip**                 | The component _and_ its empty state (2.10)                            | Recorded · not recorded · not yet asked. Never a blank "None"                                                                                |
| **Patient claim / release**       | Not in any prototype — surfaced by P2-08                              | Claimed by me · claimed by another device · release · claim expiry                                                                           |
| **Voice, failure paths**          | Prototype shows the happy path only                                   | No microphone · permission refused · nothing heard · partially heard · a rejected mishearing · non-captioning browser                        |
| **Correction of a saved reading** | The station allows corrections; nothing shows a reading was corrected | Original vs. correction · who and when · whether the doctor sees both                                                                        |
| **Vitals vs HealthRay conflict**  | Open question 11 — which reading wins when both exist                 | Station reading present · HealthRay reading present · both, differing · how the difference is shown                                          |
| **Triage board**                  | Built to spec but not started — the densest spec in the folder        | Five columns · auto-category with visible override · pipeline bar · biomarker chips · doctor pills · report upload                           |

---

## 8. Missing features

| Missing                                                     | Requirement | Consequence                                                          | Pri |
| ----------------------------------------------------------- | ----------- | -------------------------------------------------------------------- | --- |
| Lab station + server-side payment gate                      | 2.5         | Named in the DoD; lab track on the board has no writer               | P1  |
| MO/SD station + its mockup                                  | 2.7 / 2.0b  | The `ready_for_doctor` queue never forms from real work              | P1  |
| Triage board + rule engine + override model                 | 2.8         | Categories on the board stay whatever the sync guesses               | P1  |
| Cross-station triggers 1 and 2                              | 2.9         | Lab and MO/SD hand-offs; trigger 3 is built                          | P1  |
| Real hospital price list                                    | 2.4 / Q3    | Reception collects against prototype figures (P2-26)                 | P1  |
| Payment reversal / correction path                          | 2.4         | A wrongly cleared order cannot be undone (P2-27)                     | P2  |
| Status chain extension to the triage 16                     | 2.2         | `billing` and the confirmation statuses get harder to add later      | P1  |
| `giniflow_rx_proposals`, `giniflow_triage`, `system_config` | 2.2         | Addendum ③ and the triage board have nowhere to write                | P1  |
| Allergy strip                                               | 2.10        | Retrofit cost across four screens                                    | P1  |
| Station launcher                                            | 2.0         | No landing surface per role                                          | P2  |
| Seven remaining station capabilities                        | 2.11        | Matrix and launcher will be designed twice                           | P2  |
| `smoke:giniflow-stations` chain walk                        | 2.12        | No test that a patient can be walked end to end                      | P1  |
| `smoke:giniflow-triage`                                     | 2.12        | —                                                                    | P1  |
| Import guard (no `flow/` imports under giniflow)            | 2.12        | The most likely way the separation quietly ends is unchecked         | P2  |
| HTTP/RBAC test for the station routes                       | 2.12 / 2.11 | The 403 path for a role without the station capability is unverified | P1  |
| Vitals → `vitals` promotion                                 | 2.6 / DoD   | See P2-01                                                            | P0  |
| Task 2.1 reuse audit                                        | 2.1         | Small; risk of rebuilding the engine per screen                      | P3  |

---

## 9. Functional issues / bugs

| ID    | Issue                                          | Scenario                                                                                                                     | Sev |
| ----- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --- |
| P2-01 | Station vitals never reach `vitals`            | Nurse records BP; doctor opens the patient and sees the old HealthRay reading or nothing                                     | 🔴  |
| P2-02 | Two live vitals desks, different tables        | Two nurses record the same patient into two systems; neither reliably reaches the doctor                                     | 🔴  |
| P2-04 | HealthRay jumps collapse the chain             | Any patient no station touches: `checked_in → exited`, and the entire visit is charged to the doctor-wait budget             | 🟠  |
| P2-05 | One consultation room assumed for the hospital | Two consultants seeing patients: only the first shows "With doctor"; the second sits in the waiting column                   | 🟠  |
| P2-06 | Station skips `with_vitals`                    | Nurse fills the auto-selected patient's form without tapping the card: the At-vitals column stays empty while they work      | 🟠  |
| P2-07 | Active patient changes underneath the nurse    | Another patient reaches `with_vitals` while readings are being typed: the form resets, the entries are lost                  | 🟠  |
| P2-08 | Mis-tap is unrecoverable                       | Nurse taps the wrong card: that patient shows at vitals, timing against a 5-minute budget, with no way back                  | 🟠  |
| P2-11 | "Done today" over-counts                       | One corrected reading makes the counter read 2 for one patient                                                               | 🟡  |
| P2-12 | A single field advances the patient            | Weight only, no BP: patient moves to the MO queue with an almost-empty reading                                               | 🟡  |
| P2-13 | Form resets on window focus (correction path)  | Nurse editing a saved reading alt-tabs and returns: edits gone                                                               | 🟡  |
| P2-14 | Concurrent nurses, last write wins             | Two devices on one patient: two rows, one displayed, no warning                                                              | 🟡  |
| P2-21 | Auto-advance picks from a stale queue          | After Done, `queue.find(...)` runs against the pre-save queue and can select a patient who has just been completed elsewhere | 🔵  |
| P2-22 | `onend` reads a stale `caption`                | Live mode with no final result: the fallback transcript is one render behind                                                 | 🔵  |
| P2-23 | Tautological smoke assertion                   | `check("real readings survive", realKept.c >= 0)` is always true — it asserts nothing                                        | 🔵  |
| P2-24 | Station smoke cleans today's demo rows         | `cleanDemoDay()` with no argument runs before the test day is seeded; harmless today, surprising later                       | 🔵  |
| P2-25 | Hard link out of the SPA                       | "← Board" is a plain `href`, forcing a full reload of a screen staff keep open all day                                       | 🔵  |

---

## 10. Requirement gaps

| Gap type                               | Instance                                                                                                                                                          |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Requirement exists, no task done       | Brief §5 names four stations, the triggers and the triage board as Phase 2. One station exists.                                                                   |
| Plan states a rule, code inverts it    | DoD "the vitals station writes to `vitals`; no second copy exists" vs. `giniflow_vitals` (P2-01/03).                                                              |
| Engine states a rule, caller breaks it | `allowSkip` "a station screen must never set it" vs. both station calls (P2-06).                                                                                  |
| Backend exists, no UI                  | `giniflow_lab_orders` + lab order events (Phase 1) still have no lab screen; `resume_status`/blocked recovery has no UI anywhere.                                 |
| UI exists, no backend                  | None found in Phase 2 — the station is complete on both sides.                                                                                                    |
| Works for one role, not another        | `mo` and `coordinator` hold the vitals capability but the screen is designed for a nurse's workflow (queue → form → next); no role-specific difference.           |
| Happy path only                        | No seeded scenario for: an empty queue at the start of day, a patient already recorded by HealthRay, two nurses, a correction, a blocked patient reaching vitals. |
| Decision recorded, never taken         | Questions 1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 13, 14, 15 — thirteen of the fifteen are still open; two of them (2, 10) are marked in the plan as blocking.            |
| Question closed by code                | Question 12 (P2-03), and question 7 implicitly by the coordinator grant (P2-16).                                                                                  |

---

## 11. Role & permission gaps

| Role        | Vitals station | Board | Plan says               | Assessment                                                           |
| ----------- | -------------- | ----- | ----------------------- | -------------------------------------------------------------------- |
| admin       | ✅ (ALL)       | ✅    | —                       | Correct                                                              |
| nurse       | ✅             | ✅    | vitals station          | Correct — the intended operator                                      |
| mo          | ✅             | ✅    | MO/SD station           | ⚠️ Not in the plan's table. Harmless, undocumented                   |
| coordinator | ✅             | ✅    | Flow Manager (+ triage) | ⚠️ Answers open question 7 by granting; event records their identity |
| consultant  | —              | ✅    | doctor station (Ph. 3)  | Correct for now                                                      |
| lab         | —              | ✅    | lab station             | Correct — capability not yet declared                                |
| reception   | —              | ✅    | reception station       | Correct — capability not yet declared                                |
| pharmacy    | —              | ✅    | pharmacy (Ph. 4)        | Correct                                                              |
| tech        | —              | —     | lab station             | ⚠️ Plan pairs `tech` with `lab`; tech has no Gini Flow access at all |
| obt, guest  | —              | —     | —                       | Correct                                                              |

Mechanically the wiring is right: capability declared in `shared/permissions.js`, route-prefix entry
ordered before the broader `/api/giniflow` rule so it resolves correctly, `requireCapability` on
every station route, page capability, lazy route, nav entry — all in one change, as the repo
requires. What is missing is the _test_: no HTTP smoke asserts that a `pharmacy` user (who holds
`GINIFLOW_VIEW` and passes the prefix rule) is refused at the station route. That is the one case the
two-layer design could get wrong.

---

## 12. End-to-end workflow

**Intended:** triage → confirm → check-in → vitals → MO/SD → (lab / reception payment) → doctor →
pharmacy → exit.

| Step                    | State                                                                                                 |
| ----------------------- | ----------------------------------------------------------------------------------------------------- |
| Triage                  | ❌ Not built. Categories on the board are whatever the seeder or sync set                             |
| Confirmation (OBT)      | ❌ Statuses not in the chain (question 2)                                                             |
| Check-in                | ✅ Real — via HealthRay sync. No walk-in path (reception station missing)                             |
| **Vitals**              | 🟡 **Works** — but writes to a table the doctor does not read (P2-01) and usually skips `with_vitals` |
| MO/SD                   | ❌ Not built. Nothing produces `ready_for_doctor` except a HealthRay jump                             |
| Order tests → reception | ❌ Trigger 2 not built                                                                                |
| Payment → lab           | ❌ Trigger 3 not built                                                                                |
| Lab upload → results    | ❌ Trigger 1 not built                                                                                |
| Doctor                  | Phase 3                                                                                               |
| Pharmacy / exit         | ❌ Reached only by the sync jumping to `exited`                                                       |

**The chain cannot be walked.** A patient can be checked in by the sync and have vitals recorded,
then stops: nothing in Gini Flow can move them from `vitals_done` to `ready_for_doctor` except
HealthRay reporting `in_visit`, at which point the sync jumps them past the SD step entirely. The
plan's first DoD item — two browsers, two roles, one patient walked through — is not achievable.

---

## 13. Edge cases

| Scenario                                      | Handled | Notes                                                                                       |
| --------------------------------------------- | ------- | ------------------------------------------------------------------------------------------- |
| Empty queue                                   | ✅      | "Nobody waiting for vitals right now."                                                      |
| Patient already has a reading                 | ✅      | Form pre-fills; correction saves a new row and does not walk them back                      |
| No previous vitals                            | ✅      | "No previous vitals on record for this patient."                                            |
| Partial reading                               | ⚠️      | Allowed — arguably too permissive (P2-12)                                                   |
| Out-of-range typed value                      | ✅      | Marked inline, save blocked, message says why                                               |
| Out-of-range spoken value                     | ✅      | Rejected and reported as a mishearing — the best-handled case in the phase                  |
| Microphone refused / absent                   | ✅      | Distinct messages, form still usable                                                        |
| Browser without SpeechRecognition             | ✅      | Falls back to Deepgram and says there will be no caption                                    |
| Unknown visit id                              | ✅      | 404 from the service, asserted                                                              |
| Blocked patient                               | ✅      | Excluded from the queue and from the sync                                                   |
| Two appointments for one patient in a day     | ✅      | `DISTINCT ON` with a status ranking — the oscillation bug is fixed and documented           |
| Patient advanced past HealthRay's knowledge   | ✅      | Never moved backwards                                                                       |
| No-show who turns up late                     | ✅      | Exception states are recoverable, with `resume_status`                                      |
| **Mis-tapped patient**                        | ❌      | No release (P2-08)                                                                          |
| **Queue reorders mid-entry**                  | ❌      | Form resets, entries lost (P2-07)                                                           |
| **Two nurses, one patient**                   | ❌      | No claim, no warning (P2-14)                                                                |
| **Window refocus while editing a correction** | ❌      | Refetch resets the form (P2-13)                                                             |
| Save fails (network)                          | 🟡      | Toast shows the server message; the form keeps its values, but there is no retry affordance |
| Session expires on an all-day station screen  | ❌      | Not handled here; same gap as the board                                                     |
| Day rollover with the screen open             | ❌      | Query key is the string "today"; the queue silently becomes tomorrow's                      |
| Very long patient name in the queue           | 🔵      | Not clamped in the queue item                                                               |
| Tablet / small screen                         | 🟡      | One breakpoint, no decision behind it (P2-19)                                               |

---

## 14. Technical / architecture concerns

**Sound:**

- The station is a thin route over a service, per the repo's rule; the route file carries no domain
  logic.
- `saveVitals` opens its own transaction and passes the client into `advanceStatus`, so the reading,
  the status change and the event commit or fail together.
- `FOR UPDATE` on the visit row in both `saveVitals` and `startVitals` serialises two devices at the
  database rather than hoping.
- The parser lives in `shared/`, dependency-free, imported by the client and testable by a Node
  script with no database — the right home, and the smoke suite is a pure function test as a result.
- The sync is in the worker, not the API, consistent with the architecture's reason for splitting
  them.

**Concerns:**

- **The 30-second sync loop writes to production continuously.** It is well guarded (watchdog,
  unchanged-row skip, per-appointment transaction with rollback) but it is now the main writer of
  `giniflow_visits`, and its status mapping determines every number on the board (P2-04). It
  deserves the same scrutiny as a station.
- **`giniflow_vitals` mirrors `vitals` column-for-column** so that promotion is "a straight copy".
  That is good foresight and also a standing invitation to divergence: `vitals` has `waist`,
  `source`, `appointment_id`, `consultation_id`; the copy has `source` and `meta`. A promotion
  written later will have to decide what to do about the difference.
- **No `updated_at`/audit on `giniflow_vitals`** — corrections are new rows (good), but nothing
  records _why_ a correction was made or links it to the row it corrects.
- **The queue and detail are two queries per patient selection**, with the detail issuing three
  statements (visit, last vitals, current reading). At one nurse this is nothing; it is worth
  knowing before four stations poll simultaneously.
- **Question 13 (theme drift) is unanswered** and `giniflow-station.css` is a third stylesheet
  alongside `giniflow-theme.css` and `giniflow.css`. Worth confirming it imports the tokens rather
  than redefining them before two more station screens land.

---

## 15. QA / testing gaps

| Area                     | State                | Missing                                                                                   |
| ------------------------ | -------------------- | ----------------------------------------------------------------------------------------- |
| Voice parser             | 🟢 Ready             | Nothing — 18 cases including the dangerous ones                                           |
| Vitals service           | 🟠 Needs testing     | Concurrency (two saves on one visit), the skip path, save-without-claim, blocked patients |
| Vitals UI                | 🟠 Needs testing     | Render smoke only. No test of the reset race (P2-07), the claim (P2-08) or voice fill     |
| Station RBAC             | 🔴 Not ready         | No HTTP test; the `GINIFLOW_VIEW`-but-not-station case is exactly what could regress      |
| Appointment sync         | 🟡 Needs improvement | `smoke:giniflow-sync` exists; add multi-consultant (P2-05) and jump-collapse (P2-04)      |
| Cross-station chain walk | 🔴 Not ready         | `smoke:giniflow-stations` does not exist — task 2.12                                      |
| Import guard             | 🔴 Not ready         | Not written — task 2.12                                                                   |
| Isolation from `flow_*`  | 🟢 Ready             | Asserted, and extended to `vitals`                                                        |
| Live floor verification  | 🔴 Not ready         | The station has not been used with a real patient by a real nurse                         |

The Phase 1 lesson repeats: the strongest testing is on the pure functions, and the weakest is on
the screen a human actually touches.

---

## 16. Security / performance

**Security**

- 🟠 **Voice processor undecided (P2-09)** — the default path sends clinic audio to the browser's
  recogniser. DPDP-relevant; flagged in the code, undecided in the project.
- 🟠 **Clinical data written where clinicians cannot see it (P2-01)** — a data-integrity problem as
  much as a workflow one: the patient's record is now incomplete in a way nothing surfaces.
- 🟡 **Station capability granted to three roles**, two of which the plan did not name (P2-16).
- 🟢 Every query parameterised; every route capability-gated; Zod validation on the save body with
  clinically meaningful bounds; blocked patients excluded from the queue and the sync.
- 🟢 The bounds are enforced server-side, not only in the form — a spoofed request cannot store a
  weight of 900 kg.

**Performance**

- 🟢 The queue polls at 15s (slower than the board's 10s — appropriate) with
  `refetchIntervalInBackground: false`.
- 🟢 The sync skips transactions for unchanged rows, with the measured reason recorded.
- 🟡 The detail pane issues three statements per patient selection and refetches on window focus
  (P2-13).
- 🟡 The sync runs every 30 seconds against the production pooler all day; combined with the board's
  polling and, later, four station screens, the aggregate connection load is worth measuring before
  Phase 2 finishes rather than after.

---

## 17. Priority action items

### 🔴 Critical / P0

- **P2-01** Promote station readings into `vitals` inside the existing save transaction — or take
  the station out of the nav until it does.
- **P2-03** Take the question-12 decision explicitly and make the plan and the code agree; whichever
  way it goes, one of them is currently wrong.
- **P2-02** Decide which vitals desk is live for which staff, remove the other from that role's nav,
  and tell the named people before the screen is used on a patient.

### 🟠 High / P1

- **P2-04** Stop HealthRay jumps from charging a whole visit to one station's budget.
- **P2-05** Scope `consultRoomFree` to the doctor, not the hospital.
- **P2-06** Drop `allowSkip` from the station calls; claim `with_vitals` on save when it is not set.
- **P2-07** Pin the active patient; warn before switching away from a dirty form.
- **P2-08** Add a release action, or claim on first keystroke instead of on tap.
- **P2-09** Decide the voice processor.
- **P2-15** Decide the allergy source (question 10) and place the component.
- **2.0b** Decide who draws the MO/SD mockup — it has blocked the most important station since the
  phase began.
- **2.2** Settle the status chain (question 2) before more screens write statuses.
- **2.12** Add the station HTTP/RBAC test and the chain-walk smoke.

### 🟡 Medium / P2

- **P2-11** Count distinct patients in "done today".
- **P2-12** Define and enforce the required reading set.
- **P2-13** Override `staleTime` on the detail query, or stabilise the reset dependency.
- **P2-14** Show who has claimed a patient.
- **P2-16** Close question 7; declare the remaining station capabilities.
- **P2-17** Spoken numbers, or teach the working phrasing on screen.
- **P2-18** Real `<label>` elements, `aria-invalid`, an `aria-live` caption.
- **P2-19** Answer question 14 and verify on the target tablet.
- **P2-20** Count `seen` as well as `completed` in the visit number.
- Handle day rollover and session expiry on the station screen.
- Confirm `giniflow-station.css` consumes the shared tokens (question 13).
- Write the import guard (2.12).

### 🔵 Low / P3

- **P2-21** Auto-advance from the post-save queue, not the stale one.
- **P2-22** Use the ref, not the closure, for the fallback transcript.
- **P2-23** Replace the tautological smoke assertion with a real one.
- **P2-24** Scope the pre-seed `cleanDemoDay()` to the test day.
- **P2-25** Route the "← Board" link through the router.
- Write the 2.1 reuse audit table.

---

## 18. Pre-release checklist — Phase 2

- [ ] **P0** A reading taken at the station appears in the doctor's consult view for that patient
- [ ] **P0** The plan's DoD and the code agree on where vitals are written
- [ ] **P0** One vitals desk is live per person, and those people have been told which
- [ ] **P1** A patient can be walked check-in → vitals → SD → tests → payment → sample → upload from
      two browsers in two roles
- [ ] **P1** Real HealthRay-driven visits produce per-station timings, not one collapsed interval
- [ ] **P1** Two consultants seeing patients both show as "With doctor"
- [ ] **P1** The At-vitals column populates while a nurse is working
- [ ] **P1** A mis-tapped patient can be released
- [ ] **P1** Typed readings survive a queue refresh
- [ ] **P1** The voice processor is decided and recorded
- [ ] **P1** Allergy source decided; the strip placed on every station screen
- [ ] **P1** Lab cannot collect before payment — enforced and tested server-side
- [ ] **P1** `smoke:giniflow-stations`, the station RBAC test and the import guard all pass
- [ ] **P2** A nurse has used the screen with a real patient and said what is wrong with it
- [ ] **P2** Required reading set defined and enforced
- [ ] **P2** Screen verified on the actual station tablet
- [ ] **P2** Day rollover and session expiry handled on an all-day screen
- [ ] **—** `format:check`, `verify-rbac`, and every Gini Flow smoke suite green; `flow_*` and
      `vitals` untouched by any of them

---

## 19. Final verdict

**Needs improvement — one good station, built on a seam that is wired the wrong way.**

The two things that shipped are both better than average work. The appointment sync quietly solved
the problem Phase 1 could not — real patients on the board — and its comments carry real
floor-earned knowledge. The voice parser is the right design decided for the right reason and tested
against the failure that matters, which is a number landing in the wrong field.

What has to be fixed before anything else is a single decision and its consequence: the vitals
station writes to a table the doctor does not read, the plan says it should not, and the question
that was supposed to settle it was answered inside the migration that broke it. Everything else on
the P0 list follows from that, including the two-desks rollout problem the plan predicted in
writing.

After that, the honest position on scope: Phase 2 is a quarter done. Reception, lab, MO/SD, the
triage board and the three triggers — the parts that make the flow a flow — are all unstarted, and
two of them are blocked on decisions (the MO/SD mockup, the status chain) that have been open since
the phase was planned. The next unit of work is not more code; it is closing questions 1, 2, 10 and 12.
