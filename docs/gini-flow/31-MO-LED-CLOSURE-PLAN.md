# MO-led closure — the consultant becomes a referral, not a station

- Proposed: 7 Sep 2026
- Supersedes nothing; extends `08-MO-SD-STATION-PLAN.md` (§6 rule 3, the Close action)
- Pairs with `26-RX-EXPLAIN-STATION-PLAN.md` (where an MO-closed patient goes next)
- Migration: **one** (a nullable column + a status), see §6

## 1. The flow asked for

> MO/SD meets the patient and orders labs → the patient shows on the MO's own pending list as
> being at the lab → when the reports are done the MO is notified automatically → the MO reviews
> the reports in full → if everything is normal the MO writes the prescription and the visit ends
> there; only if the patient needs the senior doctor is it forwarded to them.

Stated as a rule: **the consultant stops being a compulsory station and becomes a referral the MO
makes.** Everything below follows from that one sentence.

## 2. What already exists

Most of this is built. Checked against the code, not assumed.

| piece                                       | where                                           | state                                                                |
| ------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------- |
| MO orders tests                             | `moStation.orderTests`                          | shipped — creates the lab order reception charges against            |
| "at the lab" pending list                   | `groupOf` → `awaitingResults`                   | shipped — `🔵 Waiting on results`, counted in the header             |
| "no reports at all"                         | `groupOf` → `missingReports`                    | shipped — deliberately separate, different action                    |
| results land → patient becomes actionable   | `advanceSample` trigger 1                       | shipped — `results_status = 'ready'` regroups them to `waitingForMe` |
| MO assembles the prescription               | `POST /stations/mo/:visitId/prescription/items` | shipped — writes `giniflow_rx_items` with `proposedBy`               |
| MO adds an outside hospital's medicine      | `POST …/external-medicines`                     | shipped — same service the consultant uses                           |
| interaction check for what the MO assembled | `GET …/interactions`                            | shipped                                                              |
| MO closes without the consultant            | `moStation.closeWithoutDoctor`                  | shipped — **but see G4, it writes no prescription**                  |
| forward to the consultant                   | `POST …/ready` → `ready_for_doctor`             | shipped                                                              |

So the MO can already order labs, watch for results, assemble a prescription and end the visit.
What they cannot do is end the visit **with that prescription**.

## 3. The gaps

### G1 — "at the lab" does not say where at the lab

