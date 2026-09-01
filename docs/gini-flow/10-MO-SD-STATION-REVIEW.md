# MO / SD station — implementation review

**Date:** 1 Sep 2026
**Reviewing:** the implementation of `08-MO-SD-STATION-PLAN.md` — tasks 2.7a–2.7j.

**Files:** `server/migrations/2026-09-01_giniflow_mo_station.sql`,
`server/services/giniflow/moStation.js`, the MO block of `server/routes/giniflowStations.js`,
`server/schemas/index.js`, `src/pages/giniflow/MoStationPage.jsx`,
`src/queries/hooks/useGiniflowMo.js`, `server/scripts/smoke-giniflow-mo.mjs`, and the
capability/route wiring.

**Method:** static review against the plan and the brief's §4.3. Nothing executed against the
database; no files changed.

**Findings:** 2 blocking · 4 high · 6 medium · 3 low.
**Verdict:** the station works and the hard rules are enforced. What is missing is the half of the
brief pane the plan spent most of its words on, and two queue rules that make it the _logged-in_
MO's station rather than everyone's.

---

## 1. Task-by-task

| Task     | Plan                                                       | State      | Notes                                                                                                                              |
| -------- | ---------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **2.7a** | `sd_notes`, `rx_proposals`, `test_panels` + six panels     | ✅ Full    | All three tables, panels seeded from `s-tests`, `amount_total` written at order creation, line prices frozen from the catalogue    |
| **2.7b** | `moStation.js` — queue, brief, claim, plan, tests, actions | ✅ Full    | All ten functions exist and are exported                                                                                           |
| **2.7c** | `GINIFLOW_STATION_MO`, route, launcher tile                | ✅ Full    | Granted to `mo`, `consultant`, `coordinator` — exactly the plan's §5 list. Page route, launcher tile, station gate all in place    |
| **2.7d** | Queue pane — groups, journey rail, bio chips, elapsed      | 🟡 Partial | Groups, chips, elapsed, reports line and compliance all present. **No journey rail. `inPipeline` is never rendered** (MO-03)       |
| **2.7e** | Brief pane — allergy strip, vitals, biomarkers, diagnoses  | 🟡 Partial | Allergy strip and vitals are right. Biomarkers are static divs; diagnoses, medications, concerns and external medicines are absent |
| **2.7f** | Plan — textarea, autosave, voice dictation                 | 🟡 Partial | Textarea and autosave good. **No voice dictation**                                                                                 |
| **2.7g** | Tests panel — urgency, panels, chips, confirm              | ✅ Full    | Matches `s-tests`: urgency first, six quick panels, individual chips with prices, footer naming the destination                    |
| **2.7h** | Action bar — ready / order / close with the green guard    | ✅ Full    | Both server-enforced. Close confirms and names the rule                                                                            |
| **2.7i** | Proposals — add and withdraw                               | 🟡 Partial | Table, endpoints, schema, hooks and smoke coverage all exist. **No UI** — the hooks are imported into the page and never called    |
| **2.7j** | `smoke:giniflow-mo`                                        | ✅ Full    | 28 checks covering every rule the plan named, plus `flow_*` isolation                                                              |

---

## 2. What is good — keep

- **The two hard rules are enforced in the service, not the button.** Close returns 409 with the
  patient's actual category named; hand-over returns 409 without a plan. The plan said "a hidden
  button is not a rule" and the code took it literally. Both are asserted in the smoke suite.
- **Trigger 2 is a single transaction** — order, priced lines, total, and the
  `giniflow_lab_order_events` row that puts the card on reception's desk. The smoke suite proves it
  reaches reception, and proves a `next_visit` order does _not_.
- **Prices are frozen onto the order lines at order time**, so a catalogue change cannot re-price
  what a patient was quoted. Consistent with the reception station's own reasoning.
- **The allergy strip says what is true.** `allergies: null` from the service, and the screen renders
  "ALLERGIES: not recorded anywhere — ask the patient". This is exactly what the plan demanded and
  the opposite of the failure it warned about.
- **The plan is an upsert, not an append**, with the reasoning recorded: a draft is not history, and
  an interrupted MO should find what they typed.
