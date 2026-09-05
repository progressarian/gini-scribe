# Paste a prescription — filling the draft without typing it out

- Proposed: 5 Sep 2026
- Revised: 5 Sep 2026 — §3 and §4 corrected against the code and the live data (see §8)
- Section: `src/pages/giniflow/consult/RxSection.jsx` (`#s-rx`)
- Pattern it copies: `server/services/giniflow/planExtract.js`
- Migration: **none**

## 1. The problem, in the consultant's words

Adding medicines one at a time is slow and boring. A follow-up patient on six drugs is six trips
through the search box, the dose field, the frequency picker and the timing chips — for a
prescription the consultant may already have in front of them as text, from the last visit, a
referral letter or a message.

The ask: paste that text, have the draft fill itself, then review and save.

The last clause is the important one. This does not prescribe. It fills a form the consultant then
reads.

## 2. What already exists

Three of the four pieces are built and in production. This plan mostly wires them together.

| piece                   | where                                  | state                                                                   |
| ----------------------- | -------------------------------------- | ----------------------------------------------------------------------- |
| free text → strict JSON | `planExtract.js`                       | shipped — the MO's plan lights up test chips                            |
| name → pharmacy brand   | `prescription.js` `searchMedicines()`  | shipped — 3 ranked sources, hospital's own history first                |
| the review gate         | `.rx-proposed` rows + `finalize.js:96` | shipped — finalize 409s while anything is `approval_status = 'pending'` |
| **text → Rx rows**      | —                                      | **missing. This plan.**                                                 |

### 2.1 What the voice button does not do

`🎤 Voice edit` looks like this feature already exists. It is not. `VoiceInput.jsx` dictates into
the add-medicine **search box** and stops there — its own comment says so:

> Dictation fills the add-medicine search; it does not execute the phrase (§4b.3).

There is no text → structured-medicine path anywhere in the Rx section today.

### 2.2 The safety property to copy

`planExtract.js` states it in its header, and this feature inherits it verbatim:

> THIS EXTRACTS, IT DOES NOT AUTHOR… never a test the plan does not mention, never a dose the plan
> does not state. Nothing here reaches the database: the endpoint returns a proposal, the chips
> light up, and the MO confirms.

### 2.3 What `addItem` already normalises

`normaliseItem` (`prescription.js:252`) runs on every insert and already derives four fields, so the
parser must **not** compute them:

- strips the form prefix (`Tab`/`Cap`/`Inj`) and keeps the form
- `pharmacyMatch` via `canonicalMedKey` — the key the dispensing counter reads
- orders the timing slots and picks the primary
- `timeOfDay` via `defaultTimeFor(primary)`

The parser's job is narrower than it first looked: name, dose, frequency, timing, duration, reason.

## 3. What the data actually looks like

Checked against production before writing the parser. Three corrections to the obvious design:

### 3.1 `dose` is the strength, and it is messy

Top values in `medications`: `20 mg` (4,823), `60K` (2,531), `60,000 IU` (1,805), `60+500 mg`
(1,582), `60/500 mg` (1,392). Live draft rows include `10/20 mg`, `0.4+0.5 mg`, and
`45 units (morning) + 40 units (evening)`.

So the dose field is free text carrying combination strengths, unit forms and occasionally prose.
The parser must **copy what it reads**, not normalise into a canonical strength — normalising
`60+500 mg` would change a prescription.

### 3.2 `frequency` is a small vocabulary with prose synonyms

`OD` (58,066), `BD` (12,477), `Once in 15 days` (5,823), `SOS` (5,078), `Once daily` (5,050),
`Twice daily` (1,055), `TDS` (861), `As needed` (797).

Pass 1 should fold the synonyms — "once daily" → `OD`, "twice daily" → `BD`, "as needed" → `SOS` —
because the pickers and `DOSES_PER_DAY` are keyed on the short forms. Anything unrecognised is
carried through verbatim rather than guessed at.

### 3.3 The timing slots are unused in practice

| field                             | populated   |
| --------------------------------- | ----------- |
| `giniflow_rx_items.timing` (text) | 27 of 30    |
| `timing_category`                 | **0 of 30** |
| `timing_categories`               | **0 of 30** |
| `medications.timing` (text)       | 102,787     |

