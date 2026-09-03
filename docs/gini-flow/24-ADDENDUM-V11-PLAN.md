# Addendum v1.1 — the four speed and safety changes

**Source:** `docs/Flow-Manage/gini-addendum-mockup.html` and the addendum document itself
(_"GINI FLOW — ADDENDUM v1.1 · Doctor & MO view — four speed/safety changes for Phase 3 · For:
Nikhil · From: Gurjot · Aug 2026"_).

The addendum's own statement of intent: **"Dr. Bhansali's consult should take 30 seconds for a
stable patient and 3–4 minutes for a complex one."** Everything below is judged against that.

It is read together with the main brief. Nothing else in the brief changes — this changes what
Phase 3 builds, plus one Phase 2 item (allergies).

**One file rather than four.** Changes ③a and ③b are the same feature seen from two ends, and ④'s
three items share a single owner (`finalize.js`). Splitting them would separate decisions from the
code they decide.

---

## 0. What is already true

Checked against the working tree and the production database, not assumed.

| #   | Change                                 | Status                         | Evidence                                                                                                                              |
| --- | -------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| ①   | Prescription opens pre-seeded          | **half built**                 | `seedDraftFromRegimen()` exists (`prescription.js:167`) but sits behind a _"Start from current regimen"_ button (`RxSection.jsx:466`) |
| ②   | Fast path for green patients           | **not built**                  | nothing matches in Gini Flow; the `fast-path` hits in `sync.js` are unrelated HealthRay enrichment flags                              |
| ③   | MO pre-drafts, doctor reviews a diff   | **built on a different model** | a separate `giniflow_rx_proposals` table + free-text `giniflow_sd_notes`, not draft rows                                              |
| ④a  | Allergies visible everywhere           | **blocked**                    | no allergy column on `patients`; `moStation.js:320` returns `allergies: null` deliberately                                            |
| ④b  | Interaction check across the full list | **blocked**                    | `external_doctor` is set on **0 of 124,640** active medications                                                                       |
| ④c  | Prescription PDF in the fan-out        | **not wired**                  | `finalize.js` generates none, but `generatePrescriptionPdf()` exists and made 3,606 PDFs in 30 days                                   |

### 0.1 The numbers that decide the order

The addendum makes one statistical claim. It is roughly right, and a second number matters more:

|                                                  | Measured                                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| _"Roughly a third of the day is green-category"_ | **27.7%** are `in_control` (75 of 271 categorised visits, last 30 days)                           |
| …but                                             | **31.7% carry no category at all** — so ②'s reach is capped by triage coverage, not by the button |
| Patients arriving with a regimen to copy         | **400 of 438** visits last week, averaging **7.2 active medicines**                               |
| Proposals written with the current model, ever   | **1** (rejected). MO plans: **2**. Draft rx items: **29**                                         |

**The strongest case is ①, not ②.** Pre-seeding touches 91% of visits; the fast path touches 28%.
And ③'s model can be changed for free today — after adoption it cannot.

---

## 1. Who each change is for

Capabilities are the existing ones in `shared/permissions.js`; none of this needs a new capability.

| Change          | Role                                                                                                                                                       | Screen                                       |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| ① pre-seed      | consultant                                                                                                                                                 | `/giniflow/station/doctor/:visitId` § `s-rx` |
| ② fast path     | consultant (`GINIFLOW_STATION_DOCTOR` is held by `consultant` alone)                                                                                       | same page, a bar above `s-proposals`         |
| ③ MO pre-drafts | **written by** mo · consultant · coordinator (`GINIFLOW_STATION_MO`) at `/giniflow/station/mo`; **reviewed by** consultant at § `s-proposals` and § `s-rx` | two screens                                  |
| ④a allergies    | **everyone** with `GINIFLOW_VIEW` — consultant, mo, nurse, lab, tech, reception, coordinator, pharmacy                                                     | every station's patient header               |
| ④b interactions | consultant                                                                                                                                                 | finalize bar                                 |
| ④c PDF          | consultant writes it; **pharmacy** prints it                                                                                                               | finalize fan-out                             |

④a is the only one that reaches every role, which is why the addendum phases it earliest.

---

## 2. Change ① — the prescription opens pre-seeded

### 2.1 What changes

The draft is cloned from the last finalized prescription **when the consultant claims the patient**,
every row `change_type = 'continued'`. The doctor touches only the lines that change. The
_"Start from current regimen"_ button and the `rx-seed` empty state are removed.

### 2.2 Where the seeding call belongs — and where it must not

**In `startConsult()`, not in `getDraft()`.**

`getDraft` is a GET, polled by the screen. Seeding there would make a read mutate, and two polls
arriving together would race to create two drafts. `startConsult` is already the explicit write that
claims the room, runs in a transaction, and happens exactly once per visit.

### 2.3 The blocker to clear first

**`seedDraftFromRegimen` cannot join an open transaction as it stands.** It opens its own
(`prescription.js:168-170`):

```js
export async function seedDraftFromRegimen(visitId, db = pool) {
  const client = await db.connect();     // ← a client has no .connect()
  await client.query("BEGIN");           // ← and this would nest
```

Passing `startConsult`'s client throws; passing `pool` opens a second connection whose COMMIT is
independent — so the draft could commit while the claim rolls back, leaving a seeded prescription
on a patient nobody claimed.

**Split it, do not call it as-is:**

```js
// The work, on a caller's client and inside the caller's transaction.
async function seedDraftOn(client, visitId) { … }        // no BEGIN/COMMIT

// The public entry the route still uses, unchanged from outside.
export async function seedDraftFromRegimen(visitId, db = pool) {
  const client = await db.connect();
  try { await client.query("BEGIN"); const r = await seedDraftOn(client, visitId);
        await client.query("COMMIT"); return r; }
  catch (e) { await client.query("ROLLBACK"); throw e; }
  finally { client.release(); }
}
```

The existing "draft already started" guard (`prescription.js:174-177`) moves into `seedDraftOn` and
returns instead of rolling back — a caller's transaction must not be aborted by a no-op.

### 2.4 Steps

1. Split `seedDraftFromRegimen` as above.
2. `startConsult()` calls `seedDraftOn(client, visitId)` inside its existing transaction
   (`doctorStation.js:534`), after the status advance, before COMMIT.
3. `RxSection.jsx` drops the seed button (line 466) and the `activeMedications` empty-state branch.
   The empty state becomes what it should always have meant: **this patient is on nothing**.
4. `getDraft` keeps returning `activeMedications` — the brief pane still reads it.

### 2.5 Built — 2026-09-03

`seedDraftOn(client, visitId)` split out as §2.3 specifies; `seedDraftFromRegimen` kept as the
standalone wrapper so the route is unchanged. `startConsult` calls it inside the claim transaction
and returns `{ started, seeded }`. `RxSection` lost the button, and its empty state now means what
it says.

**It surfaced a defect worth more than the change itself.** With drafts built by hand, adding a
medicine the patient was already on was unlikely. With every draft opening full, it is routine —
and `addItem` allowed it, so a consultant adding a duplicate would finalize **two prescriptions for
the same drug**. `addItem` now refuses a medicine already in the draft, matched on the pharmacy key
the dispensing counter reads, and points at the row to edit instead. The smoke suite caught this by
finalizing a patient into two MONTAIR rows.

### 2.6 What must stay true

- **A finalized visit never re-seeds.** `startConsult` on a finalized visit is already refused.
- **Seeding is not prescribing.** Every seeded row is `continued`; nothing reaches `medications`
  until Finalize. The existing atomic fan-out is unchanged.

---

## 3. Change ② — the fast path

### 3.1 The bar

Shown **only** when `category = 'in_control'` and the draft has no pending proposal:

```
⚡ Stable patient — fast path available
Continues all N medicines unchanged · repeats today's panel at next visit ·
next visit 20 Nov 2026 (+3 months, editable) · sends to pharmacy + MHG
                                        [ ✓ Continue all · Repeat panel · Finalize ]
```

**It is an addition, not a replacement** — the full consult renders below it, and the doctor can
scroll into any section. The addendum is explicit about this, and it is what makes the button safe
to press: nothing is hidden behind it.

### 3.2 One endpoint, one transaction

`POST /api/giniflow/stations/doctor/:visitId/fast-finalize`

It must not be four calls from the browser. A network drop between "order tests" and "finalize"
would leave a patient billed for a panel and still in the room.

```
fastPathFinalize(visitId, actorId):
  1. refuse unless category = 'in_control'          409
  2. refuse if any proposal is pending              409   (§4.3)
  3. refuse if the draft is empty                   409   (nothing to continue)
  4. orderTests(visitId, { urgency: "next_visit", tests, actorId })   moStation.js
  5. saveCarePlan(visitId, { nextVisitDate }, actorId)                doctorStation.js:667
  6. finalizeConsult(visitId, actorId)              finalize.js:30 — unchanged
```

Steps 4–6 reuse what exists. **`finalizeConsult` is not forked**: a second finalize path would be a
second answer to "what does finishing a visit mean".

**The same transaction problem as §2.3 applies here** — `orderTests` and `finalizeConsult` each open
their own. Either give each a `…On(client, …)` variant, or accept that the fast path is three
sequential transactions and make the _order_ safe: care plan first (harmless if the rest fails),
tests second, finalize last. Finalizing last means a failure leaves the patient still in the room
with tests ordered, which is recoverable by hand; finalizing first would leave a finished visit with
no follow-up, which is not.

Decide this before writing the endpoint — it is the difference between a rollback and a phone call.

### 3.2b Built — 2026-09-03

`fastPathFinalize(visitId, actorId, db)` in `finalize.js`, wired to
`POST …/doctor/:visitId/fast-finalize` and rendered by `consult/FastPathBar.jsx`.

**Three transactions, in the order §3.2 argued for** — care plan, then tests, then finalize. The
open question is answered by that ordering rather than by machinery: a failure after the care plan
is harmless, a failure after the tests is a phone call, and a finished visit with no follow-up is
neither.

**One correction the tests forced.** `fastPathFinalize` took a `db` and forwarded it to
`finalizeConsult`, which opens its own transaction with `db.connect()` — so passing a client would
have thrown on the last and least reversible step. It now always finalizes on the pool; `db` is for
the reads and the two composable writes only.

**Four refusals, all at the service:**

|                                   |                                                         |
| --------------------------------- | ------------------------------------------------------- |
| not green                         | `409` naming the actual category                        |
| nothing to continue               | `409` — an empty prescription is not a 30-second visit  |
| a proposal still pending          | `409` — §4.3's rule, reached before anything is written |
| already finalized / not called in | inherited from `finalizeConsult`                        |

The bar also hides itself in the last three cases, but the rule is the service's: the button being
absent is not the same as the action being refused.

### 3.3 "Today's panel"

The tests to repeat are the ones this visit already produced results for — read from
`giniflow_lab_orders` for the visit, falling back to the panel matching the patient's diagnoses when
there is no order today. **If neither exists, the bar still finalizes but orders nothing**, and says
so: _"no panel to repeat"_. Ordering a guessed panel would bill a patient for a test nobody chose.

### 3.4 The cap nobody has stated

31.7% of visits carry **no category**. An uncategorised green patient gets no fast path, so this
change's value is bounded by triage coverage. Worth measuring category completeness for a week
before estimating the time saved — the addendum's "largest single time saving" assumes categories
are being set.

---

## 4. Change ③ — the MO pre-drafts, the doctor reviews a diff

### 4.1 The fork, stated plainly

|                             | Built today                             | Addendum                                                                   |
| --------------------------- | --------------------------------------- | -------------------------------------------------------------------------- |
| Where a proposal lives      | separate `giniflow_rx_proposals` row    | a **draft row** in `giniflow_rx_items`                                     |
| What the MO writes          | free-text plan + structured proposal    | the actual prescription, in the same inline editor the doctor uses         |
| What the doctor sees        | a strip above the prescription          | the prescription itself, with purple rows tagged _"Proposed by Dr. Sidhu"_ |
| Finalize with one undecided | **auto-rejects it** (`finalize.js:210`) | **blocked**                                                                |

**Take the addendum's model.** Not because it is newer, but because the current one is unused —
**one proposal ever, two MO plans** — so there is nothing to migrate, and because a diff of the real
prescription is what a senior doctor can review in seconds. A separate list has to be reconciled
against the prescription by hand, which is the work the change exists to remove.

### 4.2 Data model

```sql
-- migrations/2026-09-0X_giniflow_rx_proposed_rows.sql
ALTER TABLE giniflow_rx_items
  ADD COLUMN IF NOT EXISTS proposed_by     INT REFERENCES doctors(id),
  ADD COLUMN IF NOT EXISTS approval_status TEXT
    CHECK (approval_status IN ('pending','approved','adjusted','rejected'));

CREATE INDEX IF NOT EXISTS idx_giniflow_rx_items_pending
  ON giniflow_rx_items (visit_id) WHERE approval_status = 'pending';
```

The addendum writes `proposed_by uuid`; **it is `INT` here** — `doctors.id` is an integer in this
database, and every other actor column (`assigned_sd_id`, `authored_by`, `proposed_by` on the old
table) is `INT REFERENCES doctors(id)`.

`NULL` means "not a proposal" — the doctor's own rows. Only rows the MO created carry `pending`.
The partial index is what makes §4.3's check free on every finalize.

`giniflow_rx_items` already carries `previous_dose`, `change_type` and `stop_reason`, so a proposed
dose change needs no further columns: the row _is_ the diff.

`giniflow_rx_proposals` is **retired, not dropped**: the table stays until the one historical row
is aged out, and nothing new is written to it. Dropping a table to save a migration is how audit
trails disappear.

### 4.3 The rule that matters

**Finalize is refused while any row is `pending`.**

Today `finalize.js:210` does the opposite — it updates every undecided proposal to `rejected` with
_"not decided at consultation"_. A consultant can therefore finalize with the MO's _"TG tripled —
add Fenofibrate"_ unread, and the record will say the doctor rejected it. They never saw it.

The count already exists in the finalize preview (`finalize.js:336`). Nothing acts on it.

```js
// finalize.js:30, before the transaction opens
const {
  rows: [p],
} = await db.query(
  `SELECT count(*)::int AS n FROM giniflow_rx_items
    WHERE visit_id = $1 AND approval_status = 'pending'`,
  [visitId],
);
if (p.n)
  throw Object.assign(new Error(`${p.n} proposal${p.n === 1 ? "" : "s"} still to review`), {
    status: 409,
  });
```

**Placed after the status checks, inside the transaction — not before it.** The first draft of this
plan put it before the transaction opened, for a rollback-free refusal. That was wrong: it made
"you have proposals to review" fire ahead of "this patient is not with you yet", so a consultant
finalizing someone who was never called in was told to review proposals on a patient not in the
room. Nothing is written before this point, so the rollback costs nothing and the errors come out
in the order a person would ask them.

The auto-reject block at `finalize.js:210` is deleted — with the check in place nothing can reach
it — and `proposalsAutoRejected` leaves the result shape, because nothing is auto-rejected any
more.

**Built — 2026-09-03.** `pendingProposalCount()` is the single definition, read by both the guard
and `finalizePreview`, so the number the button shows and the number the rule enforces cannot
disagree. `FinalizeBar.jsx` turns its amber warning into a red blocker and disables the confirm
button with _"N to review"_.

The Finalize button already renders a count; it becomes `disabled` with _"1 proposal to review"_,
which is the mockup's own wording.

### 4.3b Built — 2026-09-03

`migrations/2026-09-03_giniflow_rx_proposed_rows.sql` adds `proposed_by`,
`approval_status`, `decided_by`, `decided_at`, `decision_note` and the partial index.

- **`addItem`** takes `proposedBy`; a row with one is `pending`, a row without is the doctor's own.
- **`updateItem`** marks a `pending` row `adjusted` — editing a proposal _is_ the Adjust decision,
  and recording it as "approved as proposed" would be false.
- **`decideItem`** carries Approve and Reject. A rejection needs a reason. **Rejecting a proposed
  addition deletes the row**, because there is no previous line to revert to — the patient was never
  on it. Rejecting a proposed _change_ keeps the row and records the decision.
- **`pendingProposalCount`** counts both models while the old table is retired. Counting only the
  new one would let the pre-existing rows through silently, which is the failure §4.3 exists to
  prevent.
- **Routes**: `POST …/doctor/prescription/items/:itemId/decide`, and MO-gated
  `GET/POST …/mo/:visitId/prescription[/items]` which set `proposedBy` from the session.

**The gate encodes the intent, not a client flag.** A row added at the MO station is a proposal
because of _which route wrote it_; a consultant's row and an MO's row must not be distinguishable
only by something the browser can set.

### 4.4 The MO's screen

`/giniflow/station/mo` gains the inline row editor from `RxSection` — the same component, not a
second one. The MO's edits write `giniflow_rx_items` with `proposed_by = <them>` and
`approval_status = 'pending'`. **"Ready for the doctor" continues to require a plan**: the plan
textarea stays for reasoning that is not a medicine change.

### 4.4b Built — 2026-09-03

The MO station renders **the same `RxSection`**, passed `station="mo"`, which routes its writes
through the MO gate so every row it adds is a proposal. The hooks take the station; the query key
does not, so the MO and the consultant read one cache entry and cannot hold different pictures of
the same draft.

**Deciding is not offered at the MO station.** The approve and reject buttons are gated on
`!proposing` — the person who proposed a change must not be the one who approves it.

The plan textarea stays, as §4.4 said it would: reasoning that is not a medicine change still has to
go somewhere.

### 4.5 The doctor's screen

Purple rows inline in `s-rx`, tagged with the proposer's name, each with **Approve · Adjust ·
Reject**:

- **Approve** → `approval_status = 'approved'`, the row stands
- **Adjust** → opens the existing inline editor; saving sets `'adjusted'`
- **Reject** → reverts the row to last visit's line, `'rejected'`, **reason required** (already
  enforced by `decideProposal`)