- **`getMoPatient` returns no invented fields.** No `phase`, no fabricated allergy list — and the
  smoke suite asserts the absence, which is an unusual and good thing to test.
- **Five groups, not four.** `awaitingResults` and `missingReports` are separated with the plan's
  reasoning intact: merging them hides the only group an MO can unblock.
- **Withdrawing a proposal is scoped to `status = 'proposed'`** and 409s otherwise, so the MO cannot
  retract something the doctor has already decided.
- **The plan autosave deliberately does not invalidate the queue**, so typing does not re-render the
  left pane on every keystroke.

---

## 3. Blocking

### 🔴 MO-01 — the queue is not filtered to the logged-in SD

Brief §4.3's first clause is "queue of `sd_pending` **for the logged-in SD**", and plan §5 repeats
it. `groupOf` computes `mine` — and then uses it only for the `with_sd` branch:

```js
const mine = !row.assigned_sd_id || row.assigned_sd_id === sdId;
if (row.current_status === "with_sd") return mine ? "withMe" : "withOtherSd";
...
if (["vitals_done", "sd_pending"].includes(row.current_status)) { ... return "waitingForMe"; }
```

So a patient at `vitals_done` who triage assigned to Dr. A appears in Dr. B's "Waiting for me", and
in every other MO's too. `withOtherSd` catches only patients another SD is _actively_ holding.

On a floor with two SDs this is the difference between a queue and a free-for-all: two MOs open the
same patient, the second one's claim is a no-op, and the first finds someone else's patient in their
list.

**Recommendation.** Apply `mine` to the waiting branch as well — assigned-to-me or unassigned in
"Waiting for me", assigned-to-another in `withOtherSd`. The plan's §7 note ("until the SD-assignment
question is decided, the queue shows unassigned patients to every MO") covers _unassigned_ patients,
not assigned ones.

### 🔴 MO-02 — claiming can skip vitals entirely

`startWorkup` claims from `checked_in`, `vitals_pending`, `with_vitals`, `vitals_done` or
`sd_pending`, with `allowSkip: true`. `checked_in`(2) → `with_sd`(7) is a five-status jump: the
patient leaves the vitals queue without a reading, the vitals budget measures nothing, and the board
shows them at the SD desk while they are physically waiting for their BP.

Not reachable through the UI _today_ only because of MO-03 — the pipeline group is never rendered,
so there is no row to tap. It is reachable through the API now, and reachable through the UI the
moment that group is drawn, which the plan asks for.

It also repeats the pattern the Phase 2 audit raised against the vitals station: `statusEngine`'s own
comment says `allowSkip` exists for the HealthRay sync and that "a station screen must never set it".
Three of this station's four writes set it.

**Recommendation.** Claim only from `vitals_done` / `sd_pending`; render pipeline rows as read-only.
Drop `allowSkip` from `readyForDoctor` — it is a one-status move that does not need it, and the flag
is currently suppressing the guard that would catch a hand-over from a patient who never reached
`with_sd`.

---

## 4. High

### 🟠 MO-03 — the "In pipeline" group is computed and never shown

`groupOf` returns `inPipeline` for `checked_in` / `vitals_pending` / `with_vitals`, `getMoQueue`
returns the array — and the page's `GROUPS` list omits it. So those patients are fetched on every
poll and dropped. The empty-state check has the same blind spot: with only pipeline patients on the
floor, the screen says "Nobody is waiting for you right now", which is arguably true for an MO but is
not what the plan describes.

**Recommendation.** Render it (read-only, per MO-02), or stop fetching those statuses.

### 🟠 MO-04 — "Passed on / closed" counts everyone's work

`groupOf` returns `done` for any `ready_for_doctor` / `doctor_done` visit with no check on who did
it, and `counters.closedByMe` counts that group. The plan says "by me, today". An MO who has closed
nothing sees a full "passed on" list and a counter reading someone else's throughput.

**Recommendation.** Filter on `assigned_sd_id`, or on the actor of the closing event.

### 🟠 MO-05 — a test that is not in the catalogue is ordered at ₹0

