# Consultant station — Part 2: prescription, tests, medicine card, Finalize

**Date:** 1 Sep 2026
**Status:** **built** — reviewed in `15-CONSULTANT-STATION-REVIEW.md`, findings applied 2 Sep 2026
**Brief:** `Gini-Flow-Developer-Brief.docx` §2.3 (trigger 4), §3 (data model), §4.4
**Part 1:** `13-CONSULTANT-STATION-PLAN.md` — queue, consult shell, overview, labs, care plan

## 0. Which prototype is the spec

**`gini-doctor-final.html` — sections `s-rx` `s-ext` `s-tests` `s-medcard` — is the spec, and it is
the only one.**

`gini-prescription-v2.html` **has already been merged into it**: doctor-final's `s-rx` _is_
prescription-v2's prescription screen, carried across whole — the inline row editor, the
add-medicine search with stock, the alternatives modal and the external-medicines table are all
present in doctor-final. Everything in §2–§3 below was read from doctor-final for that reason.

So there is nothing to reconcile between the two, and **where they differ at all, doctor-final
wins** — prescription-v2 is the earlier draft of the same screen, not a parallel spec. Open it only
if doctor-final leaves a mechanic unshown (a hover state, a mid-step of the alternatives modal), and
take the mechanic, not the layout. It is never a build target.

`gini-doctor-view.html` and `gini-doctor-v2.html` are **superseded — ignore them entirely.** Not
"consult if unsure": do not open them. Their earlier prescription grouping and concerns model were
deliberately replaced by doctor-final, and checking a built screen against a superseded one is how a
rejected design walks back in. Nothing in this plan comes from either, and nothing should.

---

## 1. The decision this part turns on

The brief (§3) proposes four new tables: `prescriptions`, `prescription_items`, `external_medicines`,
`pharmacy_inventory`. **Three of the four already exist in this repo under other names**, because
Scribe has been prescribing for months:

| Brief's table        | What this repo already has                                                                                                                                                                                                                                                            | Verdict      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `prescription_items` | `medications` — `name`, `pharmacy_match`, `composition`, `dose`, `frequency`, `timing`, `when_to_take[]`, `route`, `form`, `for_diagnosis[]`, `med_group`, `drug_class`, `clinical_note`, `is_new`, `is_active`, `started_date`, `stopped_date`, `stop_reason`, `common_side_effects` | **Reuse**    |
| `external_medicines` | the same `medications` table — it already carries `external_doctor` and `med_group = 'external'`                                                                                                                                                                                      | **Reuse**    |
| `prescriptions`      | `consultations` — one row per patient per visit, with `status draft\|completed` and `con_doctor_id`                                                                                                                                                                                   | **Reuse**    |
| `pharmacy_inventory` | **nothing.** No stock table anywhere in schema or migrations                                                                                                                                                                                                                          | **Gap — §7** |

Creating `prescription_items` beside `medications` would give this hospital two prescription
histories, and the medicine card, the refill queue, the dose-review queue, MHG and the Genie sync all
read the existing one. **The consultant station writes `medications`.**

Two columns the prototype needs and `medications` lacks — added by migration, not by a new table:

```sql
ALTER TABLE medications
  ADD COLUMN IF NOT EXISTS timing_category TEXT,   -- before_breakfast | with_lunch | bedtime | sos | weekly …
  ADD COLUMN IF NOT EXISTS time_of_day     TIME,   -- the actual clock time: 07:30
  ADD COLUMN IF NOT EXISTS change_type     TEXT,   -- continued | changed | new | stopped | paused
  ADD COLUMN IF NOT EXISTS change_note     TEXT;   -- '20mg→40mg, LDL 127'
```

`timing_category` is the machine-readable partner of the existing free-text `timing`, and
`when_to_take_pill` (11 patient-facing values) stays what it is — the card groups on
`timing_category`, the patient reads `when_to_take`. `change_type` is what makes the `🆕 Added this
visit` / `↑ Changed` chips and the pharmacy's Hindi counselling note possible.

## 2. Prescription section (`s-rx`)

### 2.1 The row

The prototype's table is `# · Medicine · Dose · Timing · Time · For · Stock · Actions`:

```
3.  ↑ Changed   Atchol 40mg                     OD    At bedtime   10:00 PM   LDL 127↑   ✓ 60 tabs   Edit Stop
                Atorvastatin · LDL 127 above target
```

