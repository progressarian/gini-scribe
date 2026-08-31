# Flow Manager — pre-release audit

**Date:** 31 Aug 2026
**Scope:** Tasks 1.0–1.13, Flow Manager only — `docs/gini-flow/`, the three migrations,
`shared/giniflowStatus.js`, `server/{routes,services,scripts}/giniflow*`, `src/pages/giniflow/`,
`src/queries/hooks/useGiniflowBoard.js`, `src/styles/giniflow*.css`, and the RBAC/router wiring.
~2,930 lines.
**Method:** static review against `01-FLOW-MANAGER-PLAN.md` and `docs/gini-flow-manager.html`.
Nothing was executed against the database; no files were changed.

**Findings:** 3 critical · 14 high · 14 medium · 5 low.
Priority-ordered fixes are in `04-ACTION-ITEMS.md`.

---

## 1. Executive summary

The Flow Manager is built end to end: three idempotent migrations, a status vocabulary shared by
client and server, a duration engine, a single-round-trip board query, five read endpoints, a
510-line page with live timers, an SLA drawer, a timeline modal, a 22-visit seeder and a
33-assertion smoke script. Tasks 1.0–1.4 and 1.6–1.12 are genuinely done to the level the plan
describes. Tasks 1.5 (hostname) and 1.13 (retirement plan) are open and the plan says so.

Three things make it unreleasable as it stands, and all three live in the demo tooling rather than
the board:

- `cleanDemoDay()` deletes _every_ Gini Flow visit for the IST day, not only the seeded ones — and
  `npm run smoke:giniflow` calls it as its first act, against the production database.
- The smoke script writes the SLA table and restores it to a _hardcoded_ 15 minutes, silently
  discarding whatever the coordinator had saved.
- The seeder attaches fabricated clinical state — categories like `worse_out_of_range`, a blood
  pressure of 143/90, "Blocked — reports not uploaded" — to the first 22 _real_ patients by id, and
  the board renders their real names next to it.

Below that sits a second tier of defects a coordinator would see on day one and could not diagnose:
the "Total journey" tile in the footer can never show a number, every card reads "Visit 1", the
"of N booked" denominator counts the whole hospital's appointment list, and two of the three fonts
the design depends on are never loaded.

## 2. Overall assessment

**Good build, not releasable.**

Judged as engineering, this is careful work. The separation decision from `00-OVERVIEW.md` §2.3 is
honoured exactly — nothing reads or writes `flow_*`, and the smoke script asserts it. The
append-only log is real: durations are diffs between consecutive events, computed in one place, and
the timeline reconstructs from the log alone. The IST-day rule is applied consistently, including in
the migration defaults, avoiding the `CURRENT_DATE` bug the plan flags at `server/routes/flow.js:966`.
The unique `(patient_id, visit_date)` constraint is in the schema rather than in application code.
Comments explain _why_, not what.

Judged as a product, it is a demo, and the plan is candid that it is: with no check-in of its own,
the board's only data source is a seeder. That is an accepted cost, not a defect — but it means
"is it ready?" is really two questions. **Is the board correct?** Mostly, with the specific
arithmetic and labelling errors in §9. **Is it safe to run on the floor?** Not until the demo
tooling can no longer delete real rows.

---

## 3. Plan vs implementation