`ProposalsStrip.jsx` becomes a **summary that scrolls to the rows**, not a second place to act. Two
places to approve the same thing is how two people approve it twice.

**Built — 2026-09-03, as two things at once.** It counts the new draft-row proposals and offers one
button, _"Review in the prescription →"_, which scrolls to `s-rx`. It keeps its own Approve / Adjust
/ Reject **only for the old `giniflow_rx_proposals` rows**, because those still exist on real visits
and this is the only place they can be cleared — and finalize now blocks until they are. The strip
disappears when both are empty, and its old half can be deleted once the table is.

---

## 5. Change ④ — safety and legal

Three items with three different blockers. They are not one piece of work.

### 5.1 ④a Allergies — a migration, and a harder question

```sql
ALTER TABLE patients ADD COLUMN allergies TEXT[];
```

Rendered as a red strip in the patient header on **every** screen, for every role.

**The only allergy columns in the entire database today are `giniflow_referrals.allergy_status` and
`allergy_note`** — new, and holding zero rows. Nothing else records an allergy anywhere.

`moStation.js:320` returns `allergies: null` on purpose so the strip reads _"not recorded anywhere —
ask the patient"_ rather than _"none"_. **That honesty must survive the migration**: an empty array
means "asked, none", `NULL` means "never asked", and the strip must say which. Rendering "No known
allergies" for a patient nobody asked is the most dangerous string this system could print.