- **Line 1** brand + strength, with the change chip: `🆕 Added this visit` (green) / `↑ Changed`
  (amber) / nothing for continued.
- **Line 2** `composition · why` — from `medications.composition` and `clinical_note`. The _why_ is
  the column a consultant scans; never drop it to save a row.
- **Stock** `✓ 84 tabs ~1 month` / `⚠ 9 tabs <2 weeks` / `✗ Out of stock` — §7.

### 2.2 Inline editing — click the row, not a modal

From doctor-final's `s-rx` (the merged prescription-v2 mechanics): the row expands in place into
Dose · Route (`Oral / SC / Topical`) ·
Timing (the 13 `timing_category` values) · Duration · Time · Patient instruction · _Reason for
change_ when it is a change · then `Save` `Cancel`, plus `Pause 2 weeks` and `Stop`.

Every edit is **autosaved to the draft** — a consultation interrupted by a phone call must lose
nothing, which is the rule Scribe's `active_visits` already established. Nothing reaches the
prescription history until Finalize.

**Pause vs Stop** are different clinical acts and the schema already knows it: pause sets a resume
date and keeps `is_active`; stop writes `stopped_date` + `stop_reason` and drops it from the card.
`Stopped meds` is a toggle above the table, not a deletion.

### 2.3 Add a medicine

Search over `pharmacy_inventory` in the prototype; here over `src/medicine_db.json` (~6,900 brands)
through the **existing `src/medmatch.js` fuzzy matcher** — the algorithm the README documents and the
consultation flow already uses. Results show `name · class · what it treats · stock · ₹/tab`, then
Dose · Frequency (`OD/BD/TDS/SOS/weekly/fortnightly`) · Timing · Time · Reason · Patient instruction.

### 2.4 Out of stock → alternatives

`✗ Telma AM 40+5 out of stock — 0 tabs.` opens the alternatives modal: same-drug-class substitutes
that _are_ in stock (`✓ Telmikind AM 40+5`), plus **"Patient brings from outside"** — which is not a
cancellation but a real prescribing decision, and must be recorded as one so the pharmacy does not
chase a medicine it was never meant to dispense.

### 2.5 The MO's proposals

`giniflow_rx_proposals` rows render **above the table** as a review strip — _Atchol 20mg → 40mg,
LDL 127 · proposed by Dr. Sidhu_ — each with **Approve · Adjust · Reject**. Approving applies the
change to the draft row; adjusting opens the row editor pre-filled; rejecting asks for one line of
why. This is the two-step review the MO station was built for, and the `status` / `decided_by` /
`decided_at` columns already exist waiting for it.

## 3. External medicines (`s-ext`)

Other doctors' prescriptions, `medications` rows with `external_doctor` set: medicine · dose/timing/
time · prescribing doctor with specialty and hospital · since · **interaction flag**
(`⚠ Check with Telma AM — dual RAAS`) · `Med card →`.

Add-external captures prescriber name, specialty, hospital, since-date and condition. These are
**never dispensable** — the pharmacy sees them, cannot hand them over, and the card marks them `Ext`.

Interaction checking is flagged in the prototype as automatic. Until there is a real interaction
dataset, the honest version is: **store the flag, let a human write it**, and never render an empty
flag as `✓ No interaction` — an unchecked pair must look unchecked. A fabricated all-clear on a drug
interaction is the single most dangerous thing this screen could do.

## 4. Tests (`s-tests`)

Straight reuse of the MO station's ordering, which is already built:

- **Urgency** — `Today → lab now` · `Tomorrow → reception` · `Next visit · Nov 2026`
- **Quick panels** — 🩸 Diabetes · 💛 Lipids · 🫘 Kidney · 🩺 Full workup · 🦋 Thyroid · ❤️ Cardiac,
  from `giniflow_test_panels` (seeded, with exactly these six)
- **Individual tests** from `giniflow_test_catalog`, each with its one-line gloss
- Footer: `7 tests selected · for next visit · sent to reception + lab when confirmed · patient
reminded on MHG`

Server: `moStation.orderTests` unchanged, called with `actorRole: "doctor"`. Tests the MO already
ordered are shown as ordered, not offered again.

## 4b. Voice — four controls in this part

