# MO / SD Station — full plan

**The one Phase 2 station with no mockup.** Brief §1.2 claims `gini-flow-v2.html` specifies it; it
does not — that file's five screens are launcher, Flow Coordinator, Vitals, **Doctor**, Pharmacy.
So this plan derives the screen from what _is_ specified, and says which prototype each element
comes from.

**Sources**

| Source                                | What it gives                                                               |
| ------------------------------------- | --------------------------------------------------------------------------- |
| `Gini-Flow-Developer-Brief.docx` §4.3 | the three actions and the queue — the only written spec                     |
| §2.2, §2.3                            | the chain, and triggers 2 and 3                                             |
| `gini-doctor-v3.html` `s-list`        | **the queue design** — grouped list, journey rail, key numbers, elapsed     |
| `gini-doctor-final.html` `s-tests`    | **the test-ordering panel** — urgency, quick panels, individual tests       |
| `gini-doctor-final.html` `s-overview` | the patient-brief layout an MO reads before writing a plan                  |
| `gini-stations.html`                  | station chrome: rail, counters, `.pt-card`, detail pane                     |
| `gini-flow-v2.html` `s-vitals`        | the two-pane station layout Gini Flow stations already use                  |
| `gini-addendum-mockup.html`           | change ③ — the MO **proposes** prescription changes; change ④ allergy strip |

**Deliberately not copied:** `gini-doctor-view.html` and `gini-doctor-v2.html` are marked
_"Superseded — ignore"_ in the brief §1.2. They were read for context; nothing is taken from them
that v3 or final does not also carry.

**Why this station matters most:** it is where the queue forms. The Flow Manager's whole reason
for existing is the "waiting for doctor" bottleneck, and that bottleneck is created here — by how
quickly an MO works up a patient and whether they close a green one instead of passing them on.

---

## 1. What the brief actually specifies

§4.3, in full:

> **MO/SD:** queue of `sd_pending` for the logged-in SD; patient brief; plan textarea; buttons:
> 'Ready for Dr. Bhansali' (→ `ready_for_doctor`), 'Order tests' (creates `lab_order`), 'Close'
> (green-category only → `doctor_done`, skipping the doctor).

Four elements — queue, brief, plan, three buttons — and one hard rule: **Close is green-category
only.**

Everything else in this plan is design derived from the prototypes to make those four work.

---

## 2. Screen design

Two panes, as vitals already does (`gini-flow-v2.html` `s-vitals`): queue left, work right. The
queue borrows its grouping and journey rail from `gini-doctor-v3.html` `s-list`, because an MO and
a doctor are looking at the same question — _who is ready for me, and who is stuck?_

### 2.1 Rail

`.rail` navy: **MO / SD Station** · divider · the SD's own name (`Dr. Beant Sidhu`) and date ·
right: **← Stations**.

### 2.2 Counters (`.stats`)

From `gini-doctor-v3.html`'s list header, cut to what an MO owns:

| Count              | Sub-label         | Colour |
| ------------------ | ----------------- | ------ |
| With me now        | in workup         | teal   |
| Waiting for me     | vitals done       | red    |
| Results ready      | can proceed       | green  |
| Waiting on results | can't proceed yet | amber  |
| Closed by me       | today             | ink    |

### 2.3 Queue (left pane, `.squeue`)

Grouped exactly as the doctor list groups, with the MO's own names:

```
🟢 With me now            — status with_sd, this SD
⏳ Waiting for me         — vitals_done / sd_pending, assigned to this SD or unassigned
🔵 In pipeline            — checked in but vitals not done yet (v2's wording)
🔴 Missing reports        — no reports at all: cannot be categorised, cannot proceed
✅ Closed / passed on     — doctor_done or ready_for_doctor, by me, today
```

**Five groups, not four.** Both `gini-doctor-v2.html` and `v3` separate two states this plan
originally merged:

- **"Waiting on results"** — tests ordered, results pending. The patient is progressing.
- **"Missing reports — can't categorise"** — nothing to work from at all. v2 counts it separately
  (`1 Missing reports · can't categorise`) because it needs a different action: chase the reports
  or send a phlebotomist, not wait.

Merging them hides the only group an MO can actually unblock.

Each row (`.sq-item`, as vitals):

- slot: **Now** / **Next** / appointment time
- name, `44F · P_11822 · Visit 4`, category dot with its label
- **journey rail** — `Check-in ✓ › Vitals ✓ › MO › Doctor › Pharmacy` (`.steps` from
  `gini-stations.html`), current step highlighted