**The code is the easy half.** The real work is deciding who asks and when — reception at check-in,
or vitals. Until that is answered the column will be empty and the strip will keep saying the same
thing it says now.

#### Built, 2026-09-03 — the answer came out of the existing flow

**Who asks today: nobody.** The question was asked of the code, not of a meeting. `patients` had no
allergy column at all; the only allergy fields in the database were `giniflow_referrals.allergy_status`
and `allergy_note`, written by `ReferralForm.jsx` — the one screen in the system that already asks,
and only for the small number of patients being referred out.

**So the model was lifted from there rather than invented**, into `shared/giniflowAllergy.js`:
`ALLERGY_NOT_ASKED` / `none_known` / `known`, with `allergyLine()` so the same patient is never
described two ways on two screens.

**Asked at vitals**, not at reception. Reception is a desk with a queue behind it and the patient
still standing; vitals is the first station that sits them down, already asks them questions, and
already types into a form. The MO is too late — the brief is read there, not filled in.

- `server/migrations/2026-09-03_patient_allergies.sql` — `allergy_status` (CHECK against the three
  states), `allergy_note`, `allergy_asked_at`, `allergy_asked_by` on `patients`.
- `vitalsStation.js` → `saveAllergy(visitId, {status, note, actorId})`, route
  `POST /giniflow/stations/vitals/:visitId/allergy` behind the existing `vitalsGate`.