Neither part of this plan mentioned voice, and the spec prototype puts a microphone in **six**
places. Four of them are in this part's scope; the other two are Part 1 §5.2b. This section was
added after reading `gini-doctor-final.html` and `gini-prescription-v2.html` side by side.

### 4b.1 Where the microphone is, and what it says

Read from `gini-doctor-final.html` (the spec, §0). Where prescription-v2 words an example
differently it is noted — the mechanic is the same and doctor-final wins on wording.

| #   | Control            | Where                                                              | The prototype's own example                                                                                                   |
| --- | ------------------ | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| 1   | **🎤 Voice edit**  | prescription section header, beside _Stopped meds_                 | _"Increase Atchol to 40mg"_ or _"Add Fenofibrate 145mg OD with lunch"_                                                        |
| 2   | **🎤 Speak**       | the voice bar, full width directly above the medicines table       | _"Increase Atchol to 40mg"_ · _"Add Fenofibrate 145mg once daily with lunch"_ · _"Stop Montair"_ · _"Pause Lipaglyn 2 weeks"_ |
| 3   | **🎤** (icon only) | inside the add-medicine search row, between the input and _Cancel_ | _"add Fenofibrate 145mg once daily with lunch for triglycerides"_                                                             |
| 4   | **🎤 Voice**       | tests section header                                               | _"Order diabetes panel for next visit"_ or _"Add TSH today"_                                                                  |

Controls 1 and 2 are the same action at two sizes — the header button for someone who knows the
phrasing, the bar for someone who does not. The bar's real job is teaching: it is the only place the
grammar is written down.

### 4b.2 The design is already in the codebase

The prototype's `.vbtn` and our existing `.voice-pill` (`giniflow-station.css`, built for the vitals
station) are the same control — purple `--pu`, 20px radius, 11px/600, white, flex with a small gap.
**Use `.voice-pill`; do not add a second purple pill.** The two header buttons take the prototype's
smaller variant (`font-size:10px; padding:4px 9px`).

Only the bar is new:

```css
.vbar   background var(--pu-l) · border 1px var(--pu-b) · radius var(--r) · padding 8px 11px
        margin-bottom 9px · flex · gap 8px · align-items center
.vbar-t flex 1 · 11px · var(--ink3) · line-height 1.5
.vbar-t em   color var(--pu) · italic      ← the example phrases
```

The live caption, the error line and the "listening" state already exist as `.caption`, `.cap-dot`,
`.cap-text`, `.voice-note` and `.voice-err`, built for the vitals station and reused as they are.

### 4b.3 Dictation and commands are two different features — do not conflate them

**This is the part the plan was missing, and it matters more than the buttons.**

Every example above is an **instruction**, not prose: _"Stop Montair"_, _"Pause Lipaglyn 2 weeks"_,
_"Order diabetes panel for next visit"_. That is a parsed command against a structured record, which
is a different problem from dictating a sentence into a textarea:

|               | Dictation                            | Command                                          |
| ------------- | ------------------------------------ | ------------------------------------------------ |
| Output        | a transcript                         | an intent — verb, medicine, dose, timing, reason |
| Wrong result  | a typo the consultant sees and fixes | **a prescription the consultant did not write**  |
| Already built | `src/hooks/useDictation.js`          | nothing                                          |

`shared/giniflowVitalsSpeech.js` is **not** the starting point, and Part 1 §8 pointing at it is a
mis-reference this plan corrects: it is a deterministic parser for six numeric vitals fields, and
nothing about it generalises to a drug name, a frequency or a verb.

**The hard rule: a spoken instruction never applies itself.** Transcript → parsed intent → **rendered
as the row's pending edit, with the row open**, exactly as if the consultant had clicked _Edit_ and
typed it. They confirm. There is no path where speech writes to `medications` without a human
looking at the parsed result first. This is prescribing, and §1's whole argument is that the
prescription is the thing this screen exists to get right.

Name resolution reuses **`src/medmatch.js`** over `src/medicine_db.json` (~6,900 brands) — the same
fuzzy matcher §2.3 already specifies for the search box and the consultation flow already uses.
Speech gives it a worse input than typing does, so the confidence it returns decides the UI:
a confident match opens the row pre-filled; anything less opens the **search results** with the
spoken text as the query, which is the honest failure and costs one tap.

### 4b.4 Build order — dictation first, and it is useful on its own

1. **Wire `useDictation` to every free-text field** in this part: the row editor's _Reason_ and
   _Patient instruction_. Nothing to parse, nothing to confirm, and it works the day it ships.