- **key numbers** — `HbA1c 7.4`, `BP 148/94` as `.sbio` chips, coloured against threshold
- **elapsed** — minutes since they entered this queue, amber/red against the `wait_sd` budget
- **reports line** — `✓ Reports complete` · `✓ Gini Lab received` · `🔵 No reports`, exactly as
  v2 and v3 render it. This is the field that decides whether the MO can do anything at all, so it
  belongs on the row, not only in the detail pane.
- **compliance** — `74% compliance` (v2). Source is `appointments.pre_visit_compliance`
  (`{pct, notes}`); it exists but is unpopulated today, so render it only when present.

### 2.4 Patient brief (right pane, top)

The MO writes a plan; the brief is what they read first. From `gini-doctor-final.html`
`s-overview`, cut to what is available before a consultation:

1. **Allergy strip** — red, full width, first thing on the screen (addendum ④). Blocked until
   there is a data source — see §7.
2. **Header** — name in Instrument Serif, `50M · P_177562 · Visit 5 · Phase 1 · Checked in 09:12`,
   category badge.
3. **Vitals just taken** — the reading from the vitals station, with the last-visit comparison
   already computed there.
4. **Key biomarkers** — `HbA1c 7.3 ↑`, `FBS 70`, `BP 138/93`, `Weight 53.6` as tiles, each with
   its previous value and a trend arrow (`appointments.biomarkers`, already populated on 115 of
   today's appointments). Every doctor prototype makes these **clickable for a trend graph**
   ("Tap to see trend →"); `recharts` is already a dependency. Phase 2 may ship them static, but
   the tile should be a button from the start so the graph is an addition, not a rebuild.
5. **Diagnoses and active medicines** — read-only list.
6. **Today's concerns** — `gini-doctor-view.html` structures this as **three sources**, not one,
   and the MO needs all three before writing a plan:
   - **🧪 From reports** — derived, not typed: _"Triglycerides tripled — 131 → 368 mg/dL. No
     statin dose change. Review lipid management urgently."_ Each carries a severity
     (🔴 / 🟡 / ✅).
   - **💬 Patient reported** — MHG pre-visit check-in: complaints, questions, and explicit
     negatives (_"No hypoglycaemia episodes. No foot complaints."_).
   - **Between visits** — anything logged since the last consultation.

   Above them, a computed one-line summary: **`✓ 4 in control · ↑ 1 worse · ⚠ 2 watch`**, each
   naming its markers. That line is what an MO reads in three seconds; the detail is what they
   read if it looks wrong.

7. **External medicines** — the addendum has the MO proposing dose changes, and a proposal made
   without sight of what another doctor prescribed is unsafe. `gini-doctor-final.html` `s-ext`
   shows these with prescriber, hospital and an **interaction flag** ("dual RAAS block with Telma
   AM"). **No `external_medicines` table exists** — brief §3 specifies one for Phase 3. Until it
   does, the proposal UI must say the list is Gini medicines only rather than implying it is
   complete.

### 2.5 Plan (right pane, middle)

- A textarea, autosaving as a draft against the visit.
- **Voice dictation** — the same `useVoiceVitals` pattern, but free text rather than a parser:
  transcript straight into the textarea, nurse edits. Reuses `/api/ai/transcribe`.
- **Prescription proposals** (addendum ③): rows of `medicine · from → to · reason`, e.g.
  _Atchol 20mg → 40mg, LDL 127_. The MO proposes; the doctor approves, adjusts or rejects in
  Phase 3.

### 2.6 Tests panel

Lifted from `gini-doctor-final.html` `s-tests`, which is fully specified:

- **Urgency, chosen first** — `Today → lab now` · `Tomorrow → reception` ·
  `Next visit · Nov 2026`. This drives which queues the order lands in (and is the field the lab
  and reception now filter on).
- **Quick panels** — Diabetes (4), Lipid (4), Kidney (4), Thyroid (3), Cardiac (3), Full workup
  (18). One tap selects every test in the panel.
- **Individual tests** — chips with a one-line gloss (`UACR — Albumin ratio`,
  `Vit B12 — Metformin depletes`).
- **Footer** — `N tests selected`, the destination in words, and **Confirm →**.

### 2.7 Action bar (right pane, bottom — always visible)

Three buttons, in the brief's order, with the state each writes:

| Button                       | Writes                            | Enabled when                                      |
| ---------------------------- | --------------------------------- | ------------------------------------------------- |
| **Ready for Dr. Bhansali**   | `ready_for_doctor`                | always, once a plan exists                        |
| **Order tests**              | `giniflow_lab_orders` + trigger 2 | tests selected                                    |
| **Close — no doctor needed** | `doctor_done`                     | **`category = in_control` only**, server-enforced |

Close carries a confirmation naming the rule: _"Closing sends this patient straight to pharmacy
without the doctor. Only for green-category patients."_

---

## 3. Flow, step by step

```
Vitals presses Done →  vitals_done
      │
      ▼  (assignment: visit.assigned_sd_id, or unassigned → any SD may pick up)
MO/SD queue: "Waiting for me"
      │  MO taps the row      → with_sd        (station occupied, board shows it)
      ▼
Patient brief read · plan written (autosaved draft)
      │
      ├─ Order tests ──► giniflow_lab_orders (urgency, payment_status = pending)
      │                   └─► trigger 2: reception sees a payment card
      │                        └─► reception clears → trigger 3: lab sees "collect now"
      │                             └─► lab uploads → trigger 1: results_status = ready
      │                                  └─► this patient returns to the queue, green
      │
      ├─ Ready for Dr. Bhansali ──► ready_for_doctor   (the doctor's queue; the bottleneck)
      │
      └─ Close (green only) ──────► doctor_done → pharmacy_pending
```

**The loop that matters:** ordering tests does not end the MO's involvement. The patient leaves
the queue, results arrive, and they come back — which is why "Waiting on results" is a group in
its own right and not an absence.

---

## 3b. Gaps found reviewing this plan against the prototypes

Four things the doctor screens imply that the first draft of this plan did not account for.

### 3b.1 "Phase" appears on every screen and has no data source

Every doctor prototype labels the patient **`Phase 1 · Uncontrolled`**, **`Phase 2 Stabilize`**,
**`Phase 3 Sustain`** — in the header, in the queue rows, and in the vitals station. It is plainly
a core clinical concept at this hospital.

**There is no phase column anywhere in the database.** Nothing named phase, stage or tier.

So either it is derived (from HbA1c and time with Gini — Phase 1 uncontrolled, 2 stabilising,
3 sustaining), or it is a field nobody has built yet. This plan puts "Phase 1" in the patient
header on the strength of the prototypes; **that header cannot be built until this is answered.**
Do not invent a derivation — a wrong phase mislabels how aggressively a patient is being managed.

### 3b.2 Nothing shows the doctor what the MO wrote

The doctor screens render **`MO ✓`** in the journey rail — a tick, and nothing else. No screen in
any of the four prototypes displays the MO's plan text, their proposals, or their reasoning.

This is a hole in the specification rather than in this plan: the MO/SD station's entire output is
a plan the next person never sees. Before building 2.7f, decide where it surfaces in Phase 3 — a
section in the consult overview, a collapsible under Concerns, or the timeline. Otherwise the MO
writes into a void and the hand-off the whole chain exists to support does not happen.

### 3b.3 Draft is an explicit action in the doctor screens

`gini-doctor-view.html`, `-v2` and `-v3` all carry **`Draft`** and **`Save & New`** beside
Finalize. This plan specifies autosave instead.

Autosave is better for a station screen — an MO interrupted mid-workup should not lose a plan
because they never pressed a button — but the two are not equivalent: an explicit Draft says _"I
am not finished"_, which autosave cannot express. Recommendation: keep autosave, and let **Ready
for Dr. Bhansali** be the only explicit "I am finished" signal. Recorded so the divergence from
the prototypes is a decision rather than an oversight.

### 3b.4 Voice is a screen-level tool, not a textarea feature

Every doctor prototype puts **🎤 Voice AI** in the top rail beside the patient's name — it
dictates into whichever section is open — and `s-rx` adds its own "🎤 Voice edit" and "🎤 Dictate".
This plan scoped voice to the plan textarea only.

For a first build that is probably right, since the plan is the only free text on the screen. But
the rail placement is what the prototypes teach, and the proposals section will want it too.

---

## 4. Data model

### 4.1 New

```sql
-- The MO's working notes for a visit. One row per visit, updated in place: a
-- draft is not history, and the plan that matters is the one at hand-off.
giniflow_sd_notes (
  id uuid pk,
  visit_id uuid fk → giniflow_visits unique,
  plan text,
  authored_by int fk → doctors,
  source text default 'typed',        -- typed | voice
  updated_at timestamptz
)

-- Addendum change ③ — the MO proposes, the doctor disposes.
giniflow_rx_proposals (
  id uuid pk,
  visit_id uuid fk → giniflow_visits,
  medicine_name text not null,
  from_dose text,
  to_dose text,
  reason text,                        -- "LDL 127, target <100"
  change_type text,                   -- continued | changed | new | stopped | paused
  proposed_by int fk → doctors,
  status text default 'proposed',     -- proposed | approved | adjusted | rejected
  decided_by int fk → doctors,
  decided_at timestamptz,
  created_at timestamptz
)

-- The panels behind the tests screen. Data, not code: the hospital adds panels
-- without a deploy, and the same table answers "what is in the kidney panel".
giniflow_test_panels (
  id uuid pk,
  panel_key text unique,              -- diabetes | lipid | kidney | thyroid | cardiac | full
  label text, icon text,
  test_names text[],
  display_order int
)
```

### 4.2 Adjustments to what exists

| Change                                                          | Why                                                                                                                                                    |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `giniflow_visits.assigned_sd_id` — populate it                  | Today nothing sets it, so "queue for the logged-in SD" cannot filter. Either triage assigns (plan §2.8) or the first MO to open a patient claims them. |
| `giniflow_lab_orders.amount_total` — write at creation          | The order must carry the price it was quoted at; reception already reads it (lab plan §5b.2).                                                          |
| `giniflow_lab_order_tests.price` — from `giniflow_test_catalog` | Frozen per line at order time.                                                                                                                         |
| Chain — `sd_pending` between `vitals_done` and `with_sd`        | Already in `shared/giniflowStatus.js`; nothing writes it yet. The MO queue's "waiting for me" group is exactly this status.                            |

---

## 5. API

All under `/api/giniflow/stations/mo`, capability **`GINIFLOW_STATION_MO`**
(`mo`, `consultant`, `coordinator`).

| Method   | Path                  | Does                                                                                                  |
| -------- | --------------------- | ----------------------------------------------------------------------------------------------------- |
| `GET`    | `/queue?date=`        | the four groups + counters, filtered to the logged-in SD where assigned                               |
| `GET`    | `/:visitId`           | patient brief: vitals, biomarkers, diagnoses, medicines, existing plan, proposals, outstanding orders |
| `POST`   | `/:visitId/start`     | claim the patient → `with_sd` (mirrors the vitals station)                                            |
| `PUT`    | `/:visitId/plan`      | upsert the plan draft (autosave; `source: typed \| voice`)                                            |
| `POST`   | `/:visitId/proposals` | add a prescription proposal                                                                           |
| `DELETE` | `/proposals/:id`      | withdraw one before hand-off                                                                          |
| `POST`   | `/:visitId/tests`     | create a lab order — `{ urgency, tests[] }`, prices from the catalogue, trigger 2                     |
| `POST`   | `/:visitId/ready`     | → `ready_for_doctor`                                                                                  |
| `POST`   | `/:visitId/close`     | → `doctor_done`; **409 unless `category = in_control`**                                               |
| `GET`    | `/test-panels`        | the quick panels and individual test list                                                             |

Validation in `server/schemas/index.js`; every write through `advanceStatus` so the event log and
`actor_role = 'mo_sd'` are the same code path as every other station.

---

## 6. Rules the service enforces, not the screen

1. **Close is green-only.** The button is hidden for other categories _and_ the endpoint returns 409. This one sends a patient home without a doctor seeing them; a hidden button is not a rule.
2. **A plan is required before hand-off.** Passing a patient to the doctor with an empty plan
   wastes the consultation the board is trying to protect.
3. **One MO per patient.** Claiming sets `with_sd`; a second MO opening the same patient sees who
   holds them, mirroring the lab's no-op rather than erroring.
4. **Tests inherit urgency.** `today` reaches reception now; `tomorrow` and `next_visit` do not
   appear on today's desks (lab plan §5b.1).
5. **Blocked patients never appear.**

---

## 7. Blocked and open

|                                         |                                                                                                                                                                                                                                  |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Allergy strip**                       | **Blocked.** No allergy field exists anywhere — `patients` has only `notes`. Do not render "None recorded" against a patient nobody asked; it reads as a completed check. Phase 2 plan question 10.                              |
| **Who assigns the SD**                  | Triage (plan §2.8) or first-claim? Until decided, the queue shows unassigned patients to every MO.                                                                                                                               |
| **MHG concerns**                        | Which of `patient_symptom_log` / `symptom_logs` / `visit_symptoms` is the pre-visit source (question 6).                                                                                                                         |
| **Proposals vs Scribe's prescribing**   | Phase 3 owns the prescription. Proposals must not become a second prescribing path (Phase 3 plan, §3.4).                                                                                                                         |
| **Patient "Phase"**                     | **Blocked.** On every prototype, in no table (§3b.1). Blocks the patient header; do not invent a derivation.                                                                                                                     |
| **Where the doctor sees the MO's plan** | **Blocked for the hand-off to mean anything** (§3b.2). 2.7f can be built without it; the plan just reaches nobody until it is answered.                                                                                          |
| **External medicines**                  | No table exists; brief §3 specifies one for Phase 3. Until then the proposal UI must say the list is Gini medicines only, not imply it is complete.                                                                              |
| **Compliance %**                        | `appointments.pre_visit_compliance` holds `{pct, notes}` — the source for v2's "74% compliance" — but is unpopulated today. Render only when present.                                                                            |
| **Design review**                       | This screen is derived, not drawn. Worth ten minutes with Gurjot before building — particularly the five-group queue, whether Close belongs on the card as well as in the pane, and where the MO's plan surfaces for the doctor. |

---

## 8. Build order

1. **2.7a Schema** — `giniflow_sd_notes`, `giniflow_rx_proposals`, `giniflow_test_panels` + seed
   the six panels; write `amount_total` at order creation.
2. **2.7b Service** — `moStation.js`: queue, brief, claim, plan upsert, tests, ready, close.
3. **2.7c Capability + routes** — `GINIFLOW_STATION_MO`, page route, launcher tile.
4. **2.7d Queue pane** — groups, journey rail, bio chips, elapsed.
5. **2.7e Brief pane** — allergy strip (or its honest placeholder), vitals, biomarkers, diagnoses.
6. **2.7f Plan** — textarea, autosave, voice dictation.
7. **2.7g Tests panel** — urgency, quick panels, individual chips, confirm.
8. **2.7h Action bar** — ready / order / close, with the green-only guard.
9. **2.7i Proposals** — add and withdraw.
10. **2.7j Smoke** — `smoke:giniflow-mo`: the green-only rule refused at service level, trigger 2
    reaching reception, plan autosave, claim as a no-op, one event per transition attributed to
    `mo_sd`, and `flow_*` untouched.

**Two steps are blocked, and neither blocks the rest.** **2.7e**'s patient header needs the Phase
answer (§3b.1) — build the header without it and add it later rather than inventing a derivation.
**2.7f** can be built before §3b.2 is settled, but until it is, the plan an MO writes reaches
nobody.

**Ordering note:** 2.7a–2.7d make the station _useful_ — an MO can see their queue and pass
patients on. 2.7g is what unblocks reception and the lab, which have been empty since they were
built. If time is short, build to 2.7h and leave proposals for Phase 3.

---

## 9. Built — 2026-09-01

Sections 2–6 and build steps 2.7a–2.7j are complete, plus the fifteen findings in
`10-MO-SD-STATION-REVIEW.md`. Three things ended up different from this plan, deliberately:

| Plan                                          | Built                                                                              | Why                                                                                                                                                                                                                   |
| --------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §2.2 counters list "Results ready"            | Counters are the five §2.3 groups                                                  | The five-group queue is the later, more considered spec; "missing reports" is the group nobody else can unblock, so it gets a counter and §2.3's 🔴.                                                                  |
| §6 rule 3 — "a second MO sees who holds them" | The service **refuses** the write, and **Take over** is an explicit, logged action | The screen already hid the buttons. A hidden button is not a rule, and one of these buttons sends a patient home without a doctor seeing them. `POST /:visitId/takeover` reassigns and writes `meta.taken_over_from`. |
| §2.5 "the same `useVoiceVitals` pattern"      | `useDictation`, extracted from `useVoiceVitals`                                    | The vitals hook is welded to `parseSpokenVitals`. Both stations now share the recording machinery; only the vitals station parses.                                                                                    |

Two additions this plan did not ask for, both from the review:

- **`POST /:visitId/release`** — the chain only moves forwards, so an MO who claims the wrong
  patient had no exit (MO-15).
- **`giniflow_test_catalog.gloss`** — §2.6's chip gloss needed a column; seeded from
  `gini-doctor-final.html` `s-tests`. The same migration retires `Vitamin D`, a duplicate of
  `Vit D` that no panel used and that the duplicate-order guard could not have caught.

### Still open

§7 is unchanged — allergies, Phase, who assigns the SD, MHG concerns, external medicines, where
the doctor sees the MO's plan, proposals vs Scribe's prescribing. None has been guessed at.

**The design review has not happened.** §7's last row asks for ten minutes with Gurjot on the
five-group queue, whether Close belongs on the card as well as in the pane, and where the MO's
plan surfaces for the doctor. This screen is derived, not drawn, and that conversation is the only
item on this plan that code cannot close.

**And the hand-off still reaches nobody** (§3b.2): an MO writes a plan, presses _Ready for
Dr. Bhansali_, and no screen in the system displays it. The station is complete; its reader is not
built.