```js
const priceOf = Object.fromEntries(priced.map(...));
const total = tests.reduce((sum, name) => sum + (priceOf[name] ?? 0), 0);
```

`giniflowOrderTestsSchema` accepts any string up to 120 characters, and an unmatched name silently
prices at zero. The order is created, the line is written at ₹0, and reception sees a card with a
total that does not cover it. Nothing errors.

The panels make this reachable without malice: `giniflow_test_panels` seeds `Post-meal`, `HOMA-IR`,
`Total cholesterol`, `LDL`, `HDL`, `eGFR`, `FT3`, `FT4`, `ECG`, `NT-proBNP`, `hs-CRP`,
`Fasting Insulin` — **none of which are in `giniflow_test_catalog`**, whose twelve rows are HbA1c,
FBS, Lipid panel, Creatinine, UACR, TSH, LFT, CBC, Vit D, KFT, Urine R/M and Vitamin D. Tapping
"Diabetes panel" therefore orders four tests of which three cost nothing.

**Recommendation.** Reject unknown test names with a 400, and reconcile the panel contents against
the catalogue in the migration — they were written from different prototypes and do not agree.

### 🟠 MO-06 — the active patient can change while a plan is being typed

`activeId = selected ?? queue?.withMe?.[0]?.visitId ?? queue?.waitingForMe?.[0]?.visitId`. Until the
MO taps a row, the active patient is the head of a queue that refetches every 15 seconds. When it
changes, the effect on `patient?.visitId` resets `plan` — and the autosave is on an 800 ms debounce
with no flush on unmount or blur, so the last thing typed is lost.

Same class as the vitals station's finding, with a longer text field to lose. The auto-selection not
claiming the patient is the right call; the instability is not.

**Recommendation.** Flush the debounce on patient change and on unmount; pin the selection once the
textarea has been touched.

---

## 5. Medium

**🟡 MO-07 — no proposals UI.** Table, endpoints, Zod schema, both hooks and smoke coverage all
exist; `patient.proposals` is fetched and never rendered, and `useAddProposal` / `useWithdrawProposal`
are imported into the page and never called. Addendum change ③ is a Phase 2 item per plan §0.3, and
this is the last 5% of it.