`awaitingResults` counts the patient but the card carries no lab stage. The MO cannot tell a sample
not yet drawn from one on the analyser, so "should I wait or chase?" has no answer on the screen.
The data exists (`open_orders`, `open_cases`, and the lab track's own `sample_status`).

### G2 — nothing notifies the MO

When results land the patient silently moves from `🔵 Waiting on results` to `⏳ Waiting for me`.
An MO working another patient sees a counter change if they happen to look. There is no signal.

### G3 — the results event is dead code

`advanceSample` writes `advanceStatus(… toStatus: "results_received" …)` inside a `.catch(() => {})`.
`results_received` is **not in `CHAIN`**, `EXCEPTION_STATUSES` or anywhere else, so every call throws
and is swallowed. The visit log therefore has no event at all for "reports arrived" — which is
exactly the event a notification and the timeline both need.

### G4 — closing without the consultant writes no prescription (the core gap)

`closeWithoutDoctor` advances to `doctor_done` and stops. The medicines the MO assembled stay in
`giniflow_rx_items`, which is a **draft** table — only `finalize.js` converts those rows into
`medications`, and only `finalize` builds the medicine card, the counselling note and the pharmacy's
dispensing list.

So today an MO-closed patient reaches the Rx desk and the pharmacy with **no prescription at all**.
The draft is then deleted the moment anyone finalizes, or simply abandoned. This is the change that
makes the asked-for flow real; the rest is polish around it.

### G5 — the MO cannot finalize, by capability and by status

- `finalize` is mounted behind `doctorGate` = `GINIFLOW_STATION_DOCTOR`, which `ROLES.MO` does not
  hold (`shared/permissions.js`).
- `finalize` refuses any status but `with_doctor` / `ready_for_doctor`. An MO closes from `with_sd`.

Both are deliberate and both have to be opened **narrowly**, not removed.

### G6 — "normal reports" is currently "green category"

`CLOSEABLE_CATEGORY = "in_control"` — only a patient whose markers are all at target may skip the
consultation, and the category is computed from the data, not declared by the MO. The brief says
"if everything is ok, MO can stop here", which is a **judgement the MO makes after reading the
reports**, not a category the system derives. These are not the same rule and §5 has to choose.

## 4. The decisions

### D1 — who may end a visit without the consultant? **Keep a gate, widen it, record the reason.**

Removing the gate entirely would let any patient be sent home without a doctor on an MO's tap. Keeping
`in_control` only is too narrow for the brief: a patient can have one marker off target and still not
need the senior doctor.

Proposal: the visit may be closed by the MO when **the MO records an explicit review of the reports
and states the outcome**. The category stops being the gate and becomes evidence shown beside the
decision. What is stored is the attestation: who reviewed, when, and their finding.

This is auditable in a way the category gate is not — today a green patient can be closed with
nobody having opened a single report.

**DECIDED 7 Sep, against this recommendation: no category block at all.** The MO's recorded review
is the only gate; a red-category patient may be closed here if the MO reviews the reports and calls
them normal. This was put to the owner explicitly with the red block recommended, and the decision
was to trust the MO's judgement. The category is still computed, still shown on the card beside the
decision, and still stored — so a red patient closed by an MO is visible in the record afterwards —
but it does not stop the close.

The paragraph below is the recommendation that was NOT taken, kept because it states the risk the
decision accepts:

> **Red category stays hard-blocked.** A patient whose markers are worse and out of range is the one
> case where "the MO thought it was fine" is not good enough, and the existing code already knows the
> category.

### D2 — does the MO write a real prescription? **Yes, through the same finalize, not a second one.**

A parallel MO prescription path would be a second implementation of atomic save, medicine matching,
the counselling note, the medicine card and the Genie sync. `finalize.js` is 300 lines of exactly
those rules. It gets one new entry condition, not a sibling.

### D3 — what status does an MO-closed visit take? **`doctor_done`, as today.**

It already means "the consultation is over, the prescription exists", and the Rx desk and pharmacy
queues both already start there. Nothing downstream needs to know who ended it — the event's
`actorRole` says that, and the meta already carries `closed_by_sd: true`.

### D4 — notification. **A real event plus a live badge, not a polling toast.**

Fix G3 so "reports arrived" is an actual visit event, then let the existing realtime channel
(`useGiniflowLive`, already on the MO page) surface it. No new infrastructure.

## 5. The changes

### 5.1 `labStation.js` — make the results event real, as an event and not a status

"Reports arrived" is a **fact about** the patient, not a place they moved to. It must not pass
through `advanceStatus` at all — see R1 below for what happens if it does.

`giniflow_visit_events.status` is a plain `TEXT NOT NULL` with no constraint, so the fix is to
replace the failing `advanceStatus` call with a direct insert, in the same transaction as
`results_status = 'ready'`:

```sql
INSERT INTO giniflow_visit_events (visit_id, status, actor_role, actor_id, meta)
VALUES ($1, 'results_received', 'lab', $2, $3)
```

`current_status` is untouched — the patient stays exactly where they are — and the log finally
carries the event the notification and the timeline both need. Nothing is added to `CHAIN` or
`EXCEPTION_STATUSES`, so no sync comparison changes.

### 5.2 `moStation.js` — the review, and the close that prescribes

**New: `reviewReports(visitId, { outcome, note, actorId })`**

- `outcome` ∈ `normal` | `needs_consultant`.
- Writes `giniflow_sd_notes.reports_reviewed_at`, `reports_reviewed_by`, `reports_outcome` (§6).
- Refuses if `results_status !== 'ready'` — there is nothing to have reviewed.
- Refuses if the patient is not the actor's (`assertOwner`, as every other MO action does).

**Changed: `closeWithoutDoctor`**

- Gate becomes: reports reviewed with outcome `normal` **and** category ≠ red, replacing the
  `in_control`-only rule (D1). A visit with no lab orders at all keeps the old category gate — there
  are no reports to review, so the old rule is the only evidence available.
- After the existing plan check, it calls `finalizeConsultation` in the same transaction, so the
  patient cannot reach `doctor_done` without their medicines existing.

### 5.3 `finalize.js` — one new entry condition

```js
if (!["with_doctor", "ready_for_doctor"].includes(visit.current_status)) → 409
```

becomes: also allow `with_sd` **when the caller is an MO closing the visit**. Implemented as an
explicit `closedBySd` option passed by `closeWithoutDoctor`, not by loosening the status list — an
MO must not be able to finalize a patient sitting with the consultant, and a consultant must not
finalize one still at the MO desk. Everything else in finalize is unchanged, including the rule that
undecided proposals block the save.

### 5.4 `permissions.js` — a capability, narrowly

New `GINIFLOW_MO_CLOSE`, granted to `mo` and `admin`. It gates only the two new routes. The MO does
**not** gain `GINIFLOW_STATION_DOCTOR`; they cannot open the consult screen, take a patient from the
consultant's queue, or finalize anyone else's patient.

### 5.5 Routes

- `POST /giniflow/stations/mo/:visitId/review-reports`
- `POST /giniflow/stations/mo/:visitId/close` — existing route, now behind `GINIFLOW_MO_CLOSE` too.

### 5.6 Client — `MoStationPage`

- **G1:** the `awaitingResults` card gains the lab stage it is waiting on ("sample not drawn",
  "at the analyser", "reporting"), from the lab track already joined into the queue row.
- **G2:** when the live channel reports a `results_received` event for a patient in this MO's list,
  the header count flashes and a toast names them — "Reports in for Asha Sharma".
- **Review + decide:** in the patient pane, once results are ready — "📄 Reports reviewed" with two
  outcomes: **Normal — I will prescribe** and **Needs the consultant**. The second one is the
  existing `ready` action, relabelled honestly.
- The Close button's disabled reason becomes the real one ("review the reports first" / "red
  category cannot be closed here"), instead of silently hiding.

## 6. Migration

`server/migrations/2026-09-07_mo_report_review.sql`

```sql
ALTER TABLE giniflow_sd_notes
  ADD COLUMN IF NOT EXISTS reports_reviewed_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reports_reviewed_by  INTEGER REFERENCES doctors(id),
  ADD COLUMN IF NOT EXISTS reports_outcome      TEXT
    CHECK (reports_outcome IN ('normal', 'needs_consultant'));
```

Nullable, no backfill, no default — a visit reviewed before this ships simply has no attestation,
which is the truth about it.

## 7. Verification

**Smoke — extend `smoke-giniflow-mo.mjs`:**

1. close is refused before the reports are reviewed;
2. close is refused for a red-category patient however it was reviewed;
3. review `normal` → close succeeds **and `medications` rows now exist for that visit**;
4. review `needs_consultant` → close is refused, `ready` succeeds;
5. an MO cannot finalize a patient at `with_doctor`;
6. a consultant's finalize on a `with_sd` patient is still refused.

**Regression, because §5.1 touches shared vocabulary:** `smoke:giniflow-sync` (exception revival),
`smoke:giniflow-lab` (the upload trigger), `smoke:giniflow-doctor`, `smoke:giniflow-pharmacy` — the
pharmacy must see an MO-closed patient with a full medicine card, which is the whole point of G4.

**On production, after deploy:** no visit at `doctor_done` with zero active medications for the day.

## 8. Risks

| risk                                                | severity | mitigation                                                                                        |
| --------------------------------------------------- | :------: | ------------------------------------------------------------------------------------------------- |
| An MO prescribes where a consultant was needed      |   high   | Red blocked outright; attestation recorded with name and time; consultant referral is one tap.    |
| A non-chain event confuses the timeline             |   low    | Rendered as a marker via the existing `timestampOnly` flag (R2), never as a step with a duration. |
| Two finalize entry points diverge                   |   med    | There is one `finalize`; the MO path passes a flag, it does not copy the function.                |
| Draft left unfinalized when the MO forwards instead |   low    | Unchanged from today — the consultant inherits the draft, which is the existing design.           |

## 8a. Review findings (7 Sep, against the code)

**R1 — the first draft of §5.1 was wrong, and would have taken patients off the floor.** It proposed
adding `results_received` to `EXCEPTION_STATUSES`. Three things follow from that, all bad:

- `advanceStatus` sets `current_status` to whatever it is given, so the patient's status would
  become `results_received` — a value no station queue and no `BOARD_COLUMNS` entry matches. Every
  patient whose reports landed would **vanish from the board and from every station's list.**
- `canTransition` treats an exception `from` as a free jump to any chain status
  (`isExceptionStatus(from) → return true` when there is no `resumeFrom`). The sync could then move
  that patient anywhere, forwards or backwards, with no chain guard at all.
- `sweepLabOnlyExits` passes `[...EXCEPTION_STATUSES, ...TERMINAL_STATUSES]` as the statuses to
  exclude, so lab-only sweeping would change meaning as a side effect.

§5.1 now writes a plain event row and never touches `current_status`. This is the same shape the
pharmacy sweep and `returnToQueue` already use for facts the chain cannot express.

**R2 — the timeline will render the new event as a step unless told not to.** `getStationTimes` maps
every row in `giniflow_visit_events` into a step and gives it a duration. `results_received` is not a
place the patient stood, so it must render as a dated marker — the `timestampOnly` flag the lab track
already uses — not as a step with minutes against it. Without this, every patient with labs gains a
phantom step holding the whole gap between the report landing and whatever happened next.

**R3 — the close gate has a second entrance.** `closeWithoutDoctor` is reachable by `admin` as well
as `mo` once `GINIFLOW_MO_CLOSE` is granted, and admin overrides ownership everywhere else in this
codebase. The attestation check is therefore written into the **service**, not the route, so an admin
gets the same refusal an MO does. Only the red-category block and the review requirement decide it.

## 9. Signed off, 7 Sep

1. **D1** — the MO's recorded review is the gate. **No category block** (see D1 above); the red-block
   recommendation was declined.
2. Consequently: every category is closeable by the MO once the reports are reviewed as normal.
3. **The MO's prescription is final.** No consultant counter-signature, no review queue.

## 10. Implementation status — done 7 Sep

| change                                                     | state                                                      |
| ---------------------------------------------------------- | ---------------------------------------------------------- |
| migration `2026-09-07_mo_report_review.sql`                | applied to production                                      |
| `results_received` written as an event, not a status       | done — the dead `advanceStatus` call is gone               |
| timeline renders it as a marker (`timestampOnly`)          | done                                                       |
| `GINIFLOW_MO_CLOSE` capability, `mo` + `admin`             | done                                                       |
| `reviewReports()` + `POST …/review-reports`                | done, Zod-validated                                        |
| `closeWithoutDoctor` gates on the review, not the category | done                                                       |
| close now **finalizes** — draft becomes real medicines     | done, the G4 fix                                           |
| `finalize` accepts the MO path from `with_sd` only         | done, sets `closed_by_sd` and attributes events to `mo_sd` |
| MO screen: review block, honest disabled reasons           | done                                                       |
| smoke: 6 new assertions in `smoke-giniflow-mo.mjs`         | passing                                                    |

Two bugs found and fixed while implementing, both caught by the smoke rather than by reading:

- `FOR UPDATE` cannot be applied to the nullable side of an outer join — the close's lock query used
  a `LEFT JOIN` to `giniflow_sd_notes` and threw `0A000` on every call. Rewritten with subselects so
  the row actually locked is the visit.
- An MO-closed visit lands on `rx_pending`, not `doctor_done`, because finalize writes both. The
  smoke asserted the old status. That is the correct new behaviour — an MO-closed patient reaches
  the Prescription Explain desk by the same path a consultant's patient does, because it is the same
  finalize.

## 11. Second pass, 10 Sep — the flow walked end to end

The owner walked the flow step by step and asked whether the patient actually leaves the MO when
labs are ordered. They do not, and three separate things were broken by that one fact.

**G7 — ordering tests left the patient at the MO's desk.** `orderTests` created the order and
changed nothing else: `current_status` stayed `with_sd`. Consequences, all of them fatal to the
asked-for flow:

- **The lab could not draw the sample at all.** `with_sd` is a room, and the lab station now refuses
  to collect from a patient another station has (`assertPatientIsFree`). Ordering a test and leaving
  the patient at the desk deadlocked the visit.
- **The patient never appeared in the MO's own "waiting on results" list.** `groupOf` files
  `with_sd` under "with me"; `awaitingResults` only holds `vitals_done` / `sd_pending`.
- **The desk stayed occupied**, so the MO could not see the next patient — the literal question
  asked.

Fixed: ordering _today's_ tests writes the patient back to `sd_pending` and frees the room, keeping
`assigned_sd_id` so the reports come back to the same MO. Written directly, like `releaseWorkup`,
because `sd_pending` is behind `with_sd` and the chain only moves forwards. A `next_visit` order
changes nothing — the patient is not going to the lab today.

**G1 closed — the card now says where at the lab.** The queue carries the slowest outstanding
order's stage: "paid — sample not drawn yet", "on the analyser", "reporting". A HealthRay-run case
has no Gini order behind it, so it reads "at the hospital lab", which is all this side knows.

**G2 closed — the MO is notified.** The live channel only invalidates queries, so the patient moved
from one list to another with nothing said. The transition itself is now the signal: anyone who was
on the results list and has become actionable raises "🧪 Reports in for <name>".

**Already covered by the typed-results work (32):** values the lab enters by hand are read straight
off `lab_results` onto the MO's order card, so a manually filled form reaches the MO without opening
another screen. Verified, not assumed.

### The flow as it now stands

| step                                    | status                 | verified                                          |
| --------------------------------------- | ---------------------- | ------------------------------------------------- |
| MO opens a patient                      | → `with_sd`            | claim happens on open, refuses another MO's       |
| MO orders today's tests                 | → `sd_pending`         | **new** — room freed, patient still theirs        |
| lab draws the sample                    | unchanged              | now permitted; was blocked by the room guard      |
| MO sees them, with the stage            | `awaitingResults`      | **new** — stage line on the card                  |
| reports land                            | `results_status=ready` | `results_received` event + toast — **new**        |
| MO opens them again                     | → `with_sd`            | typed lab values shown on the order card          |
| MO records the review                   | attestation stored     | `normal` / `needs_consultant`                     |
| **normal** → Close                      | → `rx_pending`         | finalize writes the medicines; consultant skipped |
| **needs consultant** → Ready for doctor | → `ready_for_doctor`   | one-status move, plan required                    |
| consultant finalizes                    | → `rx_pending`         | unchanged                                         |
| Rx explain → pharmacy                   | unchanged              | same desks for both paths                         |