- `VitalsStationPage.jsx` — three buttons above the readings, plus a name-it field for `known`.
- `moStation.js:324` no longer returns the hardcoded `allergies: null`; it returns the recorded
  answer, resolving NULL to `not_known` **on the server**, so no screen has to decide what an
  absent answer means.

**Two rules are enforced in the service, not the form**, because a form is not a rule:

1. `known` without a name is a 400 — a red strip that cannot say what the allergy is helps nobody.
2. **`not_known` can never overwrite a recorded allergy.** A nurse tabbing past the control must not
   erase what somebody was told last month. This is the check that matters most, and
   `smoke-giniflow-vitals.mjs` asserts it explicitly.

**What is still true:** the column is empty for every existing patient, so the strip goes on saying
"not recorded anywhere — ask the patient" until the floor starts answering. That is the honest
state, not a gap.

### 5.2 ④b Interaction check — blocked on data, not logic

The addendum wants the check to run across the **full combined list**: Gini prescription **plus**
external medicines. Severe blocks finalize; moderate warns.

**`external_doctor` is set on 0 of 124,640 active medications.** The combined list does not exist.
Plan 14 §3 records the same thing: no `external_medicines` table, specified for Phase 3 in the brief.

**Do not build the check first.** Running it over Gini medicines alone and reporting "no
interactions" for a patient on Ramipril from another hospital is worse than the current honest
_"interaction not checked"_ — it converts an absence of information into a false assurance.