| Task | Requirement                                                                                  | Status       | What exists                                                                                                                          | What is missing or wrong                                                                                                                                                                                        | Pri |
| ---- | -------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| 1.0  | Namespace scaffolding; record what the old coordinator page does that the prototype does not | 🟡 Partial   | All directories and files exist; nothing under `flow_*` touched                                                                      | The "what the old page does better" list (station occupancy, don't-add-more warning, stuck reasons) was never written down anywhere                                                                             | P2  |
| 1.1  | SLA config table, 10 seeded rows                                                             | ✅ Full      | Idempotent migration, `CHECK (budget_minutes > 0)`, `category_overrides` shipped unused as planned                                   | —                                                                                                                                                                                                               | —   |
| 1.2  | Visits + append-only event log                                                               | ✅ Full      | Both tables, unique constraint, both indexes, IST-day default                                                                        | Nothing blocking. No `updated_at` trigger; denormalised `current_status` can drift if anything writes events directly (the seeder does)                                                                         | P2  |
| 1.2b | Status vocabulary in `shared/`                                                               | ✅ Full      | Chain, exceptions, lab track, labels, SLA map, board columns, transition rule; `with_vitals` added with the reasoning recorded       | `canTransition` permits arbitrary forward jumps, which the plan asked it to reject (GF-15)                                                                                                                      | P1  |
| 1.2c | Visit sequence number, computed not stored                                                   | ⚠️ Wrong     | Window count over `giniflow_visits`                                                                                                  | That table was created today, so every patient reads "Visit 1". The prototype's "Visit 19" needs the patient's real history (GF-05)                                                                             | P1  |
| 1.2d | Read-only lab orders so the Lab track has data                                               | 🟡 Partial   | Both tables, correct FKs, header comment distinguishing them from `lab_requests`/`lab_test_requests`                                 | No event log for the lab track, so its timer reads `updated_at` and its durations are not reconstructible (GF-12)                                                                                               | P1  |
| 1.3  | Status engine: `advanceStatus`, `getStationTimes`, board, bottleneck, stats, averages        | 🟡 Partial   | All six functions; single-round-trip board query with lateral joins; wait/station pairing with worst-of-two colouring                | `advanceStatus` is called by nothing in the product. Station averages can never produce `lab_total`, `reception_payment` or `total_journey` (GF-04, GF-07)                                                      | P1  |
| 1.3  | "14 of 18 booked" from the appointments table                                                | ⚠️ Wrong     | Second query against `appointments` for the day                                                                                      | Counts every appointment for the date — all doctors, including cancelled, no-show and blocked patients (GF-10)                                                                                                  | P1  |
| 1.4  | Capabilities on both sides, route registered in three files                                  | ✅ Full      | `GINIFLOW_VIEW` / `GINIFLOW_SLA_ADMIN`, route-prefix guard, page capability, lazy route, nav entry; `ROLE_HOME` correctly left alone | `verify-rbac.mjs` not run in this review; no test covers the nurse-gets-403 case (GF-28)                                                                                                                        | P2  |
| 1.5  | `flow.ginihealth.com` shell / `brand.js`                                                     | ❌ Missing   | Nothing                                                                                                                              | Open decision, acknowledged in the plan. The board currently renders inside Scribe's shell, so the navy Flow rail sits under Scribe's nav                                                                       | P2  |
| 1.6  | Theme extracted, three font families loaded                                                  | 🟡 Partial   | Tokens lifted verbatim, scoped under `.gf`                                                                                           | JetBrains Mono and Instrument Serif are never loaded, so every timer and the logo silently fall back. `giniflow-theme.css` is imported nowhere and its tokens are duplicated into `giniflow.css` (GF-08, GF-36) | P1  |
| 1.7  | Five read endpoints, Zod validation, `serverTime`                                            | 🟡 Partial   | All five endpoints; `serverTime` present and correctly applied client-side                                                           | No schema block in `server/schemas/index.js` and no `validate.js` use — hand-rolled checks instead, against the repo convention the plan cites (GF-11)                                                          | P1  |
| 1.8  | Rail, stats, bottleneck, columns, cards, footer, states                                      | 🟡 Partial   | All seven regions render; one page-level tick; timestamps recomputed not incremented                                                 | No "Switch role" button; cards omit age/sex/file no/visit number/check-in time; no over-budget hint variant; stale state is a 10px word in the navy bar (GF-06, GF-13, GF-26)                                   | P1  |
| 1.9  | Time-budgets drawer, save recolours with no reload                                           | 🟡 Partial   | Drawer, all 10 rows, teal emphasis, hint box, read-only for roles without the capability, invalidate-on-save                         | No backdrop, no Escape, no focus trap; an emptied field produces a generic 400 with no field-level message (GF-16, GF-25)                                                                                       | P2  |
| 1.10 | Timeline modal with past, current _and_ future steps                                         | 🟡 Partial   | Header, meta line, past/current steps, duration pills, over-budget copy, vitals note, close on ✕ and backdrop                        | Future steps, their "Budget 20m" lines, the journey summary against 90m, and the blocked step's suggested action are all absent (GF-14)                                                                         | P1  |
| 1.11 | Seeder reproducing the prototype, via `advanceStatus`, cleaning exactly its own rows         | 🔴 Incorrect | 22 visits, 178 events, 3 lab orders, realistic actor roles, bulk inserts                                                             | Bypasses `advanceStatus` entirely; clean deletes the whole day; writes fabricated clinical state onto real patients (GF-01, GF-03, GF-04)                                                                       | P0  |
| 1.12 | Smoke script incl. isolation assertion                                                       | 🟡 Partial   | 33 checks, real duration reconstruction, the `flow_*` isolation assertion, the duplicate-visit assertion                             | Destroys the saved SLA budget; deletes the day before it starts; asserts nothing at the HTTP or RBAC layer (GF-02, GF-28)                                                                                       | P0  |
| 1.13 | Retirement plan with names and dates                                                         | ❌ Missing   | The plan's own §1.13 outline                                                                                                         | No names, no dates, no decision on `/visit/:token` links already in patients' hands                                                                                                                             | P2  |

---

## 4. What is good — retain these

### Architecture and data model

- **The event log is genuinely append-only and genuinely the source of truth.** Durations are diffs
  between consecutive rows, computed only in `getStationTimes`, so the card chip, the timeline pill
  and the footer average cannot disagree by construction. This is the correct shape for a system
  whose whole product is elapsed time.
- **The separation from `flow_*` is real and asserted.** No import, no shared table, no bridge — and
  the smoke script fails if a run changes `flow_visits` or `flow_events` counts. That assertion is
  worth more than the ten around it.
- **The one-visit-per-patient-per-day invariant is in the schema.** The plan explains that the old
  module needed two later migrations to add it; putting it in the first migration here is the right
  lesson learned.
- **IST-day handling is consistent** — in the column default, the seeder, the cleaner, the route
  resolver and the smoke script. This is the bug class most likely to make a floor display go blank
  mid-shift, and it was taken seriously.
- **Migrations are additive, idempotent and file-based**, with header comments naming the three
  confusable lab tables so the next person does not merge them. Given `DATABASE_URL` points at
  production, this discipline matters more here than in most repos.
- **One board query.** Lateral joins keep the poll at a fixed cost as the floor fills, rather than
  N+1 per visit every ten seconds.

### Domain logic worth keeping

- **Wait and station budgets judged separately, then the worse colour wins.** Summing them against
  the station budget alone would blame a station for a queue it did not create.
- **Blocked patients excluded from column averages.** A patient stuck on missing reports is not a
  throughput problem, and including them would point the bottleneck banner at the wrong station.
- **A finished visit's clock stops** (`clock = status_since` for terminal statuses), so the Done
  column does not accumulate phantom hours.
- **Consecutive queue statuses accumulate into one wait** rather than the later one replacing the
  earlier, so `checked_in → vitals_pending` does not silently lose the first leg.

### Front end

- **Server-time offset on every timer.** A wall display with a drifting clock would otherwise show
  the whole floor as over budget. The sign of the offset is correct.
- **One `now` in page state, recomputed from timestamps.** Both rules the plan set for an all-day
  display are honoured: no per-card interval, no incrementing counter, so a throttled background tab
  self-corrects on the next tick.
- **`placeholderData: (prev) => prev`** keeps the last good board on screen through a network blip
  instead of blanking the floor's screen.
- **Cards are real `<button>` elements**, per the repo convention, so they are keyboard-reachable
  without extra work.
- **Deterministic avatar colour keyed on patient id**, so a patient does not change colour on every
  refetch.

### Process

- **The plan documents its own deviations.** The `with_vitals` addition is explained in the plan, in
  the shared module and in the chain comment. The status table marks 1.5 and 1.13 as not done rather
  than quietly omitting them. The plan even states the board has not been opened in a browser.
  Honest status reporting is rarer than working code.

---

## 5. What is bad or incorrect

> **The three P0s share one root cause.** Demo tooling was written as if it owned the database. It
> does not — there is one database, it is production, and the only thing currently keeping these
> scripts harmless is that `giniflow_visits` has no real rows in it yet. The day Gini Flow gets its
> own check-in, all three become data-loss bugs without anyone changing a line.

### GF-01 · 🔴 Critical · P0 — `cleanDemoDay()` deletes the entire day, not the demo

`server/services/giniflow/demo.js` — `DELETE FROM giniflow_visits WHERE visit_date = IST today`

`DEMO_MARKER` is defined and written into every seeded event's `meta`, then never used. The delete
is unscoped, and the cascade takes the events and lab orders with it.
`POST /api/giniflow/demo/clean` is exposed in production behind nothing but the admin capability,
and `npm run smoke:giniflow` calls `cleanDemoDay()` as its **first** statement — before it has
seeded anything.

**Scenario:** check-in ships, forty patients are on the floor, someone runs the smoke script to
verify an unrelated change. Every visit and every event for the day is gone, and because the log is
the source of truth there is nothing to reconstruct from.

**Recommendation:** scope the delete to seeded rows — a `giniflow_visits.is_demo` column, or a join
to events carrying the marker — and make the smoke script clean only what it created. Consider
refusing to run the demo routes unless an explicit env flag is set.

### GF-02 · 🔴 Critical · P0 — the smoke script overwrites the coordinator's saved SLA budget

`server/scripts/smoke-giniflow-manager.mjs` — sets `wait_doctor = 60`, then restores a literal `15`

The restore is a hardcoded constant, not the value read before the test. If the coordinator has
tuned "Wait for doctor" to 25 minutes, running the smoke script silently resets it to 15 and
recolours the whole board. Worse, the write is not wrapped in a transaction and the script has no
`finally`: any failing assertion before the restore leaves production sitting at a 60-minute budget,
which turns the bottleneck banner off entirely.

**Recommendation:** read the current value first and restore it in a `finally`, or run the budget
test against an in-memory SLA object passed to `getDayBoard` — which already accepts one, so no
database write is needed at all.

### GF-03 · 🔴 Critical · P0 — the seeder attaches fabricated clinical state to real, named patients

`server/services/giniflow/demo.js` — `pickPatients()` takes the first N rows of `patients` by id

Twenty-two real patients are given a fabricated triage category (`worse_out_of_range`, `in_control`),
a fabricated blood pressure of 143/90 and weight of 116.8 kg in the event meta, and fabricated
blocked reasons — and the board renders their real names, ages and file numbers alongside. Every
role with `GINIFLOW_VIEW` (eight of them, including lab, pharmacy and reception) sees it.

Two distinct harms. Clinically, a coordinator or nurse looking at a red dot next to a real patient's
name has been shown a diagnosis-shaped statement that is invented. For DPDP/GDPR, writing fabricated
health attributes against identified patients in the production record is a data-accuracy problem
regardless of who reads it.

**Recommendation:** seed against dedicated demo patient rows created and deleted by the seeder, or
at minimum gate the demo routes and the seeder on a non-production env flag. If real patients must
be used for a realistic demo, drop the fabricated categories and vitals meta.

### GF-04 · 🟠 High · P1 — `advanceStatus`, the engine the station screens will depend on, is dead code

`server/services/giniflow/statusEngine.js`; bypassed by `demo.js`'s bulk `INSERT … UNNEST`

Plan 1.11 is explicit: "Seed via `advanceStatus` … so the timers, averages and the smoke script's
actor assertions are all real rather than faked." The seeder instead writes events with a raw bulk
insert and sets `current_status` from the journey's last step. The result is that the one write path
in the system is exercised by exactly one smoke assertion (a rejected backwards transition) and never
in a forward direction, and that `current_status` is kept consistent with the log by coincidence
rather than by the engine.

The build's own justification for writing it now — "so the station work has no engine left to
write" — is undermined if the engine has never run.

**Recommendation:** either route the seeder through `advanceStatus` (the bulk-insert performance
concern is real but 178 statements in one transaction can be batched differently), or add
forward-transition assertions to the smoke script covering each hop in the chain, the exception
statuses, and the blocked → recovery path.

### GF-05 · 🟠 High · P1 — every card and timeline reads "Visit 1"

`server/services/giniflow/board.js` — `COUNT(*) FROM giniflow_visits pv WHERE pv.patient_id = … AND pv.visit_date <= …`

The count runs over `giniflow_visits`, a table created on 31 Aug 2026 with no backfill by design.
The prototype's "Visit 19" is the patient's lifetime visit count; this query can only ever return the
number of days Gini Flow itself has seen them, which is 1 for everyone for the foreseeable future.

This is not cosmetic: the visit number is how a doctor gauges whether they are meeting someone for
the first time or the nineteenth, and a board that says "Visit 1" for a fifteen-year patient is
actively misleading.

**Recommendation:** count the patient's real history — the existing `appointments` or visits tables —
or drop the field from the UI until it can be correct. Showing a confidently wrong number is worse
than showing none.

### GF-06 · 🟠 High · P1 — the card drops the identity line the prototype leads with

`src/pages/giniflow/FlowManagerPage.jsx` — `PatientCard`; the API already returns age, sex, fileNo,
visitNumber

The prototype's card subtitle for a checked-in patient is `09:42 check-in · Visit 19`; plan 1.8e
restates it. The implementation renders the status label instead ("Waiting for vitals"), which
duplicates information the column header already carries, and never shows age, sex or file number
anywhere on the board. The data is fetched and discarded.

On a floor where two patients share a first name, the file number is how staff tell them apart.

**Recommendation:** render the prototype's subtitle for queue statuses and keep the activity subtitle
for station statuses (which the code already does correctly). Add the `26M · P_51200` meta line the
prototype shows.

### GF-07 · 🟠 High · P1 — three footer tiles, including the headline "Total journey", can never show a value

`server/services/giniflow/board.js` — `getStationAverages`

The aggregation keys every event through `slaKeyForStatus`, which maps only the seven chain statuses.
`lab_total`, `reception_payment` and `total_journey` have no status that maps to them, so their
entries in `byStation` are never created and the tiles render "—" with a 0%-wide bar, permanently.

The dark total-journey tile is described in the plan as "the headline number" and is the last tile in
the strip, styled to draw the eye. It is dead. The smoke script's check —
`averages.length === sla.length` — passes because it counts rows, not values.

**Recommendation:** compute `total_journey` from completed visits (first `checked_in` to `exited`)
and `lab_total` from the lab orders; either compute `reception_payment` from the lab payment
transition or hide the tile until the reception station exists. Change the smoke assertion to require
a value where one is expected.

### GF-08 · 🟠 High · P1 — two of the three design fonts are never loaded

`index.html` loads Inter only; `--fm` and `--fd` reference JetBrains Mono and Instrument Serif

Plan 1.6 requires the Google Fonts link for all three families. Every mono element — timers, the
clock, the SLA number inputs, the footer figures — falls back to the system monospace, and the
"Gini Flow" wordmark, specified as Instrument Serif italic, falls back to a generic serif. The
failure is silent: nothing errors, the page just does not look like the prototype.

This is also why plan 1.6's done-condition ("pixel-indistinguishable from the prototype") cannot
currently be met, and it compounds with the note that the page has never been opened in a browser.

**Recommendation:** add the two families to the existing `index.html` link, or self-host if the
offline-in-clinic case matters — the plan raises that question and it is still unanswered.

### GF-09 · 🟠 High · P1 — two implementations of the colour rule, and the total-journey one is stale

`FlowManagerPage.jsx` `PatientCard` vs. `budgetColour` in `statusEngine.js`

The card recomputes the amber/red thresholds inline from the live tick, duplicating the server's
`budgetColour` — which plan 1.3 explicitly forbids ("do not compute durations anywhere else"). The
duplication is currently consistent, but it is two places to change.

The concrete bug is `card.totalOver`: it comes from the server and is _not_ recomputed against the
live tick, while `totalMinutes` beside it _is_. So for up to ten seconds a card can display "95m
total" against a 90-minute target in ordinary black type, then jump to red on the next refetch. The
one number the coordinator is watching for lags the number next to it.

**Recommendation:** export one colour function from the shared module and call it from both sides,
and derive `totalOver` from the live total rather than the fetched flag.

### GF-10 · 🟠 High · P1 — "of N booked" counts the whole hospital's day

`server/services/giniflow/board.js` — `getDayStats`

The denominator is `SELECT COUNT(*) FROM appointments WHERE appointment_date = $1` with no filter at
all: every doctor, every clinic, plus the rows whose status is already `cancelled` or `no_show`, plus
blocked patients that the rest of the app excludes via `NOT_BLOCKED`. The tile will read something
like "14 of 180 booked".

The plan called this tile out specifically — "Spell this out or the tile silently reads 14 of 14" —
and the fix went one step too far in the other direction. Note also that
`Math.max(appts.booked, board.cards.length)` quietly hides the case where the appointment query
returns nothing.

**Recommendation:** filter to the doctors and clinic this board covers, exclude cancelled/no-show
from "booked" (they are already separate stat fields), and apply the repo's blocked-patient
exclusion. Surface a real zero rather than masking it with `Math.max`.

### GF-11 · 🟠 High · P1 — no request validation, against the plan and the repo convention

`server/routes/giniflow.js`; no block added to `server/schemas/index.js`

Plan 1.7 requires "a new schema block in `server/schemas/index.js` via `middleware/validate.js`, per
repo convention". Instead: a regex on `?date=` that _silently substitutes today_ when it fails, and
hand-rolled checks on the PATCH body. A coordinator who lands on `?date=2026-08-3` is shown today's
board with no indication that their requested date was ignored — the worst outcome for a screen whose
entire job is to be trusted about time.

**Recommendation:** add the schema block; reject a malformed date with a 400 rather than swapping it.
Also bound how far back a date may be, which the plan left conditional on the query proving slow.

### GF-12 · 🟠 High · P1 — the Lab track breaks the event-log invariant

`giniflow_lab_orders` has no event log; `board.js` reads `o.updated_at` as the timer anchor

Every other column derives from the append-only log; the Lab track derives from a mutable column. Two
consequences. First, any future edit to a lab order — a price correction, adding a test — moves
`updated_at` and visibly resets the patient's lab timer to zero. Second, lab durations are not
reconstructible after the fact, so the 45-minute sample→upload budget can never appear in a day
report or a historical average.

The plan's own framing — "the whole board is reconstructible from the log" — does not hold for one of
its eight columns.

**Recommendation:** add `giniflow_lab_order_events` (or record lab transitions as visit events with a
lab actor role) before the lab station is built. It is cheap now, expensive once the station writes
to it — exactly the risk the plan names in its own Risks section.

### GF-13 · 🟠 High · P1 — the "Switch role" button specified in 1.8f-2 is absent

`FlowManagerPage.jsx` rail — has Day report and Time budgets only

The prototype's rail carries three buttons and the plan describes what the third should do in this
build (a toast listing the roles, explicitly not a link into the old `/flow/*` pages). It was not
built. Minor on its own, but it is one of three plan items dropped without being marked as not-done
in the status table, unlike 1.5 and 1.13 which were.

**Recommendation:** add it as specified, or record it in the status table as deliberately deferred.
The rule the plan sets — "do not ship a dead button" — cuts both ways.

### GF-14 · 🟠 High · P1 — the timeline modal shows only where the patient has been, not where they are going

`FlowManagerPage.jsx` `TimelineModal`; the API returns past + current steps only

Plan 1.10 specifies three dot states — green ✓ done, teal ● current, hollow grey ○ future with dimmed
text — plus "Budget 20m" on future steps and a closing summary against the 90-minute target. Only the
first two exist, because `getStationTimes` maps over recorded events and future steps have no events.
The blocked step's "reason and suggested action" is reduced to a single note appended after the whole
timeline.

The future steps are the part a coordinator uses: they answer "how much longer will this patient be
here?", which is the question the modal is opened to answer.

**Recommendation:** project the remaining chain from `CHAIN` and `STATUS_TO_SLA_KEY` after the current
step, and add the journey summary line. Both are pure functions over data already on the client.

### GF-15 · 🟠 High · P1 — the transition rule permits skipping the entire chain

`shared/giniflowStatus.js` — `canTransition` returns `chainIndex(to) > chainIndex(from)`

Plan 1.3 asks it to "reject a jump that skips the chain unless `toStatus` is an exception status".
Any forward jump is accepted, so `checked_in → exited` is legal and produces a visit with two events,
no station timings, and a total-journey figure that pollutes the day's average with a fabricated
4-minute journey.

Second-order: recovery from `blocked_reports` allows _any_ chain status, including one earlier than
where the patient was, so a blocked patient can be unblocked backwards — the one path around the
no-going-back rule.

**Recommendation:** restrict forward moves to the next chain index (plus an explicit, logged skip
reason where the floor genuinely needs one), and remember the pre-block status so recovery returns
to it.

### GF-16 · 🟠 High · P1 — modal and drawer have no accessibility or keyboard contract

`FlowManagerPage.jsx` — `TimelineModal`, `SlaDrawer`

Neither carries `role="dialog"`/`aria-modal`, neither traps focus, neither closes on Escape, neither
restores focus to the card or button that opened it, and the drawer has no backdrop so the board
behind it stays clickable while it is open. The toast is not an `aria-live` region, so a screen
reader never hears "budgets saved". Column icons and the category dot are bare emoji with no
accessible name — for a colour-blind user the category dot is the _only_ carrier of triage state and
🔴/🟡 differ by hue alone.

**Recommendation:** Escape-to-close and focus restoration are a few lines each and are the
highest-value fixes. Give the category dot a text label or shape, and mark decorative emoji
`aria-hidden`.

### GF-17 · 🟠 High · P1 — no responsive rules anywhere in 806 lines of CSS

`src/styles/giniflow.css` — zero `@media` queries

Eight columns at a 212px minimum plus a six-tile stats strip and a ten-tile footer, all in fixed
horizontal rows. On the wall display this is fine and clearly what it was designed for. On the
coordinator's tablet or phone — the device they actually carry around the floor — the stats strip and
the footer overflow with no wrapping behaviour, and the board becomes a two-axis scroll.

Nothing in the plan says the board must be responsive; nothing says it must not. This is worth a
decision rather than a default.

**Recommendation:** decide the supported devices explicitly. If it is wall-display only, say so and
add a minimum-width notice. If the coordinator will use a tablet, the stats strip and footer need
wrapping and the columns need a narrower breakpoint.

---

## 6. Needs improvement

### Business logic and data handling

**GF-18 · 🟡 Medium · P2 — two incompatible representations of "blocked."**
A visit can be blocked by `current_status = 'blocked_reports'` or by a non-null `blocked_reason` on
any status. The seeder uses the second (blocked patients sit in `checked_in`); the chain, the column
map and `STATUS_TO_SLA_KEY` assume the first; `getDayStats` counts either. Nothing in the codebase
ever _sets_ `blocked_reason`, so the `blocked_reports` status is entirely unexercised, and
`advanceStatus`'s `CASE` that preserves the reason on entry has never run.
**Recommendation:** pick one representation before the station screens are written. The reason column
with a status flag is probably right — it lets a patient be blocked without losing their place in the
chain — but then `blocked_reports` should be removed from the chain rather than left as a second,
contradictory mechanism.

**GF-19 · 🟡 Medium · P2 — a Lab-track card can display the patient's unrelated main-journey hint.**
`PatientCard` swaps only the subtitle and timer for the lab variant; the `blockedReason` and `hint`
strips below still render from the main journey. A lab-track patient who is also blocked on reports
would show "🚫 Blocked — reports not uploaded" under "⚙️ Processing in analyzer". The prototype's own
lab hint ("💰 Waiting: reception payment") is not implemented at all.
**Recommendation:** give the lab card its own hint derivation, or suppress the main-journey strips
when `column === 'lab'`.

**GF-20 · 🟡 Medium · P2 — patients appear twice on the board with nothing saying so.**
A patient with an open lab order renders in both their chain column and the Lab track. That is
correct for a parallel track, but the column counts then sum to more than the floor while "In
building now" counts each person once — two numbers on the same screen that disagree by design, with
no visual cue marking the duplicate.
**Recommendation:** mark the lab card as a secondary view of the same patient, or add a small "also
at" indicator on the primary card.

**GF-21 · 🟡 Medium · P2 — "Within SLA · station transitions" measures neither.**
The tile's sub-label says "station transitions", but the value is the percentage of currently
in-building patients whose _current_ status is not red. It is an instantaneous snapshot of the floor,
not a rate over the day's transitions, and it will swing sharply as one patient tips over a budget.
Two related mislabels: "Over time budget · need attention" counts only in-building cards, and
"Blocked · missing reports / payment" counts only report-blocks since nothing sets a payment block.
**Recommendation:** either compute a true transition-based rate from the closed transitions
`getStationAverages` already reads, or relabel the tile "on time right now".

**GF-22 · 🔵 Low · P3 — dead parameter and a redundant branch.**
`getBottleneck(columns, cards)` never reads `cards`; both call sites pass it. In `canTransition`, the
null-from branch's first clause (`to === CHAIN[0]`) is subsumed by the second (`isChainStatus(to)`).
**Recommendation:** drop both. Small, but a signature that lies about its inputs misleads the next
reader.

### UX and states

**GF-23 · 🟡 Medium · P2 — a stale board announces itself in 10px grey inside the navy bar.**
Plan 1.8g asks for the last good board plus "a stale banner". What ships is the word "Reconnecting…"
replacing "Live · \<date\>" in the rail, in the same small muted style. On a wall display across the
room this is invisible — the board looks live and current while showing data from twenty minutes ago,
which is precisely the failure the plan was guarding against.
**Recommendation:** make staleness unmissable: dim or desaturate the board, and show a full-width
strip with the age of the data ("Data 4 min old — reconnecting"). The live dot should stop pulsing.

**GF-24 · 🟡 Medium · P2 — the timeline modal never refreshes.**
`useGiniflowTimeline` has no `refetchInterval` and its current step's "Since 09:51" is rendered from
the fetch, not the page tick. A modal left open on the wall display — the likely state, since nothing
closes it automatically — freezes at the moment it was opened while the board behind it keeps moving.
**Recommendation:** poll the timeline on the same 10s interval while it is open, and tick its
current-step duration from the page's `now`.

**GF-25 · 🟡 Medium · P2 — the SLA drawer's error path is generic and its blast radius is invisible.**
Clearing a field yields `parseInt("") = NaN`, serialised as `null`, and the server answers with one
message covering all ten rows: "Each budget needs a station and a positive whole number of minutes."
Nothing marks which field. The toast on failure — "Could not save budgets" — explains nothing and
offers no retry. And nothing tells the editor that these budgets are global: changing "Wait for
doctor" recolours the board for every viewer in the building, with only `updated_by` as a name string
for an audit trail.
**Recommendation:** validate per field with inline messages, surface the server's reason in the toast,
and note in the drawer that budgets apply hospital-wide. Consider logging budget changes as events
rather than overwriting a single `updated_by`.

**GF-26 · 🟡 Medium · P2 — the Day report is a toast that cannot be read twice.**
Plan 1.7 defines the endpoint as a one-line summary and the full report as out of scope, which is
fair. But the delivery — a 3-second toast — means the one number a coordinator might want to write
down disappears before they can. The bottleneck banner's "Notify stations" button is honest about
being a stub, which is the right call; the day report is not a stub, it is real data delivered in a
form that discards it.
**Recommendation:** put the summary somewhere persistent — a small panel or the drawer — or keep the
toast but make it dismissible rather than timed.

**GF-27 · 🔵 Low · P3 — column ordering does not put the worst case first.**
Cards sort by last event ascending, so the longest-waiting patient happens to land at the top — but
by accident, not intent, and nothing raises a red-category or over-budget patient above a green one
in a column that scrolls. The bottleneck banner names the longest waiter; the column does not
highlight them.
**Recommendation:** sort explicitly by urgency, and consider marking the patient the banner names.

### Code and repo hygiene

**GF-36 · 🟡 Medium · P2 — `giniflow-theme.css` is dead and its tokens are duplicated.**
The page imports only `giniflow.css`, whose first 38 lines are a byte-for-byte copy of the theme
file's token block. The plan (1.6) and the design-system doc both name `giniflow-theme.css` as the
single place tokens live, and the first thing the next screen will do is import a file that is not
the one in use — then diverge.
**Recommendation:** import the theme file from `giniflow.css` and delete the duplicated block, before
the second screen is written.

**GF-34 · 🔵 Low · P3 — seeded appointment times are malformed strings that Postgres happens to accept.**
`` `0${8 + (i % 4)}:…` `` produces `08:00`, `09:07`, then `010:14` and `011:21` for half the rows.
Postgres's lenient time parser reads these as 10:14 and 11:21, so nothing breaks — today. It is a
latent parse dependency in a field that will one day be compared against appointment data.
**Recommendation:** `String(8 + (i % 4)).padStart(2, "0")`.

**GF-35 · 🔵 Low · P3 — seeder counts are silently approximate.**
`ON CONFLICT (patient_id, visit_date) DO NOTHING … RETURNING` means a patient who already has a visit
today is skipped without a word, the journey keyed to them is dropped, and the returned counts shrink.
The smoke script's column-count assertions (exactly 4 waiting, exactly 2 with doctor) then fail with
no indication that the cause was a pre-existing row rather than a logic bug.
**Recommendation:** report skipped journeys explicitly in the seeder's return value.

---

## 7. Needs design / UX definition

These are not implementation gaps — they are places where no one has decided what the screen should
look like. Listing what needs designing, not designing it.

| Area                       | What needs designing                                                              | States and interactions to cover                                                                                                                    |
| -------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stale / disconnected board | A treatment loud enough to read across a room (GF-23)                             | Fresh · stale (with data age) · fully disconnected · recovered. Does the board dim? Does the live dot change? Is there a sound?                     |
| Empty day                  | The board before the first check-in and after the last exit                       | Currently every column shows a muted "—" and the footer shows ten dashes. What should a coordinator see at 08:00? At 20:00?                         |
| Future timeline steps      | The hollow-dot projected remainder and the journey summary (GF-14)                | Projected · at-risk projection (already over on an earlier step) · blocked with a suggested action · a visit that skipped a step                    |
| Lab track card             | A card variant that is visibly a parallel view, not a duplicate (GF-19, GF-20)    | Payment pending · collected · processing · results ready · uploaded (leaves the column). Test count, urgency, and its own hint line                 |
| The Flow shell             | Task 1.5 — what the product looks like at `flow.ginihealth.com` vs. inside Scribe | Navigation, the role switcher, sign-in, and what a coordinator sees when they have both products                                                    |
| Tablet / phone board       | Whether the board supports anything but a wall display (GF-17)                    | Column collapse or horizontal snap, stats strip wrapping, whether the drawer becomes a sheet                                                        |
| Day report                 | The full report the plan defers — but the toast is not a resting place (GF-26)    | Per-station table, over-SLA list, busiest hours, export. Who reads it and when                                                                      |
| Notify stations            | What the button will actually do once stations exist                              | Which station, what message, delivery channel (MSG91 vs. WATI is still unanswered in the plan), acknowledgement                                     |
| Category vocabulary        | The emoji ⇄ category mapping the plan flags as guessed                            | Five categories, two of which (`worse_in_range`, `getting_better`) currently share the same 🟡 dot and are therefore indistinguishable on the board |

---

## 8. Missing features

| Missing                                                                                        | Requirement                                 | Consequence                                                                | Pri |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------- | --- |
| "Switch role" rail button                                                                      | Plan 1.8f-2                                 | Rail does not match the prototype; no path to the (future) station screens | P1  |
| Future steps + journey summary in the timeline                                                 | Plan 1.10                                   | The modal cannot answer "how much longer?"                                 | P1  |
| Card identity line (age, sex, file no, check-in time, visit no)                                | Plan 1.8e / prototype                       | Staff cannot distinguish same-named patients from the board                | P1  |
| Over-budget card hint ("26m over budget — longest wait")                                       | Prototype line 256                          | The worst card in a column looks like the others apart from a red chip     | P2  |
| Lab hint line ("💰 Waiting: reception payment")                                                | Prototype line 323                          | Lab cards say what stage they are at, not what they are waiting on         | P2  |
| Zod schema block + `validate.js` wiring                                                        | Plan 1.7, repo convention                   | Bad input silently coerced instead of rejected                             | P1  |
| Lab-order event log                                                                            | Implied by the event-sourcing invariant     | Lab durations unreconstructible; timer resets on any row edit              | P1  |
| Demo-scoped cleanup (marker column or equivalent)                                              | Plan 1.11 "removes exactly the seeded rows" | Data loss once real visits exist                                           | P0  |
| HTTP/RBAC coverage in the smoke script                                                         | Plan 1.4 and 1.12 done-conditions           | The 403-for-nurse and capability-prefix guard are unverified               | P1  |
| The `/flow/coordinator` parity list (station occupancy, don't-add-more warning, stuck reasons) | Plan 1.0                                    | Real-floor lessons will be lost when the old page is deleted               | P2  |
| Hostname / brand shell                                                                         | Plan 1.5                                    | Blocked on an open decision; board renders inside Scribe's shell           | P2  |
| Retirement plan with names and dates                                                           | Plan 1.13                                   | Two boards become permanent — the outcome the plan calls the worst one     | P2  |
| Date navigation in the UI                                                                      | Implied — the API takes `?date=`            | Yesterday's board is reachable only by editing the URL                     | P3  |
| Any check-in / write path                                                                      | Explicitly out of scope                     | Correctly deferred — noted so the list is complete                         | —   |

---

## 9. Functional issues and bugs

| ID     | Issue                                        | Scenario                                                                                                                                                         | Sev |
| ------ | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| GF-01  | Unscoped demo delete                         | Smoke script or admin "clean" run on a day with real visits → whole day's floor data destroyed, unrecoverable                                                    | 🔴  |
| GF-02  | SLA budget clobbered by the test             | Coordinator sets wait_doctor to 25 → someone runs the smoke script → budget silently becomes 15, board recolours                                                 | 🔴  |
| GF-02b | Test leaves prod mid-mutation on failure     | An assertion between the two SLA writes throws → production sits at a 60-minute doctor-wait budget, bottleneck banner permanently off                            | 🔴  |
| GF-03  | Fabricated clinical state on real patients   | Any user with GINIFLOW_VIEW opens the board → sees real names with invented triage categories and vitals                                                         | 🔴  |
| GF-05  | Visit number always 1                        | Every card, every timeline, from day one                                                                                                                         | 🟠  |
| GF-07  | Three footer tiles permanently empty         | Every page load; the dark headline tile shows "—" and a 0% bar                                                                                                   | 🟠  |
| GF-09  | Total-journey red styling lags the number    | A patient crosses 90 minutes between refetches → "95m total" renders un-styled for up to 10s                                                                     | 🟠  |
| GF-10  | Booked denominator counts the whole hospital | Every page load once real appointments exist → "14 of 180 booked"                                                                                                | 🟠  |
| GF-11  | Malformed `?date=` silently shows today      | Typed or bookmarked URL with a bad date → wrong day presented as correct                                                                                         | 🟠  |
| GF-12  | Lab timer resets on any lab-order edit       | Lab station adds a test to an order → that patient's 45-min lab clock restarts at 0                                                                              | 🟠  |
| GF-15  | Chain-skipping accepted                      | A station screen (or a bug) advances checked_in → exited → a 4-minute journey pollutes the day's average                                                         | 🟠  |
| GF-19  | Wrong-context hint on a lab card             | A blocked patient with an open lab order → "Blocked — reports not uploaded" under "Processing in analyzer"                                                       | 🟡  |
| GF-24  | Frozen timeline modal                        | Modal left open on the wall display → durations stop advancing while the board behind updates                                                                    | 🟡  |
| GF-28  | Denormalised status can drift from the log   | Anything writing events without `advanceStatus` — which the seeder already does — leaves `current_status` and the log free to disagree                           | 🟡  |
| GF-29  | Backdated event can invert the log           | `advanceStatus` accepts an arbitrary `occurredAt`, including one before the previous event → negative durations clamp to 0 and a step vanishes from the timeline | 🟡  |
| GF-30  | Two categories share one dot                 | `worse_in_range` and `getting_better` both render 🟡 → the board cannot distinguish improving from deteriorating                                                 | 🟡  |
| GF-31  | No column-count guard                        | Nothing warns when a station is over capacity — the old coordinator page's "don't add more" warning was not carried forward                                      | 🔵  |

---

## 10. Requirement gaps

| Gap type                             | Instance                                                                                                                                                                                                                                 |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Requirement exists, no task          | The brief's role list includes `flow_manager` as a distinct role; the mapping to `coordinator` is recorded in the overview but no task verifies that the person actually running the floor holds that role in `doctors.role` today.      |
| Task exists, feature missing         | 1.8f-2 "Switch role" button; 1.7's Zod validation; 1.0's parity list.                                                                                                                                                                    |
| Feature exists, workflow incomplete  | The Lab track renders but has no lifecycle: nothing sets `uploaded`, so a lab order never leaves the column except by the query's `sample_status <> 'uploaded'` filter, which no code path ever satisfies.                               |
| Backend exists, no UI                | `?date=` on both board and day-report endpoints; `results_status` (fetched, only used for one subtitle string); `lifestyle_flagged` (shipped by design); `category_overrides` (shipped by design, described in the drawer as not built). |
| UI exists, no backend                | The footer's `lab_total`, `reception_payment` and `total_journey` tiles (GF-07). "Notify stations" (acknowledged stub).                                                                                                                  |
| Works for one role, not another      | The drawer correctly goes read-only without `GINIFLOW_SLA_ADMIN` — but the "Time budgets" button is identical for both, so six of the eight roles open a drawer they cannot use with no prior indication.                                |
| Happy path only                      | The seeder produces one shaped day. There is no seeded scenario for an empty floor, a 60-patient floor, a same-day duplicate visit, a no-show, a cancellation, or a patient blocked then unblocked.                                      |
| Feature drifted from the requirement | Visit number (GF-05), card subtitle (GF-06), timeline future steps (GF-14), transition strictness (GF-15) — each implemented in a form the plan explicitly described differently.                                                        |
| Decision recorded, never taken       | Overview §3 items 5–7: the hostname, the WATI-vs-MSG91 question, and who signs off parity. All still open; two of them gate work already underway.                                                                                       |

---

## 11. Role and permission gaps

The mechanics are right: new capability keys rather than borrowed `FLOW_*` ones, granted in
`shared/permissions.js`, enforced by the route-prefix table in `server/middleware/auth.js` and the
page map in `src/config/routes.js`, with the write route separately gated by `requireCapability`.
`ROLE_HOME` is correctly left pointing at the old board during the parallel run. Admin inherits
everything through `ALL`.

| Role        | View board | Edit budgets | Seed / clean demo | Assessment                                                                                    |
| ----------- | ---------- | ------------ | ----------------- | --------------------------------------------------------------------------------------------- |
| admin       | ✅         | ✅           | ✅                | Correct                                                                                       |
| coordinator | ✅         | ✅           | —                 | Correct — this is the flow_manager role                                                       |
| consultant  | ✅         | —            | —                 | Correct                                                                                       |
| mo          | ✅         | —            | —                 | Correct                                                                                       |
| nurse       | ✅         | —            | —                 | Correct                                                                                       |
| lab         | ✅         | —            | —                 | ⚠️ Sees every patient's name and triage category, not just their own lab work                 |
| reception   | ✅         | —            | —                 | ⚠️ Same — reception has no `PATIENT_CHART` elsewhere, yet the board shows clinical categories |
| pharmacy    | ✅         | —            | —                 | ⚠️ Same                                                                                       |
| tech        | —          | —            | —                 | Not granted; plan did not list it. Confirm intentional                                        |
| obt, guest  | —          | —            | —                 | Correct                                                                                       |

**The one substantive gap is data minimisation.** The plan grants `GINIFLOW_VIEW` to eight roles, and
the board shows every patient's name, age, sex, file number, triage category and blocked reason. In
the existing app the split between `PATIENT_READ` and `PATIENT_CHART` exists precisely so a
non-clinical role can identify a patient without being shown clinical judgements — the OBT role is
the worked example, and the comment in `permissions.js` spells out the reasoning. The Gini Flow board
reintroduces exactly that exposure through a single coarse capability.

Not necessarily wrong — a floor board arguably needs to show the floor — but it is a decision that
should be taken explicitly and recorded, given the DPDP framing in `CLAUDE.md`. A middle path: show
the category dot only to clinical roles.

Two smaller items: nothing verifies the 403 path (GF-28), and the plan's own done-condition for 1.4 —
running `verify-rbac.mjs` — was not confirmed in this review.

---

## 12. End-to-end workflow

The intended journey is **booked → confirmed → checked in → vitals → SD/MO → doctor → pharmacy →
exit**, with lab and payment as parallel tracks. Walking it end to end:

- **booked / confirmed** — no writer. Visits enter the system only via the seeder. The plan notes
  `POST /api/flow/from-appointment/:id` already exists in the _old_ module and could be reused
  conceptually, but the separation rule forbids reading it, so Gini Flow has no path from a HealthRay
  appointment to a visit. **Broken.**
- **checked in → exited** — every status renders and times correctly, but nothing writes them.
  `advanceStatus` exists and is unused (GF-04). **Read-only by design.**
- **Lab track** — reads correctly from seeded rows; has no writer, no event log, and no exit
  condition that any code satisfies (GF-12, §10). **Incomplete.**
- **Payment track** — `payment_status` exists on lab orders and in the status vocabulary; nothing
  reads it into the board except a passthrough field, and the `reception_payment` budget has no
  measurement. **Not wired.**
- **Exceptions** — `no_show` and `cancelled` are correctly excluded from columns and correctly still
  counted in stats. `blocked_reports` has two competing representations (GF-18). **Partial.**
- **Report / close of day** — one endpoint returning one sentence, delivered as a disappearing toast
  (GF-26). **Minimal.**

The honest summary: **the read half of the journey is complete and the write half does not exist**,
which is exactly what the plan scoped. The workflow gaps above are therefore not defects against this
build — with two exceptions that _are_: the missing appointment→visit path means Gini Flow cannot be
fed even when stations arrive, and the lab track's missing event log will be expensive to retrofit
once the lab station writes to it.

---

## 13. Edge cases

| Scenario                                | Handled? | Notes                                                                                                                                                                                                                 |
| --------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No data / empty day                     | 🟡       | Columns show "—"; footer shows ten dashes; stats show zeros; "Within SLA" reads 100%, which is arguably wrong for an empty floor                                                                                      |
| Duplicate visit, same patient, same day | ✅       | Schema constraint, asserted by the smoke script                                                                                                                                                                       |
| Malformed date input                    | ⚠️       | Silently replaced with today (GF-11)                                                                                                                                                                                  |
| Failed board fetch                      | 🟡       | Last good board retained (good); staleness barely visible (GF-23)                                                                                                                                                     |
| Network blip mid-poll                   | ✅       | `placeholderData` + client-side ticking means the board keeps counting correctly through it                                                                                                                           |
| Background tab throttling               | ✅       | Recomputed from timestamps; `refetchIntervalInBackground: false`                                                                                                                                                      |
| Device clock drift                      | ✅       | `serverTime` offset applied per tick, correct sign                                                                                                                                                                    |
| Midnight / 00:00–05:30 IST window       | ✅       | IST day used consistently, including in defaults                                                                                                                                                                      |
| Day rollover with the tab left open     | ❌       | The query key is the literal string "today" and the date is resolved server-side per request, so at midnight the board silently switches days with no visual transition and the rail's date only changes on re-render |
| Expired session / 401 mid-poll          | ❌       | Not handled in the page; behaviour depends on the shared API client. A wall display left running past token expiry is the likeliest real-world failure and is untested                                                |
| Concurrent budget edits                 | ❌       | Last write wins across all ten rows with no version check; two admins in the drawer silently overwrite each other                                                                                                     |
| Very long patient name                  | ✅       | `text-overflow: ellipsis` on the name                                                                                                                                                                                 |
| Very long blocked reason                | ❌       | No clamp on the `wait4` strip; free text from a future station screen will grow the card unbounded                                                                                                                    |
| Large day (60+ patients)                | 🟡       | Query cost is fine; columns scroll independently, but nothing paginates and the bottleneck average becomes less meaningful as counts grow                                                                             |
| Patient with no events (booked only)    | 🟡       | `journey_started_at` and `status_since` are both null → total renders as null and the card shows "⏱ 0m"; off-board statuses hide it, but a chain status with no events would display 0                                |
| Unauthorized user                       | ✅       | Capability enforced on both sides                                                                                                                                                                                     |
| Deleting a visit with dependencies      | ✅       | `ON DELETE CASCADE` on events and lab orders; smoke script checks for orphans                                                                                                                                         |
| Retry after a failed save               | 🟡       | Drawer stays open on error and can be re-submitted, but the message does not say what failed (GF-25)                                                                                                                  |

---

## 14. Technical and architecture concerns

### Sound decisions

- Event sourcing with a denormalised current status for fast grouping is the right trade, and the
  index supports the one hot query.
- Polling over Supabase Realtime is well argued in overview §2.2 — the RLS and anon-key work is real,
  the transaction pooler makes `LISTEN`/`NOTIFY` a trap, and the client-side tick makes 10s
  indistinguishable from live.
- Routes → services → db separation is respected; the route file is thin.
- Passing `db`/`client` into every service function keeps the transaction boundary at the caller —
  the right shape for the station writes that are coming.

### Concerns

- **Poll cost.** Each board request runs five statements — one of which exists solely to ask Postgres
  for today's IST date, computable in JS. Per open display that is ~30 statements a minute against
  the production pooler, forever. Multiply by the number of wall displays and the coordinator's
  tablet.
- **The board is unbounded by date.** Nothing stops `?date=` reaching arbitrarily far back; the plan
  deferred bounding it, which is fine, but the lateral visit-number subquery scans a patient's whole
  history per row and will not stay cheap.
- **No `updated_at` triggers.** Both `giniflow_visits.updated_at` and `giniflow_lab_orders.updated_at`
  are maintained by application code only — and the lab one doubles as a timer anchor (GF-12).
- **No constraints on vocabulary columns.** Deliberate for `status` (documented, and the reasoning is
  sound), but `category`, `results_status`, `actor_role` and `sample_status` also have no CHECK _and_
  no application-level validation. A typo'd category renders no dot and no error.
- **Demo code ships to production.** `demo.js` is imported by the production route file with no
  environment guard. Admin-gating is not the same as not-in-production.
- **Duplicated tokens and a dead stylesheet** (GF-36) — a small thing that will become a divergence
  the moment a second screen is written.

---

## 15. QA readiness

| Feature                 | State                | What is needed before it counts as done                                                                                                       |
| ----------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Migrations & schema     | 🟢 Ready             | Applied, idempotent, constrained. Nothing outstanding                                                                                         |
| Status vocabulary       | 🟡 Needs improvement | Tighten `canTransition` (GF-15); resolve the two blocked representations (GF-18)                                                              |
| Duration engine         | 🟠 Needs testing     | Well covered for the seeded shape; untested for skipped steps, backdated events, blocked→recovery, and single-event visits                    |
| Board query & columns   | 🟡 Needs improvement | Correct apart from the visit number (GF-05); needs an empty-day and a large-day pass                                                          |
| Stats tiles             | 🔴 Not ready         | Booked denominator wrong (GF-10); "Within SLA" mislabelled (GF-21)                                                                            |
| Bottleneck banner       | 🟢 Ready             | Logic and copy match the plan; hides correctly when null                                                                                      |
| Station footer          | 🔴 Not ready         | Three of ten tiles structurally cannot show a value (GF-07)                                                                                   |
| Patient card            | 🟡 Needs improvement | Missing identity line (GF-06); stale total-over styling (GF-09); lab variant leaks main-journey hints (GF-19)                                 |
| SLA drawer              | 🟡 Needs improvement | Works; needs keyboard handling, field-level errors, concurrency thought (GF-16, GF-25)                                                        |
| Timeline modal          | 🟠 Needs testing     | Future steps missing (GF-14); never refreshes (GF-24); no keyboard contract (GF-16)                                                           |
| Theme & visual fidelity | 🔴 Not ready         | Two fonts unloaded (GF-08); the page has never been opened in a browser, so plan 1.8's "side by side with the prototype" check is unperformed |
| Demo seeder             | 🔴 Not ready         | GF-01, GF-03, GF-04                                                                                                                           |
| Smoke script            | 🔴 Not ready         | GF-02; no HTTP or RBAC coverage                                                                                                               |
| RBAC wiring             | 🟠 Needs testing     | Correct by inspection; run `verify-rbac.mjs` and add a 403 assertion                                                                          |

**The largest testing gap is not a missing assertion — it is that nobody has looked at the screen.**
The plan states the page has only been verified through `npm run build` and its API. Every visual
done-condition in tasks 1.6, 1.8, 1.9 and 1.10 is written as a side-by-side comparison with the
prototype, and none of them has been performed. GF-08 (unloaded fonts) is the kind of defect that
survives exactly this gap.

---

## 16. Security and performance

### Security

- **Good:** every query is parameterised; no string interpolation into SQL anywhere in the module.
  Auth is the app's existing JWT + capability system, not a bespoke path. The write route is doubly
  gated (prefix table plus `requireCapability`). The plan explicitly warns against rendering the old
  module's `visit_token` in a UI label, and nothing does.
- **Data minimisation (P1):** eight roles see every patient's identity plus clinical category — see
  §11. Worth an explicit, recorded decision under DPDP.
- **Demo write endpoints live in production (P1):** `POST /api/giniflow/demo/seed` and `/clean` are
  reachable on the live host. One fabricates clinical data against real patients, the other deletes a
  day. Admin-gated is not sufficient for a destructive endpoint with no confirmation step and no dry
  run.
- **No audit trail on budget changes (P2):** a single `updated_by` name string, overwritten each save.
  Time budgets determine what the hospital considers late; changes to them should be as auditable as
  the events they judge.
- **No rate limiting or date bounds (P3):** an unauthenticated attacker cannot reach it, but any
  authorised viewer can request arbitrary historical dates in a loop.

### Performance

- **Good:** the single lateral-join board query is the right call and the `(visit_date, current_status)`
  index covers it. Client-side ticking means one fetch per 10s regardless of floor size. One
  page-level interval, not one per card.
- **Five statements per poll (P2)**, including a round trip purely for the IST date. Compute the date
  in JS and pass the SLA config through rather than re-reading it in `getStationAverages`.
- **The visit-number subquery scans a patient's full history per card (P2)** — currently trivial
  because the table is new; it grows with the product, and it is computing a number that is wrong
  anyway (GF-05).
- **Re-render cost (P3):** the 1s tick re-renders the whole board tree, ~20 cards plus 8 columns plus
  10 footer tiles, every second, all day. Fine today; worth measuring on the actual wall display
  hardware rather than assuming.

---

## 17. Final verdict

**Needs improvement — close on the read path, blocked on the tooling.**

The Flow Manager does the hard thing well. An append-only log as the single source of truth, one
place that computes durations, one query for the board, a clean namespace separation that is asserted
rather than asserted-to, and IST-day handling applied everywhere. The plan is unusually honest about
its own state, which is why this review could be specific rather than exploratory.

What it does not yet do is survive contact with production. Three pieces of demo tooling can destroy
or fabricate live data, and they are harmless today only because the table they point at is empty — a
property that expires the moment check-in ships. Those are the four P0 items, and none is more than
an afternoon's work.

Below them sits a tier of defects that share a single cause: **the screen has never been looked at**.
Unloaded fonts, three permanently blank footer tiles, "Visit 1" on every card, a booked count that
will read 180 — every one of these is invisible from a passing API test and obvious within thirty
seconds of opening the page. Before another task starts, open `/giniflow/manager` next to the
prototype and work down what differs.

The strategic risk is the one the plan already names and has not yet closed: two boards showing
different data, with no agreed date or named person to end that. The build's own §1.13 says leaving
it undone produces the worst outcome. It is still undone.