Real timings are sentences: `10 PM`, `8 PM after dinner`, `45 min before breakfast and dinner`,
`10 PM preferably with milk`.

This matters: the first draft of this plan treated `MED_SLOT_KEYS` as the parser's main output. It
is not what the data holds. **The parser fills `timing` as text** — matching every existing row —
and proposes a `timingCategory` only when the phrase maps cleanly through `WHEN_TO_TAKE_SLOT`.

That the row UI and `RowEditor` are built on categories while no row has one is a pre-existing gap.
This feature should not paper over it, and can quietly improve it: a paste that says "after lunch"
can fill both.

## 4. The parse — two passes, cheapest first

### 4.1 Pass 1: deterministic

Most pasted prescriptions are one medicine per line in a shape this hospital already writes:

```
Tab Atchol 40mg 1-0-1 after food x 30 days
Fenofibrate 145 OD with lunch
```

**`src/lib/medName.js` is importable server-side — verified.** (`src/medmatch.js` is not;
`prescription.js` documents why.) It already exports `stripFormPrefix`, `extractDose`,
`extractStrength` and `canonicalMedKey`, so pass 1 is mostly assembly:

- form prefix and name → `stripFormPrefix`
- strength → `extractDose` / `extractStrength`
- frequency → the §3.2 vocabulary, plus the `1-0-1` idiom (no existing parser for it — the only
  occurrences in the repo are literals in `demo.js`)
- timing → text as written, category via `WHEN_TO_TAKE_SLOT` when it maps
- duration → `x 30 days`, `for 1 month`

Free, instant, unit-testable, and **it cannot invent a dose**. Every line it reads confidently is a
line the model never sees.

### 4.2 Pass 2: Haiku, only for what pass 1 could not read

Modelled line-for-line on `planExtract.js`: `claude-haiku-4-5-20251001`, strict JSON, no prose,
20-second timeout, 6000-character cap, and the same refusal rules.

The prompt's hard rules:

- Extract only what the text names. Never add a medicine, dose, frequency or duration it does not
  state, however clinically sensible.
- **A missing dose stays empty.** It is a blank for the consultant to fill, never a guess.
- Copy the dose as written — do not normalise `60+500 mg`.
- A line that cannot be read goes to `unmatched` in the user's own words — never a near-match.

### 4.3 Name resolution and confidence

Every parsed name goes through the existing `searchMedicines()`, which returns
`{ name, composition, drugClass, timesPrescribed, stock }`.

`timesPrescribed` is the confidence signal worth using: a brand this hospital has written 4,823
times is a safe auto-fill; a 0-use row from the formulary is a suggestion the consultant should
confirm. Proposal:

| condition                               | treatment                                       |
| --------------------------------------- | ----------------------------------------------- |
| exact name match, `timesPrescribed` > 0 | filled in, ready to add                         |
| exact match, 0 uses                     | filled in, flagged "not prescribed here before" |
| no exact match                          | `unmatched` — search box on the row             |

Never a silent near-match: the same rule `planExtract` applies to test names, for the same reason.

### 4.4 The endpoint

```
POST /giniflow/stations/doctor/:visitId/prescription/parse
     doctorGate + requireOwnVisit
     body: { text }
     returns: { items: [...], unmatched: [...], usedModel: bool }
     writes: NOTHING
```

## 5. The UI

### 5.1 Where it goes

`📋 Paste` next to `🎤 Voice edit` in `.cs-head-r`, same pill styling.

The panel opens **inline**, below the section head. The section's idiom is inline panels — the
teaching `vbar`, the add form, the external-medicine form — not modals. A modal here would be the
only one in the section.

### 5.2 Step one — paste

```
┌ 📋 Paste a prescription ─────────────────────────────────┐
│ ┌──────────────────────────────────────────────────────┐ │
│ │ Tab Atchol 40mg 1-0-1 after food x 30 days           │ │
│ │ Fenofibrate 145 OD with lunch                        │ │
│ │ Stop Montair                                          │ │
│ └──────────────────────────────────────────────────────┘ │
│                                    [ Read it ]  [Cancel] │
└──────────────────────────────────────────────────────────┘
```

### 5.3 Step two — review, still unsaved