Order: capture external medicines → then the check. The capture UI belongs on the MO station, where
the addendum already puts the question.

#### Built, 2026-09-03 — the capture half, and what was already there

**Where external medicines get captured today: `AddMedicationModal.jsx:201`** — a `med_group`
dropdown in Scribe with an "external" option, behind the consultation wizard. It is reachable, and
it is not reached: `med_group = 'external'` is set on **0 of 181,068** medication rows. The capture
exists; the place it lives is not on the path anyone walks.

**The service existed too.** `prescription.js:551` `addExternal()` — specialty, hospital, condition,
`interaction_flag`, upserting on the patient + medicine so re-entering a drug corrects it instead of
duplicating it — with a route, a Zod schema and a `useAddExternal` hook already wired. An earlier
pass here wrote a second `addExternalMedicine`; it was deleted and the MO route repointed at the
existing one. **Nothing new was written on the server for this.**

- MO route `POST /giniflow/stations/mo/:visitId/external-medicines` → the existing `addExternal`.
- `ExternalMedicineForm` in `RxSection.jsx` — which serves both stations, because the MO renders the
  same component the consultant does.
- `getDraft()` already returns externals as a separate `external` list (`external_doctor IS NOT
NULL`), so an outside drug appears beside the regimen without ever joining the list this clinic is
  prescribing. `smoke-giniflow-mo.mjs` asserts both halves of that.