2. **The voice bar, teaching only** — render it with the four example phrases and the mic wired to
   dictation, filling the add-medicine search box (control 3). Still no command parsing.
3. **The command parser**, behind the confirmation rule above, one verb at a time in this order —
   `add` · `change dose` · `stop` · `pause` — because that is their order of frequency and of how
   badly a mistake reads.
4. **Tests by voice** (control 4) last: it maps onto `giniflow_test_panels` and
   `giniflow_test_catalog`, both closed vocabularies, so it is the easiest to parse and the least
   costly to get wrong.

Steps 1–2 are a day. Step 3 is the real work and should not be estimated with them.

### 4b.5 Open

- **Which processor.** `useDictation` runs the browser's recogniser when it is there (Chrome: Google)
  and falls back to Deepgram through `/api/ai/transcribe`. A consultation room utterance names a
  patient's medicines — unlike the vitals station's stream of numbers. Worth a deliberate decision
  before this reaches a real room, and it is the same decision `useDictation`'s own header flags.
- **Language.** The examples are English; the floor is not. `en-IN` is set, but a consultant who
  code-switches mid-sentence is the normal case, not the edge case, and no prototype shows it.
- **Whether the parser belongs here at all.** Scribe already turns a whole consultation into a
  structured prescription through Claude extraction. A second, smaller command parser on this screen
  may be the wrong shape — §1's decision about where prescribing lives should settle this before
  step 3 is built.

---

## 5. Medicine card (`s-medcard`)

**Not a table — a computed view**, exactly as the brief insists: active finalized `medications` +
external, grouped by `timing_category`, sorted by `time_of_day`.

```
🌅 Morning 7:00 AM      Pantoprazole 40mg   Ext · Dr. Sharma
🍳 Before breakfast 7:30 Lipaglyn 4mg       OD · ⚠ low stock
🥘 With breakfast 8:00   Cospiaq SM 25/100  OD
                         Telma AM 40+5      OD · ✗ out of stock
🥘 With lunch 1:30 PM    Fenofibrate 145mg  NEW
🍽 After dinner 9:00 PM  Aspirin 75mg       Ext · Dr. Mehta
🌙 At bedtime 10:00 PM   Atchol 40mg        ↑40mg
📅 Fortnightly           Aktiv-D 60,000 IU
🔔 As needed             Voveron gel        topical
```

Gini medicines solid, external dashed with the prescriber's name. **One query powers four surfaces**
— the consultant's card, the pharmacy's detailed card, the printed card, and the patient's MHG card.
Build it once in `server/services/giniflow/medicineCard.js`; four implementations of a dosing
schedule is four chances to tell a patient the wrong time.

`Send to patient` and `Print` are Phase 4 (WATI); the card itself is Phase 3.

## 6. Finalize — the fan-out (brief §2.3, trigger 4)

**One transaction.** Either all of it happens or none of it does — a prescription that reached the
pharmacy but not the patient's app is worse than a failed save.

**Reuse the save that already exists.** `POST /api/consultations`
(`server/routes/consultations.js`) is already the atomic `BEGIN…COMMIT` that writes `consultations` +
`vitals` + `diagnoses` + `medications` together, with `medication/normalize.js`,
`historicalStart.js` (earliest-start backfill) and `commonSideEffectsAI.js` hanging off it. Finalize
**must not** write a parallel set of INSERTs: extract that body into
`server/services/consultationSave.js` and call it from both the route and Finalize. Two code paths
writing the same four tables is how the two diverge, and this one already has a year of edge cases
baked into it — start dates, form prefixes, side-effect backfill.

The Rx PDF is not new either: `prescriptionAutoSave.savePrescriptionForVisit` renders and persists it
to `documents` + storage + Genie, idempotently, and `buildVisitPayloadFromDb` reconstructs the payload
server-side. Finalize calls it after commit.

```
Finalize
  ├─ consultationSave()              → consultations 'completed' + con_doctor_id,
  │                                    medications written with change_type stamped,
  │                                    stopped rows given stopped_date + stop_reason
  ├─ giniflow_rx_proposals           → any undecided row = rejected, reason 'not decided at consult'
  ├─ giniflow_lab_orders             → created per urgency (today → lab + reception payment task)
  ├─ giniflow_visits.current_status  → doctor_done → pharmacy_pending   (advanceStatus, actor doctor)
  ├─ medicine card                   → recomputed (a view; nothing stored)
  ├─ prescriptionAutoSave            → Rx PDF → documents + storage   (AFTER commit)
  └─ Genie / MHG sync                → fire-and-forget                (AFTER commit)
```