```
┌ 3 read · 2 matched · 1 needs a brand ────────────────────┐
│ ✓ Atchol 40mg      1-0-1   after lunch   30 days   [✎][✕]│
│ ✓ Fenofibrate 145  OD      with lunch    —         [✎][✕]│
│ ⚠ "Montair"  no brand matched  [ search… ]         [✕]   │
│                                                          │
│                        [ Add 2 medicines ]     [ Cancel ]│
└──────────────────────────────────────────────────────────┘
```

Rows reuse the `.rx-row` column layout — name · dose · timing · for — so the review reads like the
list it is about to join. Unmatched names keep the medicine search attached instead of being
silently dropped.

**One click adds all of them.** That is the time saving being asked for; a per-row approval would
hand back the tedium the feature exists to remove.

### 5.4 The editor cannot be reused as-is

`RowEditor` takes a **persisted** row: snake_case fields (`item.time_of_day`,
`item.patient_instruction`), and `onPause` / `onStop` handlers that act on a saved id.

Two options, neither free:

1. feed it a synthetic snake_case object and hide pause/stop — smallest change, slightly dishonest
   shape;
2. a small `PastedRowEditor` sharing the same `.rx-grid` markup — more code, no pretence.

Option 2 is preferred; the grid is markup, not logic.

### 5.5 Adding is N requests, and some will fail

There is **no batch endpoint**, and `addItem` throws **409** on a duplicate:

> `${clash[0].medicine_name} is already in this prescription — edit that row instead`

with `existingItemId` on the error. This is not a free guard — it is a partial-failure case the UI
must handle. "Add 6 medicines" issues 6 sequential POSTs and reports honestly:

```
✓ 4 added · 1 already in the prescription (Atchol — open that row) · 1 left for you to match
```

The alternative is a `addItems()` batch service function wrapping the same duplicate check in one
transaction. Worth it if pastes are routinely 5+ lines.

### 5.6 Read-only

The whole control sits behind the existing `readOnly` prop, so it never appears on another
consultant's patient or on a finalized visit.

## 6. The alternative that was not chosen

Insert the parsed rows immediately with `approval_status = 'pending'` and let the consultant use the
per-row `✓ Approve` / `Adjust` / reject controls that already exist.

Attractive: no new review UI at all, and `finalize.js:96` already refuses to finish while any row is
pending — a hard safety gate for free.

Rejected because it writes before the consultant has read anything, which breaks the property §2.2
names, and because it costs a decision per row — six approvals to save six typings. It would also
need an additive `proposed_source` column so the chip could read "📋 Pasted" rather than "Proposed
by the MO".

Worth revisiting if a stricter per-row gate is ever wanted.

## 7. Size and risk

| piece                | size       |
| -------------------- | ---------- |
| deterministic parser | ~140 lines |
| Haiku fallback       | ~130 lines |
| route                | ~15 lines  |
| paste panel + review | ~200 lines |
| `PastedRowEditor`    | ~80 lines  |
| optional batch add   | ~40 lines  |
| migration            | none       |

The risk is a mis-parse reaching the draft. Held off by, in order: nothing is written until the
consultant clicks Add; a missing dose is blank rather than guessed; the dose is copied, never
normalised; an unresolved name is never auto-matched; `addItem` refuses a duplicate on the pharmacy
key; and Finalize remains the last gate.

## 8. What the revision changed

The first draft asserted four things the code and data did not support:

1. **`src/lib/medName.js` server-side** — assumed unusable by association with `medmatch.js`.
   Verified importable, and it supplies most of pass 1.
2. **`MED_SLOT_KEYS` as the parse target** — no row in `giniflow_rx_items` has a timing category;
   `timing` free text is what the system actually stores (§3.3).
3. **"duplicate-guarded by `addItem`"** — stated as if free. It is a 409 per row and a partial
   failure the UI must report (§5.5).
4. **`RowEditor` reuse** — it is built around a persisted row and cannot take a parsed one unaltered
   (§5.4).

## 9. Open before building

1. **Real examples of what gets pasted.** Decides how much pass 1 catches and how often pass 2 runs.
2. **Are stops and pauses in scope?** "Stop Montair" acts on an existing row rather than creating
   one — a different code path (`decideItem` / stop), and arguably a second phase.
3. **Batch endpoint or sequential POSTs?** (§5.5) — depends on the answer to 1.