#### Built, 2026-09-03 — the check itself

`server/services/giniflow/interactions.js`, over the combined list: the prescription being written
plus every medicine another hospital started. The patient's existing Gini regimen is deliberately
not added on top — the seeded draft already contains those rows, and counting them twice would
report every continued medicine as a duplication.

**It runs on drug CLASSES, not molecules**, because that is what this database knows:
`medications.composition` is populated on **74 of 124,708** active rows, while a class can be
resolved for most of the list. Class is also the axis the brief's own example lives on — "dual
antiplatelet" is a class statement.

**Rules are a table, not code** (`giniflow_interaction_rules`, 40 seeded rows). They are clinical
content: a doctor has to be able to read the list, disagree with a row and change it without a
deploy. `class_a = class_b` is a duplication rule; anything else is a pair. Every note says what to
do, not just that something is wrong.

**Severe stops the finalize; moderate warns** — with an override, and the override is the design
decision worth arguing with. A hard block would be wrong: dual antiplatelet after a stent and an MRA
with an ACE inhibitor in heart failure are exactly the combinations this check is best at spotting,
and both are things a cardiologist means. A stop that cannot be passed gets worked around, and then
it protects nobody. So the way past is a recorded reason (`giniflow_interaction_acks`), which is the
sentence the whole check exists to produce. Both routes into finalize are gated, the fast path
included — it is the one that finalizes without anybody reading a screen.