The confirmation panel lists what is about to happen, in the prototype's words, before the button:

```
💊 Pharmacy — Gini medicines only          📱 Patient MHG — full medicine card
📋 Pharmacy — counselling note in Hindi    🔬 Lab + Reception — 7 tests next visit
⚠ Telma AM out of stock — pharmacy warned
```

Finalize is **irreversible** by design — append-only, no backward transition. So it confirms, the way
a drop on Done does (`BQ-03`), and afterwards the consult is read-only with an addendum path.

## 7. Stock — the one open input

The prototype shows stock on every row, a low-stock warning, an out-of-stock block and an
alternatives flow. **This repo has no inventory table**, and the brief's own open question #3 asks
Nikhil where stock comes from — a manual seed, or an import from an existing stock sheet.

This is the only thing in either plan still waiting on an answer, and it blocks **§2.4 alone**.
Everything else — rows, editing, proposals, externals, tests, the card, Finalize — ships without it.
Build in two passes:

- Build the UI against a `pharmacy_inventory` table with `medicine_name`, `generic_name`,
  `drug_class`, `stock_qty`, `reorder_level`, `price_per_unit`, `alternatives[]` — exactly the
  brief's shape.
- Ship it **empty** and render `Stock —` where there is no row. Never render `✓ In stock` for a
  medicine nothing is known about: a false in-stock sends a patient to a counter that cannot serve
  them, and it makes the alternatives flow silently unreachable.
- The alternatives modal is the one piece that cannot ship before real data; everything else degrades
  honestly without it.
- **Pass 2, once the source is known:** if it is a sheet, import it the way `services/sheets/` already
  imports GHM data, on the worker rather than in a request. Stock then lights up every row, the
  low-stock warning and the alternatives flow with no UI change — the components were built against
  the same shape all along.

## 8. Server side

`server/services/giniflow/prescription.js`

| Function                                   | Does                                                   |
| ------------------------------------------ | ------------------------------------------------------ |
| `getDraft(visitId)`                        | draft rows + proposals + stock join                    |
| `upsertItem(visitId, item)` / `removeItem` | autosaved draft edits                                  |
| `pauseItem` / `stopItem`                   | resume date, or `stopped_date` + `stop_reason`         |
| `searchMedicines(q)`                       | `medmatch.js` over `medicine_db.json`, joined to stock |
| `alternativesFor(medicineId)`              | same drug class, in stock                              |
| `addExternal(patientId, med)`              | `medications` row with `external_doctor`               |

`server/services/giniflow/medicineCard.js` — `buildCard(patientId)`, the one computed view of §5.

`server/services/giniflow/finalize.js` — `finalizeConsult(visitId, actorId)`, the §6 transaction, with
the Genie sync fired after commit.

## 9. API

Behind `GINIFLOW_STATION_DOCTOR`, Zod-validated:

| Method | Path                                                        | Body                                                                                                          |
| ------ | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/giniflow/stations/doctor/:visitId/prescription`       | draft + proposals + stock                                                                                     |
| POST   | `/api/giniflow/stations/doctor/:visitId/prescription/items` | `{ medicineId?, name, dose, frequency, timingCategory, timeOfDay?, duration?, reason?, patientInstruction? }` |
| PATCH  | `…/prescription/items/:itemId`                              | same, partial                                                                                                 |
| DELETE | `…/prescription/items/:itemId`                              | draft rows only                                                                                               |
| POST   | `…/prescription/items/:itemId/pause`                        | `{ weeks }`                                                                                                   |
| POST   | `…/prescription/items/:itemId/stop`                         | `{ reason }`                                                                                                  |
| GET    | `/api/giniflow/stations/doctor/medicines?q=`                | search + stock                                                                                                |
| GET    | `/api/giniflow/stations/doctor/medicines/:id/alternatives`  | same class, in stock                                                                                          |
| POST   | `/api/giniflow/stations/doctor/:visitId/external`           | external medicine                                                                                             |
| POST   | `/api/giniflow/stations/doctor/:visitId/tests`              | `{ urgency, tests[] }` → `moStation.orderTests`                                                               |
| GET    | `/api/giniflow/stations/doctor/:visitId/medicine-card`      | the computed view                                                                                             |
| POST   | `/api/giniflow/stations/doctor/:visitId/finalize`           | `{ confirm: true }` → the fan-out                                                                             |

409 for a clinical refusal the consultant can act on ("already finalized", "medicine out of stock —
choose an alternative"); 4xx never as a 500, the rule the queue endpoints already follow.

## 10. Smoke coverage

`smoke:giniflow-doctor` — queue grouping and counts; one-at-a-time claiming; proposal decisions
writing `decided_by/at`; draft autosave surviving a reload; pause vs stop; **Finalize as one
transaction** (force a failure mid-fan-out and assert nothing was written); the medicine card grouping
and ordering; an out-of-stock row refusing to finalize silently.

## 11. Migrations

| File                                           | Contents                                                               |
| ---------------------------------------------- | ---------------------------------------------------------------------- |
| `2026-09-0X_medications_timing_and_change.sql` | the four columns in §1                                                 |
| `2026-09-0X_pharmacy_inventory.sql`            | the brief's inventory shape, seeded empty (§7)                         |
| `2026-09-0X_giniflow_doctor_capability.sql`    | none needed — capabilities live in `shared/permissions.js`, not the DB |

## 11b. Two accepted deviations from this plan

Both were taken during the build for checkable reasons, and both have a consequence this plan should
state rather than leave a reader to discover (review CS-04, CS-05).

**Medicine search does NOT use `src/medmatch.js`** (this plan's §2.3). That module imports
`src/lib/medName` with no file extension — Vite resolves it, Node does not, so importing it
server-side throws `ERR_MODULE_NOT_FOUND`. Search instead ranks what the hospital has actually
prescribed (`medications`), then `drug_master`, then `mhg_drug_formulary`.

> **Consequence, stated plainly:** Scribe's wizard and the Gini Flow consult now search different
> medicine universes with different algorithms, and the pharmacy sees whichever brand spelling the
> path used. That is a product decision, not an implementation detail. Adding `.js` to one import
> would make the original approach work — worth pricing before accepting the fork permanently.

**`consultationSave` was not extracted** (this plan's §6). The wizard route is bound to the
`mo_data` / `con_data` / `exam_data` payload and there is no test suite to catch a regression in the
live Scribe save path, so Finalize writes against the same helpers and the same conflict keys
instead. Two things follow:

- Finalize writes `consultations` + `medications` only. It does **not** write `vitals` or
  `diagnoses`, which `POST /api/consultations` does — a Gini Flow consultation therefore produces a
  thinner record than a wizard one.
- `medication/normalize.js` runs (via the draft), but `historicalStart.js` and
  `commonSideEffectsAI.js` do not.

The invariant that matters is enforced by the database rather than by either code path: the two
partial unique indexes, now in the migration chain (CS-01), mean neither writer can create a second
active row for the same medicine.

## 12. Status of the questions Part 1 raised

| Question               | Status                                                                                                                                                         |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scribe vs Flow consult | **Resolved** — beside, sharing tables; Finalize calls the existing consultation save (§6)                                                                      |
| Six key numbers        | **Resolved** — ranked, with the prototype's set as fallback (Part 1 §15)                                                                                       |
| Pharmacy stock source  | **Open — Nikhil.** Blocks §2.4 only; §7 says what ships meanwhile                                                                                              |
| WATI templates         | **Start now, needed Phase 4.** The brief warns approval takes days; the medicine-card message and referral letter should be in review before the send is built |

## 13. Definition of done

1. A consultant can open a `ready_for_doctor` patient, review the MO's proposals, edit the
   prescription, order tests, read the card and Finalize — and the board shows them at
   `pharmacy_pending` without a refresh.
2. Finalize is atomic: force a failure inside the fan-out and **nothing** is written — no half
   prescription, no orphan lab order, no status move.
3. The medicine card renders identically for the consultant, the pharmacy and MHG, because all three
   call `medicineCard.buildCard`.
4. A finalized visit is read-only; the only writable path is an addendum.
5. Nothing writes `prescription_items` — the repo has one prescription history, `medications` (§1).
6. `smoke:giniflow-doctor` green; `verify-rbac.mjs` green; build and `format:check` clean.