**🟡 MO-08 — half the brief pane is fetched and discarded.** `getMoPatient` returns `diagnoses`,
`medications` and `compliance`; the page renders none of them. Plan §2.4 items 5, 6 and 7 —
diagnoses and active medicines, today's concerns from three sources, external medicines — are all
absent. The concerns block is the one the plan argued for hardest ("what an MO reads in three
seconds"), and external medicines carries a stated safety caveat: a dose proposal made without sight
of what another hospital prescribed is unsafe, so if the list is Gini-only the screen must say so.

**🟡 MO-09 — biomarker tiles are not buttons.** Plan §2.4 item 4 asked for them to be buttons from
the start "so the graph is an addition, not a rebuild", and for a previous value and trend arrow on
each. They are static divs showing the current value only. `recharts` is already a dependency.

**🟡 MO-10 — no journey rail, and two counters short.** Plan §2.3 lists
`Check-in ✓ › Vitals ✓ › MO › Doctor › Pharmacy` on every row; it is not there. The rail shows three
badges where §2.2 specifies five — `awaitingResults` and `missingReports` are computed in `counters`
and never displayed, which is the pair the five-group split existed to surface.

**🟡 MO-11 — no voice dictation on the plan.** Task 2.7f. The pattern exists in `useVoiceVitals` and
the transcription endpoint is already wired.

**🟡 MO-12 — duplicate orders are unguarded.** Confirming the same panel twice creates two lab
orders, two payment cards on reception's desk and two charges. `patient.orders` is shown as a hint
line but nothing warns or dedupes.

---

## 6. Low

**🔵 MO-13 — `window.confirm` for Close.** It blocks the page, cannot be styled for a station tablet,
and is inconsistent with the toast/modal patterns used elsewhere in Gini Flow. The copy itself is
good.

**🔵 MO-14 — five sequential queries per patient selection** (visit, station vitals, previous vitals,
notes, proposals, orders). Fine at one MO; worth knowing before four stations poll together.

**🔵 MO-15 — no release.** As at vitals, an MO who opens the wrong patient has claimed them, and
backwards transitions are rejected. The plan's rule 3 ("a second MO opening the card is a no-op, not
a steal") is implemented correctly; the first MO's mistake has no exit.

---

## 7. Still blocked, correctly

These are the plan's §7 items and none of them has been guessed at, which is the right outcome:

- **Allergies** — no data source; the strip says so rather than saying "none".
- **Phase** — no column; omitted rather than invented, and the smoke suite asserts it.
- **Who assigns the SD** — undecided, so `startWorkup` falls back to first-claim. Reasonable, but see
  MO-01: the fallback currently applies to assigned patients too.
- **MHG concerns** — the three symptom tables are still unreconciled, so the concerns block is absent
  rather than wrong.

---

## 8. Suggested order

1. **MO-01** — apply `mine` to the waiting branch. It is the brief's first requirement and a
   two-line change.
2. **MO-05** — reject uncatalogued tests, and reconcile the panel seed with the catalogue. Today the
   most-used button on the screen orders three free tests.
3. **MO-02** — narrow the claim to `vitals_done` / `sd_pending`; drop `allowSkip` from
   `readyForDoctor`.
4. **MO-06** — flush the autosave before switching patients.
5. **MO-03**, **MO-04** — render the pipeline group, scope "passed on" to this MO.
6. **MO-07 – MO-11** — the brief pane and the plan's remaining UI: proposals, diagnoses, concerns,
   biomarker buttons, journey rail, the two missing counters, voice.
7. **MO-12 – MO-15** as capacity allows.

The plan's own note applies: 2.7a–2.7d make the station useful, and 2.7g is what unblocks reception
and the lab. Both are done. What is left is mostly the brief pane — the part that decides whether an
MO can write a good plan rather than merely a plan.

---

## 9. Resolution — 2026-09-01

Every finding above is fixed. What changed, and where:

| ID | Fix |
| --- | --- |
| MO-01 | `groupOf` applies `mine` to the waiting branch and to `done`; another SD's patient reads as `withOtherSd`. |
| MO-02 | `startWorkup` claims only from `vitals_done` / `sd_pending`; `readyForDoctor` no longer passes `allowSkip`. |
| MO-03 | `inPipeline` renders as a read-only group. |
| MO-04 | "Passed on" is scoped to the logged-in MO. |
| MO-05 | `orderTests` rejects an uncatalogued test with 400; `2026-09-01_giniflow_catalog_reconcile.sql` brought the catalogue to 26 tests with every panel test priced. |
| MO-06 | `flushPlan` runs before a patient switch and on unmount; `pendingSave` carries its own visit id. |
| MO-07 | Proposals list plus an add form on the brief; withdraw is one tap. |
| MO-08 | Diagnoses, current medicines, and a three-source concerns block. Patient-reported concerns say they are not wired rather than reading as "none". The medicines list states that another hospital's prescriptions are not recorded. |
| MO-09 | Biomarker tiles are buttons carrying the previous value and a direction arrow; tapping one opens a recharts trend from `biomarkerHistory`. |
| MO-10 | `JourneyRail` on every queue row and on the open patient; the top rail shows all five counters. |
| MO-11 | `useDictation` extracted from `useVoiceVitals` and wired to the plan textarea; it appends rather than replaces. |
| MO-12 | `orderTests` refuses a test already ordered whose sample has not been taken; the chip is disabled and reads "ordered". |
| MO-13 | `ConfirmDialog` (Escape, click-outside, focus return) replaces `window.confirm`. |
| MO-14 | The brief's six reads run as one `Promise.all`. |
| MO-15 | `POST /giniflow/stations/mo/:visitId/release` writes a wrongly-claimed patient back to `sd_pending`, clears the assignment, and records the correction. The plan survives. |

`server/scripts/smoke-giniflow-mo.mjs` covers MO-01, MO-02, MO-05, MO-09, MO-12 and MO-15 as
regressions — 42 checks, all passing.

§7's four blocked items are unchanged and still blocked: allergies, phase, who assigns the SD, and
the MyHealth Genie symptom feed. None has been guessed at.