**Three sources for a medicine's class, in order of how much they can be trusted:** the curated
reference tables (`drug_master`, `mhg_drug_formulary`), then a majority vote over every row the
database holds for that brand, then the label on the row itself.

That order was learned the hard way, on real data. `medications.drug_class` is per-row and wrong in
places: **"TAB EMPHA M" — a metformin combination — is filed as `Antiplatelet`**, and "TAB PREGEB
NT" with it. Trusting the row made the check report dual antiplatelet on a real patient,
**Prabhjot Kaur**, and block her finalize. A false severe finding is not a small bug: it stops the
consultation and teaches the consultant that the warnings are wrong. The majority vote fixes it —
"Empha" is a biguanide on dozens of rows and an antiplatelet on two — and `smoke-giniflow-
interactions.mjs` pins that exact pair so it cannot come back. "Other" is excluded from the vote, a
bucket being the other way a wrong class wins.

**The honesty rule is enforced, not just documented.** A medicine whose class cannot be resolved is
returned by name in `unchecked`, and the result reads `partial`, never `clear`. The panel prints
those names, the finalize panel repeats them, and no screen may render a partial check as a clean
one. Noise is controlled from the same principle: two supplements or two antibiotics are not a
finding, because a warning nobody needs is how people learn to click past the ones they do.

**Where it shows:** `InteractionPanel.jsx` inside `RxSection` — which means the MO sees it too, on
the same component. The MO cannot override: they assemble the list and can still fix it, but signing
off on a severe interaction is the consultant's.

**Measured before shipping:** across every real visit with a draft, no finalize is blocked today,
after the mislabelling fix. The rules and the resolution can be re-measured any time with
`smoke:giniflow-interactions`.

### 5.3 ④c Prescription PDF — **already built; the registration number was not**

**Correction, 2026-09-03.** This section said `finalize.js` generates no PDF. It does — at
`finalize.js:307`, added for CS-03, calling `buildVisitPayloadFromDb` + `savePrescriptionForVisit`
after the fan-out, fire-and-forget. The review missed it because the call is not named "pdf".
Verified on real data: prescriptions with `source: 'visit'` and a `storage_path`, on Gini Flow
visits finalized yesterday.

What was genuinely missing is the half the addendum actually names as a legal gap: **the
registration number never reached the template.** `buildVisitPayloadFromDb` built its doctor as
`{ name }` alone, so the footer's `doctor.reg_no ? "Reg. No. …" : ""` always rendered nothing.

**Fixed:** the payload now matches the appointment's consultant name against the roster and carries
`reg_no` (from `doctors.license_no`) and `designation` (from `specialty`). Exact match, active
clinicians only — a near-miss would print somebody else's licence, which is worse than printing
none.

**It still prints nothing, because `doctors.license_no` is empty for all 40 active consultants.**
The wiring works the moment a number exists: proven in a rolled-back transaction, the footer renders
`Reg. No. PMC-2019-44871 · Date: 3 September 2026`.

**Do not make the PDF refuse to print without one.** An earlier draft of this plan (§8) proposed
that. It would stop every prescription in the hospital today — the Scribe flow produces ~3,600 a
month through the same template. Filling in the licence numbers is the fix; refusing to print is a
way to notice they are missing that costs more than the problem.

### 5.3b What the original §5.3 proposed, and why it was not needed

`finalize.js` generates no PDF. But `server/services/prescriptionHtmlPdf.js` exports
`generatePrescriptionPdf()` and `renderHtmlToPdf()`, and the Scribe consultation flow produced
**3,606 prescription PDFs in the last 30 days**. The capability is proven at volume.

Steps:

1. A template with **hospital letterhead, the doctor's registration number, a signature line**, all
   medicines with timing, the tests ordered and the next visit date — the addendum lists exactly
   these.
2. `finalizeConsult` calls it after the fan-out commits, **not inside the transaction**: a PDF
   failure must not roll back a finalized consultation.
3. Store as a `documents` row exactly as `prescriptionAutoSave.js:160` does —
   `(patient_id, consultation_id, doc_type, title, file_name, doc_date, source, notes,
extracted_data)` with `doc_type = 'prescription'`. It then appears in the Labs tab's Reports list
   and opens in `PdfViewerModal` like every other document, with no new viewer.
4. Pharmacy prints from there.

**Upload before insert.** The bytes go to Supabase storage (the path `prescriptionAutoSave` already
uses) and the row records `storage_path`; a `documents` row pointing at a file that failed to upload
is a broken link in the Reports list.

---

## 6. Build order, and why

_Item 3 turned out to be mostly done — see §5.3. What remained was the registration number, now
wired._

1. **④.3 — Finalize blocks on pending proposals.** Ten lines. Removes a path that records a
   rejection the doctor never made. Correct under either data model, so it does not wait on §4.1.
2. **① — auto-seed in `startConsult`.** The function exists; it touches 91% of visits.
3. **④c — PDF at finalize.** Generator exists and is proven at 3,606/month.
4. **③ — the proposals model.** Free to change now (one row of history), expensive after adoption.
5. **② — fast path.** The largest build. Measure category completeness first.
6. **④a, ④b — allergies and interactions.** Both blocked on data capture. These need a decision
   about who asks the patient, not an implementation.

**Two are nearly free, two are decisions rather than code, and two are blocked on data that does not
exist.** Only ② is a large build.

---

## 7. Smoke coverage

Added to `server/scripts/smoke-giniflow-doctor.mjs` unless noted.

| Rule | Check                                                                                                          |
| ---- | -------------------------------------------------------------------------------------------------------------- |
| ①    | claiming a patient with an active regimen leaves a draft of `continued` rows                                   |
| ①    | claiming twice does not double the draft                                                                       |
| ①    | a patient on nothing gets an empty draft, not an error                                                         |
| ②    | the fast path is refused for a non-green patient (409)                                                         |
| ②    | it orders the panel at `next_visit`, sets the follow-up, and finalizes — in one transaction                    |
| ②    | forcing a failure mid-way leaves **nothing** written (the finalize suite's existing atomicity check, extended) |
| ③    | an MO edit lands as a `pending` row attributed to them                                                         |
| ③    | **finalize is refused while a row is pending**, and the message names the count                                |
| ③    | approve / adjust / reject each move the row out of `pending`; reject without a reason is refused               |
| ④c   | finalizing produces a `documents` row of `doc_type = 'prescription'`                                           |
| ④c   | a PDF failure does not roll back the finalize                                                                  |

---

## 8. Open — answer before building the item, not before the plan

1. **Who asks the patient about allergies, and where?** (④a) Blocks the only change that reaches
   every role.
2. **Is category being set often enough for the fast path to pay?** (②) 31.7% uncategorised today.
3. **Where do external medicines get captured?** (④b) Without them the interaction check is a
   false assurance.
4. **Does the MO keep the free-text plan once they edit the draft directly?** (③) This plan says
   yes — reasoning that is not a medicine change still has to go somewhere.
5. **Signature line: typed name, or a stored signature image?** (④c) A prescription PDF with a
   drawn signature is a different legal artefact from one with a printed name.
6. **Who fills in the registration numbers?** (④c) `doctors.license_no` **exists** — no migration
   needed — but it is empty for **all 40 active consultants**, including Dr. Bhansali. The PDF
   cannot be a legal prescription without one, so this is a data-entry task with a named owner, not
   a code change. The template must render the number when present and **refuse to print** when it
   is not, rather than emitting a prescription that looks official and is not.
7. **Does the fast path run as three transactions or one?** (§3.2) Decide before the endpoint is
   written.
